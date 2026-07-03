# @sozai/patch

JSON Patch (RFC 6902) utilities with a small pragmatic superset.

## Installation

```sh
pnpm add @sozai/patch
```

## Usage

```ts
import { applyPatches, createPatches } from '@sozai/patch'

const from = { items: [1, 2, 3] }
const to = { items: [1, 2, 3, 4] }

const patches = createPatches(to, from)
// [{ op: 'add', path: '/items/3', value: 4 }]

const data = structuredClone(from)
applyPatches(data, patches) // atomic; throws PatchError on failure
// data → { items: [1, 2, 3, 4] }

// RFC `add` inserts before the given index — it never overwrites — so applying
// it again at an existing index shifts the rest of the array right:
applyPatches(data, [{ op: 'add', path: '/items/1', value: 9 }])
// data → { items: [1, 9, 2, 3, 4] }

// Extensions: `set` overwrites in place (never inserts); strict:false tolerates missing paths.
applyPatches(data, [{ op: 'set', path: '/items/0', value: 0 }])
// data → { items: [0, 9, 2, 3, 4] }
```

Standard ops (`add`/`remove`/`replace`/`copy`/`move`/`test`) follow RFC 6902/6901.
`set` (assign/overwrite) and the non-strict mode are documented non-standard extensions.
