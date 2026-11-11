// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as pgImport from "pg"

// interop shim: pg is a CommonJS module, and this file compiles to both ESM
// and CJS. In the ESM build the module arrives as the namespace's `default`;
// in the CJS build the namespace IS the module (no esModuleInterop here, so a
// plain default import would compile to a broken `.default` access in CJS).
const pg: any = (pgImport as any).Client
  ? (pgImport as any)
  : (pgImport as any).default

const EXCLUDED_TABLES = ["kysely_migration", "kysely_migration_lock"]

// The clean stops waiting this many milliseconds after the call starts. The
// limit covers waiting only: for an earlier clean on the same cached
// connection, for locks other connections hold (table locks and row locks),
// and for deadlock retries. The work itself (deleting, truncating, the
// tables' triggers, and deferred constraint triggers, which run at COMMIT) is
// not limited, so a large clean takes as long as it needs, as it did before
// the clean took locks. The limit sits well below Vitest's default 10s hook
// timeout, so a connection that holds a transaction open fails the spec with
// an error naming that connection rather than a bare hook timeout.
const CLEAN_TIME_LIMIT_MS = 5000

// When Postgres breaks a deadlock between the clean and another connection by
// aborting the clean, the clean starts over, up to this many attempts in all
// (each deadlock costs Postgres' `deadlock_timeout`, 1s by default, to detect)
const MAX_CLEAN_ATTEMPTS = 3

// the table lock modes another connection can hold that make the up-front
// `SHARE ROW EXCLUSIVE` lock wait (INSERT/UPDATE/DELETE take ROW EXCLUSIVE;
// plain reads and `SELECT ... FOR UPDATE/SHARE` do not conflict)
const MODES_BLOCKING_SHARE_ROW_EXCLUSIVE = [
  "RowExclusiveLock",
  "ShareUpdateExclusiveLock",
  "ShareLock",
  "ShareRowExclusiveLock",
  "ExclusiveLock",
  "AccessExclusiveLock",
]

// A single step of the cleaning plan, in children-first order:
// - "delete": one acyclic table, cleaned with `DELETE FROM` when dirty
// - "truncateGroup": all members of a foreign-key cycle, cleaned together with
//   one multi-table `TRUNCATE ... CASCADE` when ANY member is dirty (a cyclic
//   table can never be safely `DELETE`d on its own, and must never be skipped)
interface CleanStep {
  kind: "delete" | "truncateGroup"
  tables: string[]
}

interface ConnectionCache {
  client: any
  database: string
  tables: string[]
  // the tables the up-front LOCK covers: those the database user may clean
  lockedTables: string[]
  lockSql: string
  probeSql: string
  cleanSteps: CleanStep[]
  // settles when the last clean queued on this client has finished; a clean
  // spans several round trips of one transaction, so cleans sharing the
  // client must run one after another, never interleaved
  queueTail: Promise<void>
  // evicts this entry from the cache and closes its client, so the next call
  // reconnects (used when the client may be stuck inside a transaction)
  discard: () => void
}

// Persistent client + cleaning plan per (connection name, resolved database).
// The schema cannot change mid-spec-run, so this is never invalidated. Storing
// the in-flight promise (not the resolved value) makes concurrent first calls
// for the same connection share one build instead of corrupting each other.
const connectionCaches = new Map<string, Promise<ConnectionCache>>()

/**
 * Removes all rows from the application's tables so that each spec starts
 * from an empty database (`kysely_migration` and `kysely_migration_lock` are
 * left alone; sequences are not reset).
 *
 * Rather than truncating every table on every call, `cleanTestDb` first
 * probes which tables actually contain rows — a single statement of per-table
 * `EXISTS` checks on a persistent connection, which is close to free — and
 * cleans exactly those. Dirty tables are removed children-first along the
 * cached foreign-key dependency order with `DELETE FROM`; a dirty member of a
 * foreign-key cycle causes its whole cycle group to be cleaned with one
 * multi-table `TRUNCATE ... CASCADE`. For a spec that wrote nothing, the
 * entire call is a ~1ms no-op.
 *
 * Like a full truncate, the clean waits for writes already in progress on
 * other connections (for example, server work from the previous spec that is
 * still running): it first locks every table the database user may write
 * against writes (`LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE`; reads are not
 * blocked), then probes and cleans in that same transaction, so a row
 * committed mid-clean can neither break a foreign key nor be left behind.
 * Writes that arrive during the clean wait for it to finish.
 *
 * Waiting is limited to 5 seconds from the start of the call, below Vitest's
 * default 10 second hook timeout: if another connection still holds a lock
 * the clean needs by then (for example, a transaction a spec never committed
 * keeps a table locked against the clean's write lock, or keeps a row locked
 * that the clean deletes), it throws an error naming the table and the
 * blocking connection. If Postgres breaks a deadlock with another connection
 * by aborting the clean, the clean is retried, a few times at most, within
 * the same 5 seconds. Only waiting is limited: the deletes themselves, the
 * tables' triggers, and deferred constraint triggers (which run at COMMIT)
 * take as long as they need, and can take a clean past 5 seconds, or past the
 * hook timeout, without any error from `cleanTestDb`.
 *
 * The connection, table list, and dependency order are cached per
 * (connectionName, resolved database) for the life of the spec worker; the
 * cached connection is unref'd so it never keeps the worker process alive
 * after the suite finishes.
 *
 * Only runs when `NODE_ENV === 'test'`; returns `false` otherwise.
 *
 * @param DreamApp - the DreamApp class from `@rvoh/dream`
 * @param connectionName - the configured database connection to clean (defaults to `"default"`)
 */
export default async function cleanTestDb(
  DreamApp: any,
  connectionName: string = "default",
) {
  // this was only ever written to clear the db between tests,
  // so there is no way to clean the database in dev/prod
  if (process.env.NODE_ENV !== "test") return false

  const dreamconf = DreamApp.getOrFail()

  // prior to @rvoh/dream@1.5.0, dbCredentials would point to the app's
  // root db credentials. After 1.5.0, this has been switched to be a record
  // with keys that are connection names, and values that point to db credentials.
  // To maintain backwards compatibility with older versions of dream, we will check
  // for the 'default' key, and if it exists, we will use the connectionName to
  // drill in, and otherwise fall back, since we must be in an older version of dream.
  const credentials =
    dreamconf.dbCredentials[connectionName]?.primary ||
    dreamconf.dbCredentials.primary

  if (!credentials)
    throw new Error(
      `Failed to locate db credentials for connectionName: ${connectionName}`,
    )

  const database = await resolveDatabaseName(
    dreamconf,
    connectionName,
    credentials.name,
  )

  const cache = await connectionCache(connectionName, database, credentials)
  if (!cache.probeSql) return // empty schema: nothing to clean

  const deadline = Date.now() + CLEAN_TIME_LIMIT_MS
  await runAlone(cache, deadline, () => cleanWithRetries(cache, deadline))
}

// Runs `task` once every clean queued earlier on this cache's client has
// finished. Waiting for them counts against this clean's deadline.
async function runAlone(
  cache: ConnectionCache,
  deadline: number,
  task: () => Promise<void>,
): Promise<void> {
  const previous = cache.queueTail
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  // a later clean waits for `previous` as well as this one, so it can never
  // overlap `previous` even if this clean gives up waiting early
  cache.queueTail = previous.then(() => finished)

  try {
    await settledBefore(previous, deadline, cache)
    await task()
  } finally {
    finish()
  }
}

function settledBefore(
  previous: Promise<void>,
  deadline: number,
  cache: ConnectionCache,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `cleanTestDb could not clean database "${cache.database}" within ${CLEAN_TIME_LIMIT_MS}ms: it was still waiting for an earlier cleanTestDb call on the same connection to finish. Await each cleanTestDb call before starting another one for the same connection.`,
          ),
        ),
      Math.max(0, deadline - Date.now()),
    )
  })
  return Promise.race([previous, timedOut]).finally(() => clearTimeout(timer))
}

// what the clean was doing when it failed, for the error message
interface CleanProgress {
  // "lock": taking the up-front write locks (blocked by writers)
  // "clean": deleting/truncating dirty tables (blocked by row locks, and
  //          for TRUNCATE by any open transaction that touched the table or
  //          a table the TRUNCATE cascades to)
  stage: "lock" | "clean"
  // the tables to search for the lock holders that blocked it
  tables: string[]
}

async function cleanWithRetries(
  cache: ConnectionCache,
  deadline: number,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const progress: CleanProgress = {
      stage: "lock",
      tables: cache.lockedTables,
    }
    try {
      await cleanOnce(cache, deadline, progress)
      return
    } catch (error) {
      await rollback(cache)

      if (
        isDeadlock(error) &&
        attempt < MAX_CLEAN_ATTEMPTS &&
        Date.now() < deadline
      )
        continue

      throw await describeFailure(cache, error, attempt, progress, deadline)
    }
  }
}

// One transaction: lock every table the database user may clean against
// writes, then probe and clean. Once the lock is held, no other connection can
// insert, update or delete in these tables until COMMIT, so the probe is
// authoritative: every row already committed is seen, and no row can be
// committed between probe and clean. (A table the user may not write is not
// locked; if it has rows, cleaning it fails, as it did before the clean took
// locks.)
async function cleanOnce(
  cache: ConnectionCache,
  deadline: number,
  progress: CleanProgress,
): Promise<void> {
  const client = cache.client

  // LOCK TABLE only waits, so `statement_timeout` limits its waits as a whole
  // (`lock_timeout` would limit each table's wait separately). Postgres times
  // each statement of a multi-statement query separately, so resetting the
  // timeout after the LOCK leaves the probe, and the rest of the transaction,
  // under the session's own statement_timeout, as they were before the clean
  // took locks.
  await client.query(`BEGIN; ${statementTimeoutUntil(deadline)}`)
  const lockAndProbe = await client.query(
    [cache.lockSql, "SET LOCAL statement_timeout TO DEFAULT", cache.probeSql]
      .filter(Boolean)
      .join(";\n"),
  )
  const { rows } = lockAndProbe[lockAndProbe.length - 1]
  const dirtyTables = new Set<string>(rows.map((row: any) => row.table_name))

  if (dirtyTables.size === 0) {
    await client.query("COMMIT")
    return
  }

  const dirtySteps = cache.cleanSteps.filter((step) =>
    step.tables.some((table) => dirtyTables.has(table)),
  )
  progress.stage = "clean"
  // every table, not just the dirty ones: a cycle group's TRUNCATE ... CASCADE
  // also needs the tables that reference the group, directly or not. The
  // clean holds a write lock on every table it may clean, so a holder found on
  // any of those is a transaction that is still open.
  progress.tables = cache.tables

  await client.query(`${cleanBlockSql(dirtySteps, deadline)};\nCOMMIT`)
}

// Limits the up-front LOCK to the time left; SET LOCAL reverts when the
// transaction ends
function statementTimeoutUntil(deadline: number): string {
  const remaining = deadline - Date.now()
  if (remaining < 1) throw new DeadlineReached()
  return `SET LOCAL statement_timeout = ${Math.ceil(remaining)}`
}

class DeadlineReached extends Error {}

// The clean's statements, as one DO block (a single round trip). Deleting and
// truncating are work, which is not limited; only their lock waits are (for
// rows another connection has locked, and for the cycle-group TRUNCATE's
// ACCESS EXCLUSIVE lock). `lock_timeout` cuts off each wait without limiting
// work, but applies to each wait separately, so it is set to the time left
// before every statement. A statement that waits more than once (for rows
// locked by several transactions in turn) gives each wait the time left when
// the statement began, so it can still wait past the deadline. The last value
// set also applies to lock waits in deferred constraint triggers at COMMIT.
function cleanBlockSql(steps: CleanStep[], deadline: number): string {
  const timeLeftMs = Math.max(1, Math.ceil(deadline - Date.now()))
  // lock_timeout = 0 would mean no limit, hence the floor of 1ms
  const limitLockWaits = `PERFORM set_config('lock_timeout', greatest(1, ceil(1000 * extract(epoch FROM waits_end - clock_timestamp())))::bigint::text, true);`
  const statements = steps.map((step) =>
    step.kind === "delete"
      ? `DELETE FROM ${quoteIdentifier(step.tables[0])};`
      : `TRUNCATE TABLE ${step.tables.map(quoteIdentifier).join(", ")} CASCADE;`,
  )
  const body = [
    "DECLARE",
    `waits_end CONSTANT timestamptz := clock_timestamp() + interval '${timeLeftMs} milliseconds';`,
    "BEGIN",
    ...statements.flatMap((statement) => [limitLockWaits, statement]),
    "END",
  ].join("\n")

  // a dollar-quote tag that cannot occur in the (quoted) table names
  let tag = "$clean$"
  for (let n = 1; body.includes(tag); n++) tag = `$clean${n}$`

  return `DO ${tag}\n${body}\n${tag}`
}

async function rollback(cache: ConnectionCache): Promise<void> {
  try {
    await cache.client.query("ROLLBACK")
  } catch {
    // the client may still be inside the failed transaction, which would
    // break every later clean on it; replace it instead
    cache.discard()
  }
}

function isDeadlock(error: any): boolean {
  return error?.code === "40P01"
}

function isTimeout(
  error: any,
  deadline: number,
  progress: CleanProgress,
): boolean {
  return (
    error instanceof DeadlineReached ||
    // query_canceled: our statement_timeout on the up-front LOCK, which fires
    // at or after the deadline (a cancel requested by hand before then is not
    // a timeout, and in the clean stage the statement_timeout is the session's
    // own, not ours)
    (error?.code === "57014" &&
      progress.stage === "lock" &&
      Date.now() >= deadline) ||
    // lock_not_available: our lock_timeout in the clean stage, or a
    // lock_timeout configured for the database or role
    error?.code === "55P03"
  )
}

async function describeFailure(
  cache: ConnectionCache,
  error: any,
  attempts: number,
  progress: CleanProgress,
  deadline: number,
): Promise<unknown> {
  if (isDeadlock(error)) {
    const reason =
      attempts < MAX_CLEAN_ATTEMPTS
        ? `deadlocked with another connection and ran out of time to retry`
        : `deadlocked with another connection ${attempts} times in a row`
    return new Error(
      `cleanTestDb could not clean database "${cache.database}": it ${reason} (each time, Postgres broke the deadlock by aborting the clean). Postgres reported: ${error.message}${error.detail ? ` ${error.detail}` : ""} A connection that is still writing to several tables (often server work from the previous spec that is still running) can deadlock with the clean.`,
      { cause: error },
    )
  }

  if (!isTimeout(error, deadline, progress)) return error

  const blockers = await lockHolders(cache, progress)
  const waitingFor =
    progress.stage === "lock"
      ? "to lock its tables against writes"
      : "to clean its dirty tables"
  const heldBy = blockers.length
    ? `another connection still holds a conflicting lock: ${blockers.join("; ")}.`
    : `no other connection still holds a conflicting lock on those tables, so whatever blocked it finished just after the limit.`

  return new Error(
    `cleanTestDb could not clean database "${cache.database}" within ${CLEAN_TIME_LIMIT_MS}ms: it was waiting ${waitingFor}, and ${heldBy} cleanTestDb waits for writes in progress so that every table is empty at the start of each spec; a connection that keeps a transaction open (often server work from the previous spec that is still running, or a transaction a spec never committed or rolled back) blocks it. Commit or roll back that transaction, or close the connection. A transaction that waits for a write on another connection cannot finish while the clean waits, because that write waits for the clean.`,
    { cause: error },
  )
}

// other connections holding a granted lock on the tables the clean was waiting
// for, in a mode that conflicts with what the clean needed at that stage (in
// the clean stage, any mode: row locks and TRUNCATE's ACCESS EXCLUSIVE lock
// conflict with them all)
async function lockHolders(
  cache: ConnectionCache,
  progress: CleanProgress,
): Promise<string[]> {
  try {
    const { rows } = await cache.client.query(
      `
SELECT c.relname AS table_name, l.mode, a.pid, a.state, a.application_name, a.query
FROM pg_locks l
JOIN pg_class c ON c.oid = l.relation
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'relation'
AND l.granted
AND l.pid <> pg_backend_pid()
AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
AND c.relnamespace = 'public'::regnamespace
AND c.relname = ANY($1::text[])
AND ($2::text[] IS NULL OR l.mode = ANY($2::text[]))
ORDER BY c.relname, a.pid, l.mode
`,
      [
        progress.tables,
        progress.stage === "lock" ? MODES_BLOCKING_SHARE_ROW_EXCLUSIVE : null,
      ],
    )
    return rows.map(
      (row: any) =>
        `table "${row.table_name}" is locked (${row.mode}) by the connection with pid ${row.pid} (state: ${row.state ?? "unknown"}${row.application_name ? `, application_name: "${row.application_name}"` : ""}${row.query ? `, last query: ${JSON.stringify(shorten(row.query, 200))}` : ""})`,
    )
  } catch {
    // the error being described matters more than this diagnosis
    return []
  }
}

function shorten(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

function connectionCache(
  connectionName: string,
  database: string,
  credentials: any,
): Promise<ConnectionCache> {
  const cacheKey = `${connectionName}:${database}`

  const existing = connectionCaches.get(cacheKey)
  if (existing) return existing

  const building = buildConnectionCache(cacheKey, database, credentials)
  connectionCaches.set(cacheKey, building)
  // if the build fails (e.g., transient connection error), allow a retry on
  // the next call instead of caching the rejection forever
  building.catch(() => connectionCaches.delete(cacheKey))
  return building
}

async function buildConnectionCache(
  cacheKey: string,
  database: string,
  credentials: any,
): Promise<ConnectionCache> {
  const client = new pg.Client({
    host: credentials.host || "localhost",
    port: credentials.port,
    database,
    user: credentials.user,
    password: credentials.password,
  })
  await client.connect()

  // a pg.Client with no 'error' listener turns a dropped connection (e.g.,
  // the test Postgres restarting mid-suite) into an uncaughtException that
  // kills the vitest worker with a raw pg stack. Log comprehensibly and evict
  // this cache entry so the next cleanTestDb call reconnects. The listener
  // stays attached for the client's lifetime (a dead client may emit 'error'
  // more than once); only the first eviction deletes the entry, so a later
  // error from this client can never evict a replacement entry.
  let evicted = false
  const evict = () => {
    if (evicted) return
    evicted = true
    connectionCaches.delete(cacheKey)
  }
  client.on("error", (error: Error) => {
    console.error(
      `cleanTestDb: cached connection to database "${database}" errored (${error.message}); discarding it — the next cleanTestDb call will reconnect`,
      error,
    )
    evict()
  })

  // the client stays open for the rest of the spec run; unref its socket so
  // it never keeps the vitest worker process alive once the suite finishes
  client.connection?.stream?.unref?.()

  const tables = await tableList(client)
  const cleanSteps = buildCleanSteps(tables, await foreignKeyEdges(client))
  const lockedTables = lockOrder(cleanSteps, await cleanableTables(client))

  return {
    client,
    database,
    tables,
    lockedTables,
    lockSql: buildLockSql(lockedTables),
    probeSql: buildProbeSql(tables),
    cleanSteps,
    queueTail: Promise.resolve(),
    discard: () => {
      evict()
      client.end().catch(() => {})
    },
  }
}

// The tables to lock, parents first (the reverse of the children-first clean
// order). A writer usually inserts a parent row before its children, so
// taking the parent first makes the clean wait for such a writer to finish
// rather than deadlock with it.
function lockOrder(cleanSteps: CleanStep[], cleanable: Set<string>): string[] {
  return cleanSteps
    .slice()
    .reverse()
    .flatMap((step) => step.tables)
    .filter((table) => cleanable.has(table))
}

function buildLockSql(tables: string[]): string {
  if (!tables.length) return ""
  return `LOCK TABLE ${tables.map(quoteIdentifier).join(", ")} IN SHARE ROW EXCLUSIVE MODE`
}

// The public tables the database user may clean. `LOCK TABLE ... IN SHARE ROW
// EXCLUSIVE MODE` needs UPDATE, DELETE or TRUNCATE privilege (owners and
// superusers have them all), so locking a table the user may only read would
// fail every clean, even with that table empty. Such a table cannot be
// cleaned anyway: once it has rows, the DELETE or TRUNCATE fails, as it did
// before the clean took locks.
async function cleanableTables(client: any): Promise<Set<string>> {
  const { rows } = await client.query(
    `
SELECT relname AS table_name
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
AND relkind IN ('r', 'p')
AND has_table_privilege(oid, 'UPDATE, DELETE, TRUNCATE')
`,
  )
  return new Set(rows.map((row: any) => row.table_name))
}

async function tableList(client: any): Promise<string[]> {
  const { rows } = await client.query(
    `
SELECT table_name
FROM information_schema.tables
WHERE table_type='BASE TABLE'
AND table_schema='public'
AND table_name NOT IN (${EXCLUDED_TABLES.map((table) => `'${table}'`).join(", ")})
ORDER BY table_name
`,
  )
  return rows.map((row: any) => row.table_name)
}

interface ForeignKeyEdge {
  childTable: string
  parentTable: string
}

// foreign-key edges (referencing child -> referenced parent) between public
// tables. Self-referential foreign keys are excluded: NO ACTION constraints
// are checked at end of statement, so a single-statement `DELETE FROM t` is
// always safe on a self-referencing table.
async function foreignKeyEdges(client: any): Promise<ForeignKeyEdge[]> {
  const { rows } = await client.query(
    `
SELECT child.relname AS child_table, parent.relname AS parent_table
FROM pg_constraint con
JOIN pg_class child ON child.oid = con.conrelid
JOIN pg_class parent ON parent.oid = con.confrelid
WHERE con.contype = 'f'
AND child.relnamespace = 'public'::regnamespace
AND parent.relnamespace = 'public'::regnamespace
AND child.relname <> parent.relname
`,
  )
  return rows.map((row: any) => ({
    childTable: row.child_table,
    parentTable: row.parent_table,
  }))
}

// one statement returning the name of every table that currently contains at
// least one row; probing empty tables via EXISTS is close to free
function buildProbeSql(tables: string[]): string {
  return tables
    .map(
      (table) =>
        `SELECT '${table.replace(/'/g, "''")}' AS table_name WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(table)})`,
    )
    .join(" UNION ALL ")
}

// Builds the cleaning plan: strongly-connected components of the foreign-key
// graph (cycle groups), ordered children-first so that by the time a table is
// cleaned, every table referencing it has already been cleaned.
function buildCleanSteps(
  tables: string[],
  edges: ForeignKeyEdge[],
): CleanStep[] {
  const tableSet = new Set(tables)
  const knownEdges = edges.filter(
    (edge) => tableSet.has(edge.childTable) && tableSet.has(edge.parentTable),
  )

  const components = stronglyConnectedComponents(tables, knownEdges)

  return childrenFirstComponentOrder(components, knownEdges).map(
    (component) => ({
      kind: component.length === 1 ? "delete" : "truncateGroup",
      tables: component,
    }),
  )
}

// Tarjan's algorithm; components of size > 1 are foreign-key cycles
function stronglyConnectedComponents(
  tables: string[],
  edges: ForeignKeyEdge[],
): string[][] {
  const adjacency = new Map<string, string[]>(
    tables.map((table) => [table, []]),
  )
  for (const edge of edges)
    adjacency.get(edge.childTable)!.push(edge.parentTable)

  const indexOf = new Map<string, number>()
  const lowlinkOf = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let nextIndex = 0

  function strongConnect(table: string) {
    indexOf.set(table, nextIndex)
    lowlinkOf.set(table, nextIndex)
    nextIndex += 1
    stack.push(table)
    onStack.add(table)

    for (const neighbor of adjacency.get(table)!) {
      if (!indexOf.has(neighbor)) {
        strongConnect(neighbor)
        lowlinkOf.set(
          table,
          Math.min(lowlinkOf.get(table)!, lowlinkOf.get(neighbor)!),
        )
      } else if (onStack.has(neighbor)) {
        lowlinkOf.set(
          table,
          Math.min(lowlinkOf.get(table)!, indexOf.get(neighbor)!),
        )
      }
    }

    if (lowlinkOf.get(table) === indexOf.get(table)) {
      const component: string[] = []
      let member: string
      do {
        member = stack.pop()!
        onStack.delete(member)
        component.push(member)
      } while (member !== table)
      components.push(component)
    }
  }

  for (const table of tables) {
    if (!indexOf.has(table)) strongConnect(table)
  }

  return components
}

// Kahn's algorithm over the component graph (a DAG by construction): a
// component is emitted only once every component referencing it has been
// emitted, i.e. children before parents
function childrenFirstComponentOrder(
  components: string[][],
  edges: ForeignKeyEdge[],
): string[][] {
  const componentIndexOf = new Map<string, number>()
  components.forEach((component, index) => {
    for (const table of component) componentIndexOf.set(table, index)
  })

  const pendingChildEdges = components.map(() => 0)
  const parentComponentsOf: number[][] = components.map(() => [])
  for (const edge of edges) {
    const childComponent = componentIndexOf.get(edge.childTable)!
    const parentComponent = componentIndexOf.get(edge.parentTable)!
    if (childComponent === parentComponent) continue
    pendingChildEdges[parentComponent] += 1
    parentComponentsOf[childComponent].push(parentComponent)
  }

  const queue: number[] = []
  components.forEach((_, index) => {
    if (pendingChildEdges[index] === 0) queue.push(index)
  })

  const order: number[] = []
  while (queue.length) {
    const componentIndex = queue.shift()!
    order.push(componentIndex)
    for (const parentComponent of parentComponentsOf[componentIndex]) {
      pendingChildEdges[parentComponent] -= 1
      if (pendingChildEdges[parentComponent] === 0) queue.push(parentComponent)
    }
  }

  return order.map((componentIndex) => components[componentIndex])
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

// Resolve the database `cleanTestDb` should connect to. As of @rvoh/dream's
// per-live-worker test-database pool, the worker claims a database via a
// Postgres advisory lock and `dreamconf.testDatabaseName` is the single source
// of truth for the claimed name — `cleanTestDb` opens its own `pg.Client`, so
// it must read (and, if needed, trigger) that claim rather than recomputing a
// name from VITEST_POOL_ID, which is a reusable slot id that overlapping
// workers share. Older dream versions lack `testDatabaseName`; for those we
// fall back to the legacy VITEST_POOL_ID-based name.
async function resolveDatabaseName(
  dreamconf: any,
  connectionName: string,
  dbName: string,
): Promise<string> {
  if (typeof dreamconf.testDatabaseName === "function") {
    return await dreamconf.testDatabaseName(connectionName, "primary")
  }
  return legacyDatabaseName(dreamconf, dbName)
}

function legacyDatabaseName(dreamconf: any, dbName: string): string {
  return parallelDatabasesEnabled(dreamconf)
    ? `${dbName}_${process.env.VITEST_POOL_ID}`
    : dbName
}

function parallelDatabasesEnabled(dreamconf: any): boolean {
  return (
    !!dreamconf.parallelTests &&
    !Number.isNaN(Number(process.env.VITEST_POOL_ID)) &&
    Number(process.env.VITEST_POOL_ID) > 1
  )
}
