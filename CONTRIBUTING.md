# Contributing to Dream spec helpers

`@rvoh/dream-spec-helpers` provides Vitest matchers (`provideDreamViteMatchers`)
and test-database cleaning (`cleanTestDb`, plus the deprecated `truncate` alias)
for apps built on [Dream ORM](https://github.com/rvohealth/dream).

## Did you find a bug?

- **Do not open a GitHub issue for a security vulnerability.** Follow the
  [security policy](SECURITY.md) instead.
- **Search the [issues page](https://github.com/rvohealth/dream-spec-helpers/issues)**
  first; someone may already have reported it.
- If not, **open [a new issue](https://github.com/rvohealth/dream-spec-helpers/issues/new)**
  and include:
  - Package version
  - Node version
  - Postgres version
  - TypeScript and Vitest versions
  - A description of the problem
  - A code example that reproduces it

## Prerequisites

- **Node 26** (the primary development, CI and release runtime) or **Node 24**
  (also run in CI). `package.json` declares `engines.node` `>=24`.
- **pnpm 12.14.0.** It is pinned through the `packageManager` field in
  `package.json`. Ways to get it:
  - **Node 26** does not bundle corepack. Run `npm i -g corepack`, then
    `corepack enable`. Alternatively, install pnpm on its own
    (`npm i -g pnpm`): a standalone pnpm reads `packageManager` and switches to
    12.14.0 for this repo.
  - **Node 24** bundles corepack, so `corepack enable` is enough, but only on
    **Node 24.12.0 or later**. Older Node 24 releases bundle a corepack
    (0.34.4 or earlier) that cannot launch pnpm 12, so every `pnpm` command
    fails with `MODULE_NOT_FOUND` for `.../pnpm/12.14.0/bin/pnpm.cjs`. On an
    older Node 24, run `npm i -g corepack@0.34.7` first, or use Node 26 or a
    standalone pnpm.
- **No services are needed** to build or lint this package. It has no spec
  suite of its own, so neither Postgres nor Redis is required here.
  (`cleanTestDb` talks to Postgres, but only when a consuming app's specs call
  it.)

## Setup

```sh
git clone https://github.com/rvohealth/dream-spec-helpers.git
cd dream-spec-helpers
pnpm install --frozen-lockfile
pnpm build
```

There are no env files, databases or browsers to set up.

## Running checks

| Command       | What it does                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`  | Type-checks and compiles `src/` to `dist/cjs`, `dist/esm` and `dist/types`. This is the type-check, so run it after changes. |
| `pnpm lint`   | ESLint on `src/**/*.ts`, then `prettier . --check` on the whole repo.                                                        |
| `pnpm format` | `prettier . --write`, which fixes formatting.                                                                                |

`prettier . --check` also checks untracked files in the working tree. A local
scratch note at the repo root that Prettier has not formatted will therefore
make `pnpm lint` fail on your machine even though CI passes.

CI (`.github/workflows/ci.yml`) runs on every push and pull request, on
Node 24 and Node 26. Each run does `corepack enable`, then
`pnpm install --frozen-lockfile`, `pnpm build` and `pnpm lint`. The Node 24 job
also loads the built ESM entry and checks that the type declarations exist:

```sh
node --input-type=module -e "import('./dist/esm/src/index.js')"
test -f dist/types/src/index.d.ts
```

### Trying a change against a real app

This repo has no specs, so its behavior is tested through the specs of the
packages that depend on it. For example, `@rvoh/dream` imports it in
`spec/setup/hooks.ts`, and `@rvoh/psychic` and `@rvoh/psychic-spec-helpers`
also depend on it. To check a change, build it here and run that consumer's
spec suite against your local build, following the consumer's own
contributing guide for its services (such as Postgres). `cleanTestDb` only
runs when `NODE_ENV === 'test'`.

## Dependency updates and supply-chain policy

- The release-age cooldown lives in `pnpm-workspace.yaml`:
  `minimumReleaseAge: 4320` (3 days), with `@rvoh/*` exempted through
  `minimumReleaseAgeExclude`, because we maintain those packages. `.npmrc`
  holds registry settings only. Do not move install policy back into it,
  because pnpm 11 and later ignore it there.
- `allowBuilds` in `pnpm-workspace.yaml` is a supply-chain allowlist for
  dependency install scripts. Keep it minimal: add an entry only with clear
  cause.
- Update `package.json` and `pnpm-lock.yaml` together, and confirm that
  `pnpm install --frozen-lockfile` passes on the result.
- Keep `@types/node` on major 26 and `engines.node` at `>=24`, and do not use
  runtime APIs that exist only in Node 25 or 26 in `src/`. Node 24 must keep
  passing CI.

## Changes and pull requests

- Branch from `main` and open
  [a pull request](https://github.com/rvohealth/dream-spec-helpers/pulls). In
  the description, explain both the problem and the solution, and link the
  issue if there is one. Keep CI green; the people listed in
  [CODEOWNERS](CODEOWNERS) are requested as reviewers.
- `CHANGELOG.md` has one section per released version, written for people who
  use the package. Describe consumer-visible changes, including deprecations
  and upgrade caveats.
- **Public exports:** export an error only when a developer of a Psychic
  application needs to throw it, or should reasonably be able to catch it, as
  part of a normal application workflow. Being useful for debugging, logging
  or framework internals does not justify a public export. If an error stays
  exported only for backward compatibility, document it as such. (See
  [AGENTS.md](AGENTS.md).)
- **Releases** are cut by maintainers. A release PR bumps `version` in
  `package.json` and adds the `CHANGELOG.md` entry. Publishing a GitHub
  release tagged `vX.Y.Z` then publishes to npm through OIDC trusted
  publishing. See [RELEASING.md](RELEASING.md).

Thanks so much!

The Dream team
