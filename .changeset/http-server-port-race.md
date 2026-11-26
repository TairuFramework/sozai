---
"@sozai/http-server": patch
---

When the preferred port is busy, bind port 0 so the kernel picks the fallback port atomically, instead of binding the port get-port probed and released, which another process could take on loopback in the meantime.
