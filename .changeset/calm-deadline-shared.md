---
"@sozai/http-server": patch
---

Shutdown now takes a single reading of the grace deadline, shared by the shutdown hooks and the
drain wait, so the drain can no longer be cut short while hooks still see time remaining. `listen()`
no longer binds a socket when the server is disposed at the moment of binding, and plugin setup
uses `toPromise` from `@sozai/async`.
