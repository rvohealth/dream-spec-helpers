import { Client } from "pg";

export default async function truncate(DreamApplication: any) {
  // this was only ever written to clear the db between tests,
  // so there is no way to truncate in dev/prod
  if (process.env.NODE_ENV !== "test") return false;

  const dreamconf = DreamApplication.getOrFail();
  const data = dreamconf.dbCredentials.primary;

  const client = new Client({
    host: data.host || "localhost",
    port: data.port,
    database: getDatabaseName(data.name),
    user: data.user,
    password: data.password,
  });
  await client.connect();

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
  );
  await client.end();
}

function getDatabaseName(dbName: string): string {
  return parallelDatabasesEnabled()
    ? `${dbName}_${process.env.JEST_WORKER_ID}`
    : dbName;
}

function parallelDatabasesEnabled(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    !Number.isNaN(Number(process.env.PARALLEL_TEST_DATABASES)) &&
    Number(process.env.PARALLEL_TEST_DATABASES) > 1 &&
    !Number.isNaN(Number(process.env.JEST_WORKER_ID)) &&
    Number(process.env.JEST_WORKER_ID) > 1
  );
}
