---
"@sozai/http-server": patch
---

Add `HTTPServer.use(name)`: read a plugin's export from the server once `createServer` resolves, typed through the plugin name, so callers no longer need a capturing plugin to reach it.
