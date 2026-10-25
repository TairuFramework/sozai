---
"@sozai/async": patch
---

Add createYielder, defaultYielder and maybeYield: a cooperative yielder that lets long async loops return to the event loop via setTimeout macrotask turns once a time budget is exceeded, resuming waiters one per turn in FIFO order. The yielder schedules its turns with the setTimeout present when it is created (or a `schedule` option), so test fake timers installed later cannot stall it.
