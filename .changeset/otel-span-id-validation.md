---
'@sozai/otel': patch
---

`traceLogger` and `getActiveTraceContext` now validate the span ID alongside the trace ID.

Both guarded against no-op spans with `isValidTraceID` alone, so a span context pairing a
valid trace ID with an all-zero span ID passed: `spanID: '0000000000000000'` was stamped
onto every log line and returned from `getActiveTraceContext()`. Both now reject it —
`traceLogger` returns the logger unchanged, `getActiveTraceContext` returns `undefined`.

Unreachable through a real OTel SDK, whose spans always carry a well-formed span ID and
whose `INVALID_SPAN_CONTEXT` zeroes the trace ID too. It only affected hand-constructed
contexts; the W3C path already rejects malformed remote ones at parse time.
