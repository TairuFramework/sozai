---
"@sozai/async": patch
---

Add createYielder, defaultYielder and maybeYield: a cooperative yielder that lets long async loops return to the event loop via setTimeout macrotask turns once a time budget is exceeded, resuming waiters one per turn in FIFO order.
