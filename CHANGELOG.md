## 2.5.0

- fix: `cleanTestDb` (and the deprecated `truncate` alias) waits for writes in progress, as the full truncate it replaced in 2.3.0 did. Since 2.3.0 it checked which tables had rows and then deleted from them in a separate statement, without locking. A row committed by another connection in between (typically server work from the previous spec that was still running) made the clean fail with a foreign-key error such as `update or delete on table "parents" violates RESTRICT setting of foreign key constraint ... on table "children"`, blamed on the next spec, or was silently left behind in the next spec's database. `cleanTestDb` now locks the tables against writes (`SHARE ROW EXCLUSIVE`; reads are not blocked), then checks and cleans them in the same transaction. What callers can observe: (1) a clean that starts while another connection is mid-write now waits for that write to finish, and writes that arrive during the clean wait for it (both usually for milliseconds); (2) the whole clean is limited to 5 seconds, so if another connection keeps a transaction open on these tables for that long (for example, a transaction a spec opened and never committed or rolled back), `cleanTestDb` now throws an error naming the table and the blocking connection (pid, state, last query) where it used to return without waiting; (3) if Postgres breaks a deadlock with a concurrent writer by aborting the clean, the clean is retried, up to three attempts within the 5-second limit, after which it throws; (4) concurrent `cleanTestDb` calls for the same connection run one after another. A spec that wrote nothing still pays well under a millisecond on a small schema (measured at about 0.1 ms more than 2.4.0 on a 30-table schema). A write that starts after the clean has finished still lands in the next spec; for feature specs, see `resetBrowserState` in `@rvoh/psychic-spec-helpers`.
- fix: `toMatchDreamModels` now compares every pair of models. It sorts both arrays and is meant to pass only when each pair has the same class and primary key, but it used to decide on the last sorted pair alone, so a spec asserting the wrong set of models passed whenever the last pair happened to match (for example, `expect([place2, place3]).toMatchDreamModels([place1, place3])`). Such specs now fail, each one pointing at a spec that was not checking what it claimed. Negated assertions (`.not.toMatchDreamModels`) can only go from failing to passing. Assertions on empty or single-model arrays, and on arrays of different lengths, behave as before.

## 2.4.0

- Set the supported Node runtime floor to 24, with Node 26 as the primary CI and release runtime. Keep Node 26 development typings and verify Node 24 build and ESM runtime compatibility.
- The existing CommonJS package index limitation with Vitest remains; see the 2.3.0 entry. This release supports the ESM runtime entry and does not change public peer dependencies.

## 2.3.0

- new `cleanTestDb(DreamApp, connectionName?)` export: cleans the test database between specs with dirty-table detection. Instead of truncating every table on every call, it probes which tables actually contain rows (a single statement of per-table `EXISTS` checks on a persistent connection) and cleans exactly those — `DELETE FROM` in children-first foreign-key order, batched into one round trip, with foreign-key-cycle groups cleaned via one multi-table `TRUNCATE ... CASCADE`. A spec that wrote nothing pays ~0.5ms instead of ~40ms; writing specs pay ~1ms. Semantics are unchanged: all rows gone at each spec start, sequences untouched, `kysely_migration`/`kysely_migration_lock` left alone, `NODE_ENV === 'test'` only.
- `truncate` is deprecated (it no longer describes what the function does) but keeps working as an alias for `cleanTestDb` — existing hooks files get the speedup with no changes. It will be removed in a future major version.
- fix: the CJS build now ships a `dist/cjs/package.json` (`"type": "commonjs"`); previously the package-root `"type": "module"` made Node treat the CJS output as ESM, so none of it could be loaded with `require()`. Note that `require('@rvoh/dream-spec-helpers')` (the package index) still fails, because `provideDreamViteMatchers` imports `vitest`, which refuses to be `require()`d — a pre-existing limitation. ESM consumers (the supported setup) are unaffected.
- ordering caveat: because dirty tables are now cleaned with `DELETE` rather than `TRUNCATE`, Postgres reuses freed heap space, and queries without an `ORDER BY` are no longer coincidentally returned in insertion order. SQL never guaranteed that order; per-spec `TRUNCATE` made it deterministic anyway, and some specs may have unknowingly relied on it. Specs asserting row order must declare an ordering (an `order` option on the association, or an explicit `.order(...)` on the query) or assert order-agnostically (sort both sides before comparing, or use an order-insensitive matcher — this package's `toMatchDreamModels` sorts both arrays before comparing, so it is safe).
- fix: `cleanTestDb`'s cached long-lived `pg.Client` now has an `'error'` listener. Previously, if the test Postgres dropped the connection mid-suite (e.g., a restart), the idle client emitted `'error'` with no listener, which became an uncaughtException that killed the vitest worker with a raw pg stack. The error is now logged comprehensibly and the cache entry is evicted, so the next `cleanTestDb` call reconnects.

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
