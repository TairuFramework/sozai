---
"@sozai/http-server": patch
---

Add `transportInfo`, `isLoopbackAddress` and `isSecureTransport`: socket transport facts (TLS, local and remote address) read from the Node connection, never from request headers, and a loopback check for both ends.
