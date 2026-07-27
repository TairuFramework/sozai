# enkaku — migrate `@enkaku/react` off the `canonicalize` dependency

**Status:** open · blocked on `@sozai/json` publishing
**Package:** none here — the change lands in the `enkaku` repo
**Context:** [completed/2026-07-27-json-package](../completed/2026-07-27-json-package.complete.md)

`@enkaku/react` depends on the third-party `canonicalize` package directly
(`packages/react/src/client.ts`, catalog entry in that repo's `pnpm-workspace.yaml`). It was the
second consumer of canonical JSON in the stack, and part of why `@sozai/json` was built as its own
package rather than inlined into `@sozai/codec`.

Its import also carries an ESM-interop workaround — `canonicalize` declares `export default fn` but
ships `module.exports = fn`, so the call site casts through `unknown` to get a callable type.
`@sozai/json` is native ESM with real types, so the cast goes away.

## Why it is filed here

sozai owns the package that enables the change, and this is where the decision was made. The edit
itself belongs to the enkaku repo and should be tracked there once picked up.

## Blocked on

`@sozai/json` reaching npm. `@sozai/codec` consumes it via `workspace:^` inside this repo, but
enkaku is a separate repo and depends on published `^` ranges only.

## Then

Replace the import with `import { canonicalize } from '@sozai/json'`, drop the `unknown` cast and
the comment explaining it, and remove the `canonicalize` catalog entry from enkaku's
`pnpm-workspace.yaml` if nothing else there uses it.

Note the behaviour is not identical: `@sozai/json` throws `TypeError` for `NaN`, `Infinity`,
`BigInt` and circular references where `canonicalize@3.0.0` threw plain `Error` for the first,
second and fourth. `@enkaku/react` uses canonical JSON for cache keys rather than signing, so a
payload containing any of those is already a caller bug — but check the call site handles a throw
before assuming the swap is transparent.
