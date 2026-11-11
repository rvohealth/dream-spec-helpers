// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as pgImport from "pg"
import cleanTestDb from "../src/cleanTestDb.js"

// same CommonJS interop shim as src/cleanTestDb.ts
const pg: any = (pgImport as any).Client
  ? (pgImport as any)
  : (pgImport as any).default

// These specs need a Postgres server. They read its connection settings from
// the DB_* environment variables (CI sets them; locally the defaults reach a
// Postgres on localhost:5432 as your OS user), connect to DB_NAME (default
// "postgres") only to create and finally drop their own database, and touch
// no other database.
const server = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || undefined,
  password: process.env.DB_PASSWORD || undefined,
}
const MAINTENANCE_DATABASE = process.env.DB_NAME || "postgres"
const DATABASE = "dream_spec_helpers_clean_test_db_spec"

// a stand-in for @rvoh/dream's DreamApp: cleanTestDb reads only the
// connection's credentials from it
const DreamApp = {
  getOrFail: () => ({
    dbCredentials: { default: { primary: { ...server, name: DATABASE } } },
  }),
}

let admin: any
let db: any
let writers: any[] = []

async function connect(database: string) {
  const client = new pg.Client({ ...server, database })
  await client.connect()
  return client
}

// a second connection playing the part of app code (such as a request
// handler from the previous spec) that writes while cleanTestDb runs
async function writer() {
  const client = await connect(DATABASE)
  writers.push(client)
  return client
}

async function pidOf(client: any): Promise<number> {
  const { rows } = await client.query("SELECT pg_backend_pid() AS pid")
  return rows[0].pid
}

async function rowCounts() {
  const { rows } = await db.query(`
    SELECT
      (SELECT count(*) FROM parents)::int AS parents,
      (SELECT count(*) FROM children)::int AS children,
      (SELECT count(*) FROM cycle_a)::int AS cycle_a,
      (SELECT count(*) FROM cycle_b)::int AS cycle_b,
      (SELECT count(*) FROM kysely_migration)::int AS kysely_migration
  `)
  return rows[0]
}

type Outcome = { error: unknown }

// the eventual outcome of a call, observable without awaiting it
function track(promise: Promise<unknown>) {
  const state: { settled: boolean; outcome: Promise<Outcome> } = {
    settled: false,
    outcome: promise.then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    ),
  }
  void state.outcome.then(() => (state.settled = true))
  return state
}

// Resolves once the tracked call has either finished or is waiting for a
// lock held by one of `blockerPids`, whichever comes first. A spec that
// expects cleanTestDb to wait for a writer uses this instead of a sleep.
async function waitUntilBlockedOrSettled(
  call: ReturnType<typeof track>,
  blockerPids: number[],
): Promise<"blocked" | "settled"> {
  const giveUpAt = Date.now() + 5000
  while (Date.now() < giveUpAt) {
    if (call.settled) return "settled"
    const { rows } = await db.query(
      `
SELECT 1
FROM pg_stat_activity
WHERE datname = current_database()
AND pid <> pg_backend_pid()
AND pid <> ALL($1::int[])
AND pg_blocking_pids(pid) && $1::int[]
`,
      [blockerPids],
    )
    if (rows.length) return "blocked"
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("cleanTestDb neither finished nor waited for the writer")
}

beforeAll(async () => {
  admin = await connect(MAINTENANCE_DATABASE)
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${DATABASE}`)

  db = await connect(DATABASE)
  // cleanTestDb reads the schema on its first call, so every table must
  // exist before then. Foreign keys are ON DELETE RESTRICT, as Dream's
  // migrations generate them.
  await db.query(`
    CREATE TABLE kysely_migration (name text);
    CREATE TABLE parents (id serial PRIMARY KEY);
    CREATE TABLE children (
      id serial PRIMARY KEY,
      parent_id int NOT NULL REFERENCES parents (id) ON DELETE RESTRICT
    );
    CREATE TABLE cycle_a (id serial PRIMARY KEY, cycle_b_id int);
    CREATE TABLE cycle_b (
      id serial PRIMARY KEY,
      cycle_a_id int REFERENCES cycle_a (id) ON DELETE RESTRICT
    );
    ALTER TABLE cycle_a ADD FOREIGN KEY (cycle_b_id)
      REFERENCES cycle_b (id) ON DELETE RESTRICT;
  `)
})

beforeEach(async () => {
  await db.query("TRUNCATE parents, children, cycle_a, cycle_b CASCADE")
})

afterEach(async () => {
  for (const client of writers) await client.end()
  writers = []
})

afterAll(async () => {
  await db?.end()
  if (!admin) return

  // dropping the database ends cleanTestDb's cached connection, which logs
  // that it was discarded; keep that expected message out of the output
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
    await vi
      .waitFor(() => expect(consoleError).toHaveBeenCalled(), { timeout: 1000 })
      .catch(() => {})
  } finally {
    consoleError.mockRestore()
    await admin.end()
  }
})

describe("cleanTestDb", () => {
  it("empties every dirty table, a foreign-key cycle group included, and leaves kysely_migration alone", async () => {
    await db.query(`
      INSERT INTO kysely_migration VALUES ('20260101_create_parents');
      INSERT INTO parents (id) VALUES (1);
      INSERT INTO children (parent_id) VALUES (1);
      INSERT INTO cycle_a (id) VALUES (1);
      INSERT INTO cycle_b (id, cycle_a_id) VALUES (1, 1);
      UPDATE cycle_a SET cycle_b_id = 1;
    `)

    await cleanTestDb(DreamApp)

    expect(await rowCounts()).toEqual({
      parents: 0,
      children: 0,
      cycle_a: 0,
      cycle_b: 0,
      kysely_migration: 1,
    })
  })

  it("returns false and deletes nothing when NODE_ENV is not test", async () => {
    await db.query("INSERT INTO parents (id) VALUES (1)")
    const nodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "development"
    try {
      expect(await cleanTestDb(DreamApp)).toBe(false)
    } finally {
      process.env.NODE_ENV = nodeEnv
    }
    expect((await rowCounts()).parents).toBe(1)
  })

  it("does not fail with a foreign-key error when a writer commits a child row after the clean has begun, and leaves no row behind", async () => {
    await db.query("INSERT INTO parents (id) VALUES (1)")
    const handler = await writer()
    await handler.query("BEGIN; INSERT INTO children (parent_id) VALUES (1)")

    const cleaning = track(cleanTestDb(DreamApp))
    expect(
      await waitUntilBlockedOrSettled(cleaning, [await pidOf(handler)]),
    ).toBe("blocked")
    await handler.query("COMMIT")

    const { error } = await cleaning.outcome
    expect(error).toBeUndefined()
    expect(await rowCounts()).toMatchObject({ parents: 0, children: 0 })
  })

  it("waits for a write in progress and then removes its rows", async () => {
    const handler = await writer()
    await handler.query("BEGIN; INSERT INTO parents (id) VALUES (1)")

    const cleaning = track(cleanTestDb(DreamApp))
    expect(
      await waitUntilBlockedOrSettled(cleaning, [await pidOf(handler)]),
    ).toBe("blocked")
    await handler.query("COMMIT")

    const { error } = await cleaning.outcome
    expect(error).toBeUndefined()
    expect((await rowCounts()).parents).toBe(0)
  })

  it("fails within its time limit, naming the table and the connection, when another connection keeps a write transaction open; a concurrent call on the same connection fails the same way; the next call works", async () => {
    const forgotten = await writer()
    const forgottenPid = await pidOf(forgotten)
    await forgotten.query("BEGIN; INSERT INTO parents (id) VALUES (1)")

    const startedAt = Date.now()
    const [first, second] = await Promise.allSettled([
      cleanTestDb(DreamApp),
      cleanTestDb(DreamApp),
    ])
    const elapsed = Date.now() - startedAt

    // bounded below Vitest's default 10s hook timeout, so the spec fails
    // with this error rather than a bare hook timeout
    expect(elapsed).toBeLessThan(10_000)
    expect(elapsed).toBeGreaterThanOrEqual(4_000)

    expect(first.status).toBe("rejected")
    const firstMessage = (first as PromiseRejectedResult).reason.message
    expect(firstMessage).toContain(`database "${DATABASE}" within 5000ms`)
    expect(firstMessage).toContain(
      `table "parents" is locked (RowExclusiveLock) by the connection with pid ${forgottenPid} (state: idle in transaction`,
    )

    // the concurrent call waited its turn on the shared connection instead
    // of interleaving its statements with the first call's transaction
    expect(second.status).toBe("rejected")
    expect((second as PromiseRejectedResult).reason.message).toContain(
      `cleanTestDb could not clean database "${DATABASE}" within 5000ms`,
    )

    // the cached connection is not left inside the failed transaction
    await forgotten.query("ROLLBACK")
    await db.query("INSERT INTO parents (id) VALUES (2)")
    await cleanTestDb(DreamApp)
    expect((await rowCounts()).parents).toBe(0)
  }, 15_000)

  it("starts over when Postgres breaks a deadlock with a writer by aborting the clean", async () => {
    await db.query("INSERT INTO parents (id) VALUES (1)")
    const handler = await writer()
    const handlerPid = await pidOf(handler)
    // holds the write lock on children...
    await handler.query("BEGIN; INSERT INTO children (parent_id) VALUES (1)")

    // ...so the clean, which locks parents before children, waits on it
    const cleaning = track(cleanTestDb(DreamApp))
    expect(await waitUntilBlockedOrSettled(cleaning, [handlerPid])).toBe(
      "blocked",
    )

    // the writer now needs parents, which the clean holds: a deadlock. Each
    // side checks for a deadlock once it has waited deadlock_timeout (1s by
    // default); the clean started waiting first, so it detects the deadlock
    // first and Postgres aborts it, releasing its locks to the writer.
    await new Promise((resolve) => setTimeout(resolve, 300))
    await handler.query("INSERT INTO parents (id) VALUES (2)")
    expect(cleaning.settled).toBe(false)
    await handler.query("COMMIT")

    const { error } = await cleaning.outcome
    expect(error).toBeUndefined()
    expect(await rowCounts()).toMatchObject({ parents: 0, children: 0 })
  })

  it("stays a ~1ms no-op when nothing is dirty", async () => {
    await cleanTestDb(DreamApp) // warm up the cached connection

    const calls = 50
    const startedAt = performance.now()
    for (let i = 0; i < calls; i++) await cleanTestDb(DreamApp)
    const averageMs = (performance.now() - startedAt) / calls

    // generous for a shared CI runner; locally this is well under 1ms
    expect(averageMs).toBeLessThan(5)
  })
})
