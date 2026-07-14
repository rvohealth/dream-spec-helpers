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
  probeSql: string
  cleanSteps: CleanStep[]
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
 * cached foreign-key dependency order with `DELETE FROM`, batched into one
 * round trip; a dirty member of a foreign-key cycle causes its whole cycle
 * group to be cleaned with one multi-table `TRUNCATE ... CASCADE`. For a spec
 * that wrote nothing, the entire call is a ~1ms no-op.
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

  const { rows } = await cache.client.query(cache.probeSql)
  const dirtyTables = new Set<string>(rows.map((row: any) => row.table_name))
  if (dirtyTables.size === 0) return

  const statements: string[] = []
  for (const step of cache.cleanSteps) {
    if (!step.tables.some((table) => dirtyTables.has(table))) continue

    if (step.kind === "delete") {
      statements.push(`DELETE FROM ${quoteIdentifier(step.tables[0])}`)
    } else {
      statements.push(
        `TRUNCATE TABLE ${step.tables.map(quoteIdentifier).join(", ")} CASCADE`,
      )
    }
  }

  await cache.client.query(statements.join(";\n"))
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
  // more than once); only the first error evicts, so a later error from this
  // client can never evict a replacement entry.
  let evicted = false
  client.on("error", (error: Error) => {
    console.error(
      `cleanTestDb: cached connection to database "${database}" errored (${error.message}); discarding it — the next cleanTestDb call will reconnect`,
      error,
    )
    if (!evicted) {
      evicted = true
      connectionCaches.delete(cacheKey)
    }
  })

  // the client stays open for the rest of the spec run; unref its socket so
  // it never keeps the vitest worker process alive once the suite finishes
  client.connection?.stream?.unref?.()

  const tables = await tableList(client)

  return {
    client,
    probeSql: buildProbeSql(tables),
    cleanSteps: buildCleanSteps(tables, await foreignKeyEdges(client)),
  }
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
