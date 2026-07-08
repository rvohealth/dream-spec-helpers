## 2.3.0

- new `cleanTestDb(DreamApp, connectionName?)` export: cleans the test database between specs with dirty-table detection. Instead of truncating every table on every call, it probes which tables actually contain rows (a single statement of per-table `EXISTS` checks on a persistent connection) and cleans exactly those — `DELETE FROM` in children-first foreign-key order, batched into one round trip, with foreign-key-cycle groups cleaned via one multi-table `TRUNCATE ... CASCADE`. A spec that wrote nothing pays ~0.5ms instead of ~40ms; writing specs pay ~1ms. Semantics are unchanged: all rows gone at each spec start, sequences untouched, `kysely_migration`/`kysely_migration_lock` left alone, `NODE_ENV === 'test'` only.
- `truncate` is deprecated (it no longer describes what the function does) but keeps working as an alias for `cleanTestDb` — existing hooks files get the speedup with no changes. It will be removed in a future major version.
- fix: the CJS build now ships a `dist/cjs/package.json` (`"type": "commonjs"`); previously the package-root `"type": "module"` made Node treat the CJS output as ESM, so none of it could be loaded with `require()`. Note that `require('@rvoh/dream-spec-helpers')` (the package index) still fails, because `provideDreamViteMatchers` imports `vitest`, which refuses to be `require()`d — a pre-existing limitation. ESM consumers (the supported setup) are unaffected.

- upgrade to pnpm@11.9.0; add pnpm-workspace.yaml with strictDepBuilds: false and esbuild blocked

## 2.2.1

- switch to Github action publishing to npmjs.com

## 2.2.0

- `truncate` now resolves the database to clear via `DreamApp#testDatabaseName` (the single source of truth for the per-live-worker test-database pool introduced in `@rvoh/dream@2.14.0`) instead of recomputing `<base>_<VITEST_POOL_ID>` on its own. `truncate` opens its own `pg.Client`, so it has to read — and, on first use, trigger — the same advisory-lock claim Dream's connection resolution uses; otherwise it would truncate a different database than the one the worker writes to. Falls back to the legacy `VITEST_POOL_ID`-based name when running against a Dream older than 2.14.0 (which lacks `testDatabaseName`), so this release is safe to adopt ahead of upgrading Dream.

## 2.1.1

- `toEqualClockTimeTz` matcher

## 2.1.0

- `toEqualClockTime` matcher

## 2.0.0

- bump to 2 to match Dream versioning
- remove unused lodash package

## 1.2.0

- toMatchDreamModel handles non-objects

## 1.2.0

- update `provideDreamViteMatchers` to take `DreamApp` so `toMatchDreamModel(s)` doesn't use the deprecated `isDreamInstance`

## 1.1.1

- add support for multiple connections when truncating. provide connectionName as a second argument when truncating. defaults to "default". Will maintain backwards compatibility with older versions of dream.

## 1.1.0

- update for Dream 1.4.0
