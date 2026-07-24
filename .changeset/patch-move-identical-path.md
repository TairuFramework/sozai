---
'@sozai/patch': patch
---

`move` with identical `from` and `path` is now a permitted no-op.

RFC 6902 §4.4 forbids only a *proper* prefix — a location cannot be moved into one of its own
descendants — but the guard also rejected an identical `from === path`, throwing `INVALID_PATH`.
An identical location is not a proper prefix; the RFC permits it and it leaves the document
unchanged. `move` into an actual descendant (`/a` → `/a/b`) still throws.
