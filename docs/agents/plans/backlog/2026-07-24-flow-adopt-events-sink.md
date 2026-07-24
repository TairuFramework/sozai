# flow — adopt `EventsSink` for the emit-only slice

**Status:** open · low priority
**Source:** follow-on from the [2026-07-24 `@sozai/event` view-types work](../completed/2026-07-24-event-fire-and-view-types.complete.md),
which named `@sozai/flow` as the one in-repo adopter.

`packages/flow/src/types.ts:22` declares the emit-only surface it hands to handlers as a hand-rolled
slice:

```ts
emit: EventEmitter<Events>['emit']
```

The 07-24 event work added `EventsSink<Events>` — the write-only view (`emit`, `fire`, `writable`) —
precisely for this shape. Swapping to it replaces the ad-hoc indexed-access type with the named view
and, as a side effect, exposes `fire()` and `writable` to handlers if that is wanted (decide
deliberately — `EventsSink` is wider than the current single-method slice, so it is not a
mechanical drop-in unless the extra surface is intended).

## Scope

- `@sozai/flow` only. No `@sozai/event` change.
- Decide: keep the slice exactly emit-only (then this is just a rename to a shared alias, and
  `EventsSink` may be too wide), or widen to the full sink. If only `emit` is wanted, consider
  whether a narrower named type belongs in `@sozai/event` instead — or leave the indexed-access
  form as-is and close this.

## Why low priority

No behaviour change either way; purely a types-hygiene swap. `flow`'s current form works and is
tested. Worth doing when flow is next touched, not on its own.
