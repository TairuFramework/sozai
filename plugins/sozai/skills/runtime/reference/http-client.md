# @sozai/http-client

Policy-checked outbound HTTP for Node, Electron and React Native/Hermes.

### Exports

| Export | Kind | Description |
| --- | --- | --- |
| `createHTTPClient` | function | Accepts `HTTPClientParams`, returns `HTTPClient` |
| `bearerAuth` | function | Bearer token string or sync/async token provider |
| `apiKeyAuth` | function | `{ in: 'header' \| 'query', name, value }` applier. Empty names throw `TypeError` |
| `basicAuth` | function | `{ username, password }` applier (RFC 7617, UTF-8). Empty usernames, colons in usernames and control characters throw `TypeError` |
| `noAuth` | value | Default no-op `AuthApplier` |
| `HTTPClientError` | class | Error with `code`, `sent`, optional `status`, `retryAfterMS`, `response` and native `cause` |
| `AuthApplier` | type | Receives an `AuthTarget` (`{ url: URL, headers: Headers }`), returns void or a promise |
| `BearerToken`, `BearerTokenProvider`, `APIKeyAuthParams`, `BasicAuthParams` | type | Auth applier parameters |
| `ResolveHostOptions`, `Sleep` | type | `ResolveHost` options and the injected `sleep` |
| `HTTPRetryPolicy` | type | `{ attempts, baseDelayMS, maxDelayMS }` |
| `RateLimit` | type | `{ requests, perMS }` |
| `RequestPolicy` | type | Declared origins and optional timeout, body cap, redirects, retries, rate limit and loopback exemption |
| `ResolveHost` | type | Hostname and optional `{ signal?: AbortSignal }` to `Promise<Array<string>>` of addresses |
| `HTTPClientParams` | type | Required `policy`, optional `auth`, `fetch`, `resolveHost`, abortable `sleep` |
| `HTTPRequest` | type | `url`, optional `method`, `headers`, `json`, `body`, `idempotent`, `signal` |
| `HTTPResponse` | type | `status`, `statusText`, `ok`, `headers`, `url`, buffered `bytes()`, `text()`, `json<T>()` |
| `HTTPClient` | type | `request()` returns responses including non-2xx. `json<T>()` throws `STATUS` on non-2xx |
| `HTTPClientErrorCode` | type | Union of the nine codes below |
| `HTTPClientErrorParams` | type | Constructor object: `code`, `sent`, optional `message`, `status`, `retryAfterMS`, `response`, `cause` |

### Policy defaults

| Field | Default |
| --- | --- |
| `origins` | Required non-empty origin list, normalised with `URL.origin` |
| `timeoutMS` | `15_000`, per attempt including redirects and body buffering |
| `maxResponseBytes` | `5 * 1024 * 1024`, exact-cap bodies accepted |
| `maxRedirects` | `3` |
| `retry` | `{ attempts: 3, baseDelayMS: 250, maxDelayMS: 10_000 }` |
| `rateLimit` | Unset. Optional token bucket per `URL.host` per client |
| `allowInsecureLoopback` | `false`. Test-only literal `127/8`, `::1` and `localhost` exemption |

Invalid policy configuration throws `TypeError` at construction. Origins allow only scheme, host, optional port and trailing `/`.
HTTP is permitted only for exempt loopback hosts. The origin must still be declared.
Requests default to GET. `json` and `body` are mutually exclusive. `body` accepts a string or `Uint8Array`.
`json` sets content-type and `client.json()` sets accept to `application/json`, unless supplied.
Default fetch delegates through `createRuntime().fetch` at call time. Default sleep comes from `@sozai/async`.

### Address checks

Each manually sent hop checks scheme, user info, origin and address, in order.
Refused IPv4 ranges: `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `100.64/10`, `0/8`, `198.18/15`, `224/3`.
Refused IPv6 ranges include `::1`, `::`, `fc00::/7`, `fe80::/10`, `ff00::/8` and mapped refused IPv4 addresses.
IPv4-compatible and `64:ff9b::/96` embedded IPv4 addresses also receive IPv4 checks.
`localhost`, subdomains and trailing-dot variants are refused unless the exact loopback exemption applies.
Inject `resolveHost` to check DNS results. Rejection or an empty list produces `NETWORK`. Any private or unparseable address produces `ADDRESS_REFUSED`.
Consecutive dots, including two or more trailing dots, produce `ADDRESS_REFUSED` before resolution, even with loopback enabled.
One trailing dot is removed for address checks. After literal-IP checks, remaining digits-and-dots-only hosts produce `ADDRESS_REFUSED`.
Valid public IP literals remain allowed. Without a resolver, DNS addresses remain unchecked. Resolved loopback addresses receive no exemption.

### Retries, redirects and auth

GET/HEAD are idempotent by default. Other methods retry only with `idempotent: true`. Explicit `false` disables retries.
`attempts` counts total attempts. `1` disables retries. Only `NETWORK`, `TIMEOUT`, 429, 502, 503 and 504 are retryable.
Retry `n` uses full jitter: `Math.floor(Math.random() * Math.min(maxDelayMS, baseDelayMS * 2 ** (n - 1)))`.
A valid `Retry-After` supplies an exact delay when at most `maxDelayMS`. Larger values stop retries immediately.
It accepts non-negative integer seconds or HTTP dates. Past dates yield zero. Invalid values use backoff.
`request()` returns the final status response. `client.json()` throws `STATUS` with `status`, `response` and parsed `retryAfterMS`.
Exhausted NETWORK/TIMEOUT retries throw the last error. Retries restart from the original URL.
Policy refusals, oversized responses, redirect overflow, aborts and auth applier errors are never retried.

301/302/303/307/308 with Location are followed manually. 303 switches to GET except HEAD. 301/302 switch POST to GET.
These switches drop body, content-type and content-length. 307/308 preserve method and body. Missing Location returns the response.
Auth runs on fresh headers and URL copies after caller headers, on every hop. The caller's URL remains unchanged.
Cross-origin redirects strip caller authorization, cookie and proxy-authorization before auth runs again. Other headers carry over.
Every declared origin receives the client's credential on redirects. Other caller credential headers carry over across declared origins.
The response URL excludes query credentials added by auth unless the platform followed a different URL, which receives an origin check.
Auth can overwrite caller headers. Query API keys replace the named parameter. Applier errors propagate unwrapped.

### Errors and limits

Codes: `INSECURE_URL`, `ORIGIN_REFUSED`, `ADDRESS_REFUSED`, `TOO_MANY_REDIRECTS`, `TIMEOUT`, `ABORTED`, `NETWORK`, `RESPONSE_TOO_LARGE`, `STATUS`.
`sent` is false only before any fetch starts for the logical request. It stays true across later hops and attempts.
True does not prove delivery. Abort `cause` is the caller signal's reason, including during backoff and rate-limit waits.
`text()` and `json()` require TextDecoder. React Native runtimes without it need a polyfill.
`bytes()` returns the same buffer. `text()` uses non-fatal decoding. `json<T>()` parses without validation and propagates native `SyntaxError`.

Rate-limit buckets start full and refill continuously. Every fetch consumes a token. Concurrent waits reserve tokens, and aborted waits refund them.
The first token wait precedes the attempt timer. Address checks and auth follow, covered by that timer.
Lookup and auth waits race the attempt signal. Before fetch, timeout or abort produces TIMEOUT or ABORTED with sent: false.
The rate limiter captures `Date.now` at client construction.
DNS rebinding between the address check and fetch remains possible.
React Native may follow redirects itself. A differing non-empty `response.url` receives an origin check after fetch, without intermediate-hop inspection.
Opaque redirects and status 0 produce `NETWORK`. Without response.body, arrayBuffer buffers before checking observed size.
