# patch — RFC 6902 compliance + prototype-pollution fix

**Status:** open · freeze-blocker · priority 1
**Source:** [audit 2026-07-02 — patch](../completed/2026-07-02-repo-audit.complete.md#patch)

Biggest correctness surface in the repo, and includes the one remotely-reachable security
hole. Patches are the canonical remote-input format for the stack, so `apply` runs on
untrusted input. Target: one PR. RFC 6902 (JSON Patch) + RFC 6901 (JSON Pointer).

## Security — fix first

- **`src/apply.ts:134` — prototype pollution.** Patch path `/__proto__` (or
  `/constructor/prototype/x`) writes through to `Object.prototype`. Reject
  `__proto__`/`constructor`/`prototype` segments in `parsePath`; use `Object.hasOwn` for
  existence checks. `@sozai/schema`'s `src/utils.ts` already blocks exactly these — the two
  packages currently disagree; align them.

## RFC 6902 correctness

- **`src/apply.ts:127` — `add` on an existing array index replaces instead of inserting.**
  §4.1 says "inserts before". Strict mode (`src/apply.ts:216`) compounds it:
  `assertPathDoesNotExist` makes any mid-array add throw `PATH_EXISTS`. Fix:
  `target.splice(index, 0, value)`; drop/rescope the not-exists assertion.
- **`src/apply.ts` — no `-` append token.** §4.1: `add /arr/-` appends. Currently `-` stays
  a string key and `setPath` throws `INVALID_INDEX`.
- **`src/apply.ts:255` — `test` op uses `Object.is`.** §4.6 requires deep JSON equality;
  `test` against any object/array never matches unless same reference. Fix: deep structural
  comparison.
- **`src/apply.ts:61` — array index parsing too loose.** `Number()` accepts `' '`→0,
  `'01'`→1 (§6901 forbids leading zeros), `'1e2'`, `'0x10'`, `'1.5'`. Fix: treat only
  `/^(0|[1-9]\d*)$/` as an index, and only when the parent is an array.
- **`src/apply.ts:236-253` — `copy`/`move` insert live references.** Same object stays
  reachable from both locations; later mutations alias both subtrees. Fix: `structuredClone`
  for `copy`. `move` is also missing the §check that `from` must not be a proper prefix of
  `path`.
- **`src/apply.ts:173` — `remove` at `index === length` silently no-ops** (bounds check
  shared with append). Non-strict `replace /arr/<length>` appends. Fix: op-aware bounds
  (append only for add/set).
- **`src/apply.ts:208` — `applyPatches` is not atomic.** RFC requires all-or-nothing; a
  mid-sequence throw leaves data partially mutated. Fix: apply to a clone and assign back,
  or document loudly.
- **`src/apply.ts:56` — root pointer `""` unsupported** (§6901 empty pointer = whole
  document); currently throws `INVALID_PATH`.

## create → apply round-trip

- **`src/create.ts:48,90,102,137,143` — emitted paths never escaped.** Keys with `/` or `~`
  produce `/a/b` instead of `/a~1b`; apply then targets the wrong location. `parsePath`
  unescapes correctly, so the round-trip breaks exactly for these keys. Fix:
  `key.replace(/~/g, '~0').replace(/\//g, '~1')`.
- **`src/create.ts:66-84,112-126` — object↔array type change emits member-wise ops.**
  `[1,2,3]`→`{foo:'bar'}` emits removes that splice a shrinking array; object→array yields a
  plain object with numeric keys. Existing unit tests enshrine the broken series. Fix: emit
  `replace` whenever `Array.isArray(from) !== Array.isArray(to)`.

## API shape — decision gate (before freeze)

- **`createPatches(to, from)` argument order** is reversed from every mainstream diff API
  (`from, to`). Swapped args produce plausible wrong patches with no error. Reorder before
  the package ossifies.

## Minor

- `NaN` always diffs as changed and serializes to `null`; `undefined` `to` values leak into
  patch `value`s (not JSON-representable).

## Test-coverage gaps

`test` on compound values, `-` token, add-as-insert, create-side escaping, malformed
indices, `__proto__` paths, applying type-change patches. Several fixes above are marked
"Untested" in the audit — add coverage alongside each.
