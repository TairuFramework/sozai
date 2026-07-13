# @sozai/lock

Cross-process file mutex. **Node.js only.**

## Installation

```sh
npm install @sozai/lock
```

## Usage

```ts
import { withFileLock } from '@sozai/lock'

const key = await withFileLock(`${dataDir}/keystore.lock`, async () => {
  const existing = await store.get(keyID)
  return existing ?? (await store.set(keyID, await generateKey()))
})
```

## Constraints

- `lockPath` must be on a **local filesystem**. `link()` atomicity is not guaranteed on NFS.
- Acquisition is bounded by `timeout` (default 10s) and **throws** when it expires — the critical
  section never runs unlocked.
- Not reentrant: acquiring the same path twice in one process, without releasing, deadlocks until
  the timeout fires.
