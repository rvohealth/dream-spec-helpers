# AGENTS.md - AI Agent Instructions

## Public Error Exports

Export an error only when a developer of a Psychic application needs to throw
it or should reasonably be able to catch it as part of an expected,
well-functioning application workflow. An error being useful for debugging,
logging, or framework internals does not by itself justify a public export.
Compatibility-only residue (an error kept exported only for backward
compatibility, not because new code should throw or catch it) must be
documented as such, not treated as proof it still belongs in the public API.

## CI Tooling: Industry Standards Only

Use the standard, documented mechanism a tool already provides, such as pnpm's
`minimumReleaseAge` for dependency cooldowns. Never hand-write CI scripts,
guards, or harnesses that re-verify a tool's own configuration. If a protection
needs enforcing against edits to its configuration, use code review, CODEOWNERS,
or branch protection on the configuration files, not a custom check. An agent
that believes a custom CI check is needed must stop and ask the owner, naming
the standard mechanism it could not find.
