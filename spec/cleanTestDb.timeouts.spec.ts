// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as pgImport from "pg"
import cleanTestDb from "../src/cleanTestDb.js"

// same CommonJS interop shim as src/cleanTestDb.ts
const pg: any = (pgImport as any).Client
  ? (pgImport as any)
  : (pgImport as any).default

// cleanTestDb's 5 second limit bounds only the time it spends waiting for
// other connections, never the cleaning work itself. These specs take several
// seconds each, because they have to outlast that limit.
//
// Like spec/cleanTestDb.spec.ts, they read the Postgres connection settings
// from the DB_* environment variables, connect to DB_NAME (default
// "postgres") only to create and finally drop their own database, and touch
// no other database.
const server = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || undefined,
  password: process.env.DB_PASSWORD || undefined,
}
const MAINTENANCE_DATABASE = process.env.DB_NAME || "postgres"
const DATABASE = "dream_spec_helpers_clean_test_db_timeouts_spec"

// how long the slow triggers below take: longer than cleanTestDb's limit
const SLOWER_THAN_THE_LIMIT_SECONDS = 5.5

const DreamApp = {
  getOrFail: () => ({
    dbCredentials: { default: { primary: { ...server, name: DATABASE } } },
  }),
}

let admin: any
let db: any
let others: any[] = []

async function connect(database: string) {
  const client = new pg.Client({ ...server, database })
  await client.connect()
  return client
}

// another connection, such as app code from the previous spec
async function otherConnection() {
  const client = await connect(DATABASE)
  others.push(client)
  return client
}

async function pidOf(client: any): Promise<number> {
  const { rows } = await client.query("SELECT pg_backend_pid() AS pid")
  return rows[0].pid
}

async function rowCount(table: string): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS count FROM ${table}`)
  return rows[0].count
}

async function timed(promise: Promise<unknown>) {
  const startedAt = Date.now()
  try {
    await promise
    return { error: undefined, elapsed: Date.now() - startedAt }
  } catch (error) {
    return { error: error as Error, elapsed: Date.now() - startedAt }
  }
}

beforeAll(async () => {
  admin = await connect(MAINTENANCE_DATABASE)
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${DATABASE}`)

  db = await connect(DATABASE)
  // cleanTestDb reads the schema on its first call, so every table must
  // exist before then
  await db.query(`
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
    -- outside the cycle, but TRUNCATE ... CASCADE of the cycle group
    -- truncates it too
    CREATE TABLE leaf (
      id serial PRIMARY KEY,
      cycle_a_id int REFERENCES cycle_a (id) ON DELETE RESTRICT
    );

    CREATE FUNCTION take_longer_than_the_limit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(${SLOWER_THAN_THE_LIMIT_SECONDS});
        RETURN NULL;
      END
      $$;

    -- deleting from this table is slow work, not a wait for a lock
    CREATE TABLE slow_to_delete (id serial PRIMARY KEY);
    CREATE TRIGGER slow_delete BEFORE DELETE ON slow_to_delete
      FOR EACH STATEMENT EXECUTE FUNCTION take_longer_than_the_limit();

    -- the slow work on this table runs at COMMIT
    CREATE TABLE slow_to_commit (id serial PRIMARY KEY);
    CREATE CONSTRAINT TRIGGER slow_commit AFTER DELETE ON slow_to_commit
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION take_longer_than_the_limit();
  `)
})

beforeEach(async () => {
  // TRUNCATE fires no DELETE triggers
  await db.query(
    "TRUNCATE parents, children, cycle_a, cycle_b, leaf, slow_to_delete, slow_to_commit CASCADE",
  )
})

afterEach(async () => {
  for (const client of others) await client.end()
  others = []
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

describe("cleanTestDb's time limit", () => {
  it("does not limit the delete work: a clean that takes longer than 5 seconds to delete, with nothing blocking it, finishes and empties the table", async () => {
    await db.query("INSERT INTO slow_to_delete DEFAULT VALUES")

    const { error, elapsed } = await timed(cleanTestDb(DreamApp))

    expect(error).toBeUndefined()
    expect(elapsed).toBeGreaterThanOrEqual(5_000)
    expect(await rowCount("slow_to_delete")).toBe(0)
  }, 15_000)

  it("does not limit deferred constraint triggers, which run at COMMIT", async () => {
    await db.query("INSERT INTO slow_to_commit DEFAULT VALUES")

    const { error, elapsed } = await timed(cleanTestDb(DreamApp))

    expect(error).toBeUndefined()
    expect(elapsed).toBeGreaterThanOrEqual(5_000)
    expect(await rowCount("slow_to_commit")).toBe(0)
  }, 15_000)

  it("limits a wait for a row another connection has locked, and names the table and the connection", async () => {
    await db.query("INSERT INTO parents (id) VALUES (1)")
    // SELECT ... FOR UPDATE does not block the up-front table lock, so the
    // clean waits for the row when it deletes it
    const holder = await otherConnection()
    const holderPid = await pidOf(holder)
    await holder.query("BEGIN; SELECT * FROM parents FOR UPDATE")

    const { error, elapsed } = await timed(cleanTestDb(DreamApp))

    expect(elapsed).toBeGreaterThanOrEqual(4_000)
    expect(elapsed).toBeLessThan(10_000)
    expect(error?.message).toContain(
      `cleanTestDb could not clean database "${DATABASE}" within 5000ms: it was waiting to clean its dirty tables`,
    )
    expect(error?.message).toContain(
      `table "parents" is locked (RowShareLock) by the connection with pid ${holderPid} (state: idle in transaction`,
    )

    await holder.query("ROLLBACK")
    await cleanTestDb(DreamApp)
    expect(await rowCount("parents")).toBe(0)
  }, 15_000)

  it("limits the foreign-key cycle group's TRUNCATE waiting for a reader's transaction, and names the table and the connection", async () => {
    await db.query("INSERT INTO cycle_a (id) VALUES (1)")
    // a read does not block the up-front table lock, but holds off TRUNCATE
    const reader = await otherConnection()
    const readerPid = await pidOf(reader)
    await reader.query("BEGIN; SELECT count(*) FROM cycle_a")

    const { error, elapsed } = await timed(cleanTestDb(DreamApp))

    expect(elapsed).toBeGreaterThanOrEqual(4_000)
    expect(elapsed).toBeLessThan(10_000)
    expect(error?.message).toContain(
      `cleanTestDb could not clean database "${DATABASE}" within 5000ms: it was waiting to clean its dirty tables`,
    )
    expect(error?.message).toContain(
      `table "cycle_a" is locked (AccessShareLock) by the connection with pid ${readerPid} (state: idle in transaction`,
    )

    await reader.query("ROLLBACK")
    await cleanTestDb(DreamApp)
    expect(await rowCount("cycle_a")).toBe(0)
  }, 15_000)
})

describe("cleanTestDb's time-limit error", () => {
  it("names a connection holding a table that the foreign-key cycle group's TRUNCATE ... CASCADE also truncates", async () => {
    await db.query("INSERT INTO cycle_a (id) VALUES (1)")
    // leaf references cycle_a, so the TRUNCATE needs leaf too
    const reader = await otherConnection()
    const readerPid = await pidOf(reader)
    await reader.query("BEGIN; SELECT count(*) FROM leaf")

    const { error, elapsed } = await timed(cleanTestDb(DreamApp))

    expect(elapsed).toBeLessThan(10_000)
    expect(error?.message).toContain(
      `cleanTestDb could not clean database "${DATABASE}" within 5000ms: it was waiting to clean its dirty tables`,
    )
    expect(error?.message).toContain(
      `table "leaf" is locked (AccessShareLock) by the connection with pid ${readerPid} (state: idle in transaction`,
    )

    await reader.query("ROLLBACK")
  }, 15_000)
})
