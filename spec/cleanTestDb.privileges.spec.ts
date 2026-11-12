// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as pgImport from "pg"
import cleanTestDb from "../src/cleanTestDb.js"

// same CommonJS interop shim as src/cleanTestDb.ts
const pg: any = (pgImport as any).Client
  ? (pgImport as any)
  : (pgImport as any).default

// cleanTestDb run by a database user that may not write to every table.
//
// Like spec/cleanTestDb.spec.ts, these specs read the Postgres connection
// settings from the DB_* environment variables, connect to DB_NAME (default
// "postgres") only to create and finally drop their own database, and touch
// no other database. To act as a less privileged user without creating a
// role, every new connection to their database runs as Postgres' built-in
// `pg_monitor` role, which can touch only the tables granted to it below
// (switching to it needs a superuser, as the DB_USER is in CI and usually
// locally).
const server = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || undefined,
  password: process.env.DB_PASSWORD || undefined,
}
const MAINTENANCE_DATABASE = process.env.DB_NAME || "postgres"
const DATABASE = "dream_spec_helpers_clean_test_db_privileges_spec"
const LESS_PRIVILEGED_ROLE = "pg_monitor"

const DreamApp = {
  getOrFail: () => ({
    dbCredentials: { default: { primary: { ...server, name: DATABASE } } },
  }),
}

let admin: any
let db: any

async function connect(database: string) {
  const client = new pg.Client({ ...server, database })
  await client.connect()
  return client
}

async function rowCount(table: string): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS count FROM ${table}`)
  return rows[0].count
}

beforeAll(async () => {
  admin = await connect(MAINTENANCE_DATABASE)
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${DATABASE}`)

  // connected before the database's default role is set, so it keeps the
  // DB_USER's privileges
  db = await connect(DATABASE)
  await db.query(`
    -- a table the specs write to: the user may read and delete its rows
    CREATE TABLE app_rows (id serial PRIMARY KEY);
    GRANT SELECT, DELETE ON app_rows TO ${LESS_PRIVILEGED_ROLE};

    -- a table the user may only read, such as reference data another role
    -- owns; it stays empty
    CREATE TABLE reference_rows (id serial PRIMARY KEY);
    GRANT SELECT ON reference_rows TO ${LESS_PRIVILEGED_ROLE};
  `)
  await admin.query(
    `ALTER DATABASE ${DATABASE} SET role TO ${LESS_PRIVILEGED_ROLE}`,
  )
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

describe("cleanTestDb run by a user that may not write to every table", () => {
  it("connects as the less privileged role (setup check)", async () => {
    const client = await connect(DATABASE)
    try {
      const { rows } = await client.query("SELECT current_user AS role")
      expect(rows[0].role).toBe(LESS_PRIVILEGED_ROLE)
    } finally {
      await client.end()
    }
  })

  it("cleans the tables it may write, leaving alone an empty table it may only read", async () => {
    await db.query("INSERT INTO app_rows DEFAULT VALUES")

    await expect(cleanTestDb(DreamApp)).resolves.toBeUndefined()

    expect(await rowCount("app_rows")).toBe(0)
  })
})
