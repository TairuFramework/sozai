# stack — roll the strict base64 floor out to token verification

**Status:** open · follow-up · blocked on `@sozai/codec` publishing
**Package:** none here — the changes land in `kokuin` and `enkaku`
**Context:** the strict-decode work of 2026-08-03 (`@sozai/codec` minor, `@enkaku/server` patch)

`fromB64`/`fromB64U` now reject non-canonical encodings by default, so a malleable signature
string fails to decode at all. Nothing in the stack consumes that yet: `@kokuin/token` verifies
signatures through whatever `@sozai/codec` it resolves, and its floor still admits the lenient
`0.3.x`.

## Then

1. Bump `@kokuin/token`'s `@sozai/codec` floor to the strict release once it is on npm. A
   signature with non-zero spare bits then fails verification outright, upstream of any consumer.
2. Bump `@enkaku/server`'s catalog entry to the same floor. Its replay key already re-encodes
   canonically and does not depend on the bump, so this is defence in depth rather than a fix.
3. Check whether `@enkaku/server`'s `checkReplay` should keep decoding leniently once the floor
   moves. With a strict floor the decode there cannot fail for a verified message, and the
   comment saying so becomes load-bearing on the floor being in place.

## Watch for

The floor is a breaking change for any peer that hand-rolls its encoding. Every encoder in the
stack emits canonical output, so this only bites on interop with an outside implementation —
worth a note in the release description rather than a code guard.

Padding is a separate axis that `strict` deliberately does not collapse: `fromB64U` still
accepts padded and unpadded spellings of the same bytes, so anything treating an encoded string
as an identity must re-encode regardless of the floor.
