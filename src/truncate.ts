import cleanTestDb from "./cleanTestDb.js"

/**
 * Removes all rows from the application's tables so that each spec starts
 * from an empty database. Kept for backward compatibility; new code should
 * call {@link cleanTestDb}, which this delegates to (same signature, same
 * behavior — including the dirty-table detection that makes cleaning a
 * near-no-op for specs that wrote nothing).
 *
 * @deprecated use `cleanTestDb` instead — same signature and behavior; this
 * alias will be removed in a future major version.
 *
 * @param DreamApp - the DreamApp class from `@rvoh/dream`
 * @param connectionName - the configured database connection to clean (defaults to `"default"`)
 */
export default async function truncate(
  DreamApp: any,
  connectionName: string = "default",
) {
  return await cleanTestDb(DreamApp, connectionName)
}
