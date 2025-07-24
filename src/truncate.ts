// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pg from "pg"

export default async function truncate(DreamApplication: any, connectionName: string = 'default') {
  // this was only ever written to clear the db between tests,
  // so there is no way to truncate in dev/prod
  if (process.env.NODE_ENV !== "test") return false

  const dreamconf = DreamApplication.getOrFail()

  // prior to @rvoh/dream@1.5.0, dbCredentials would point to the app's
  // root db credentials. After 1.5.0, this has been switched to be a record
  // with keys that are connection names, and values that point to db credentials.
  // To maintain backwards compatibility with older versions of dream, we will check
  // for the 'default' key, and if it exists, we will use the connectionName to
  // drill in, and otherwise fall back, since we must be in an older version of dream.
  const credentials = dreamconf.dbCredentials[connectionName]?.primary || dreamconf.dbCredentials.primary

  if (!credentials) throw new Error(`Failed to locate db credentials for connectionName: ${connectionName}`)

  const client = new pg.Client({
    host: credentials.host || "localhost",
    port: credentials.port,
    database: getDatabaseName(dreamconf, credentials.name),
    user: credentials.user,
    password: credentials.password,
  })
  await client.connect()

  await client.query(
    `
DO $$
DECLARE row RECORD;
BEGIN
FOR row IN SELECT table_name
  FROM information_schema.tables
  WHERE table_type='BASE TABLE'
  AND table_schema='public'
  AND table_name NOT IN ('kysely_migration', 'kysely_migration_lock')
LOOP
  EXECUTE format('TRUNCATE TABLE %I CASCADE;',row.table_name);
END LOOP;
END;
$$;
`,
  )
  await client.end()
}

function getDatabaseName(dreamconf: any, dbName: string): string {
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
