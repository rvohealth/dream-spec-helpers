// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pg from "pg"

export default async function truncate(DreamApplication: any) {
  // this was only ever written to clear the db between tests,
  // so there is no way to truncate in dev/prod
  if (process.env.NODE_ENV !== "test") return false

  const dreamconf = DreamApplication.getOrFail()
  const data = dreamconf.dbCredentials.primary

  const client = new pg.Client({
    host: data.host || "localhost",
    port: data.port,
    database: getDatabaseName(dreamconf, data.name),
    user: data.user,
    password: data.password,
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
