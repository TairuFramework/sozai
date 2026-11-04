# @sozai/http-client

Policy-checked outbound HTTP for Node, Electron and React Native/Hermes, with retries, rate limits and auth appliers.

## Installation

```sh
pnpm add @sozai/http-client
```

## Usage

```ts
import { promises as dns } from 'node:dns'
import { bearerAuth, createHTTPClient } from '@sozai/http-client'

const client = createHTTPClient({
  policy: { origins: ['https://api.example.com'] },
  auth: bearerAuth(() => process.env.API_TOKEN ?? ''),
  resolveHost: async (host) => {
    const records = await dns.lookup(host, { all: true })
    return records.map(({ address }) => address)
  },
})

const result = await client.json<{ name: string }>({
  url: 'https://api.example.com/profile',
})
console.log(result.name)
```

The Node example injects DNS resolution. The package itself has no Node imports.
`fetch` defaults to `createRuntime().fetch` from `@sozai/runtime`, which delegates to `globalThis.fetch` at call time.
`fetch`, `resolveHost` and abortable `sleep` can be injected through `HTTPClientParams`.
The default `sleep` comes from `@sozai/async`.
`text()` and `json()` require `TextDecoder`. React Native apps on runtimes without it need a polyfill.

`request()` returns a buffered `HTTPResponse`, including non-2xx responses.
`client.json<T>()` sets `accept: application/json` unless supplied, throws `STATUS` for non-2xx responses, and parses successful responses.
Requests default to `GET`. `json` sets `content-type: application/json` unless supplied and is mutually exclusive with `body`.
`body` accepts a string or `Uint8Array`. Supplying both body forms throws `TypeError`.

The reported response URL uses the hop URL before auth adds query credentials.
A different platform-followed URL is reported only after its origin check.

Responses expose `status`, `statusText`, `ok`, `headers`, `url`, `bytes()`, `text()` and `json<T>()`.
`bytes()` returns the same buffered `Uint8Array` each time. `text()` uses a non-fatal `TextDecoder`.
`json<T>()` uses `JSON.parse` without runtime validation. Parse failures propagate as native `SyntaxError`.

## Policy defaults

| Field | Default | Meaning |
| --- | --- | --- |
| `origins` | Required | Non-empty list of allowed origins |
| `timeoutMS` | `15_000` | Per-attempt timer, including redirects and body buffering |
| `maxResponseBytes` | `5 * 1024 * 1024` | Buffered response cap, including an exact-cap body |
| `maxRedirects` | `3` | Maximum manually followed redirects per attempt |
| `retry` | `{ attempts: 3, baseDelayMS: 250, maxDelayMS: 10_000 }` | Total attempts and backoff limits |
| `rateLimit` | Unset | Optional `{ requests, perMS }` token bucket per `URL.host` per client |
| `allowInsecureLoopback` | `false` | Test-only exemption for literal loopback hosts and `localhost` |

Origins contain only a scheme, host and optional port, with an optional trailing `/`.
Paths, queries, fragments and user info are invalid. Origins compare by `new URL(origin).origin`, including normalised case and default ports.
Invalid policy configuration throws `TypeError` at construction.
Timeouts must be finite and positive. Response caps must be finite and non-negative. Redirect limits must be non-negative integers.
Retry attempts must be positive integers. Delays must be finite, with `0 <= baseDelayMS <= maxDelayMS`.
Rate-limit requests must be positive integers, and `perMS` must be finite and positive.

A bucket starts full with capacity `requests` and refills continuously at `requests / perMS` tokens per millisecond.
Every attempt and redirect hop takes a token for its hostname plus port. Concurrent callers reserve tokens and receive staggered, abortable waits.
Aborted waits refund their token. The first token wait is outside the attempt timer. Later hop waits are inside it.

## Address policy

Every manually sent hop checks scheme, user info, origin and address, in that order.
HTTPS is required. An undeclared private target fails with `ORIGIN_REFUSED` before the address check.
Literal IPs are checked directly. `localhost`, `*.localhost` and trailing-dot variants are refused.
Hostnames containing consecutive dots, including two or more trailing dots, produce `ADDRESS_REFUSED` before resolution, even with loopback enabled.
One trailing dot is removed for address checks. After literal-IP checks, remaining hosts containing only digits and dots produce `ADDRESS_REFUSED`.
Valid public IP literals remain allowed. Other hostnames use `resolveHost` when supplied. A rejected lookup or empty address list produces `NETWORK`.
Any private or unparseable resolved address produces `ADDRESS_REFUSED`.
Without `resolveHost`, DNS hostnames receive no resolved-address check.

The refused ranges include:

| Family | Ranges |
| --- | --- |
| IPv4 | `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `100.64/10`, `0/8` |
| IPv6 | `::1`, `fc00::/7`, `fe80::/10`, `::`, and `::ffff:`-mapped refused IPv4 addresses |
| Additional non-public addresses | IPv4 `198.18/15`, `224/3`, IPv6 `ff00::/8`, and refused IPv4 addresses embedded in IPv4-compatible or `64:ff9b::/96` addresses |

`allowInsecureLoopback` permits HTTP and bypasses address refusal only for literal `127/8`, `::1` and `localhost` hosts.
The origin must still be declared. Resolved loopback addresses receive no exemption.

## Auth and redirects

`bearerAuth(token)` accepts a string or a synchronous or asynchronous token provider.
`apiKeyAuth({ in: 'header' | 'query', name, value })` sets a header or replaces a query parameter through `searchParams.set`.
An empty API key name throws `TypeError`. `noAuth` is the default applier.
Auth runs after caller headers on every hop, using fresh headers and a URL copy. It can overwrite caller auth headers.
The caller's URL is never mutated. Applier errors propagate unwrapped and are never retried.
The attempt timer covers address checks, auth, fetch and body buffering after the first rate-limit token.
`resolveHost` receives an optional `{ signal }` argument. Lookup and auth waits stop on timeout or caller abort.
Before any fetch starts, these failures produce `TIMEOUT` or `ABORTED` with `sent: false`.

The client requests `redirect: 'manual'` and follows 301, 302, 303, 307 and 308 responses with `Location`.
Relative locations resolve against the hop URL. A redirect without `Location` is returned as a response.
303 switches to GET except for HEAD. 301/302 switch POST to GET. These switches drop the body, `content-type` and `content-length`.
307/308 preserve method and body. Each manually followed hop repeats the policy checks and reapplies auth.
Cross-origin redirects strip caller `authorization`, `cookie` and `proxy-authorization` headers before auth runs again. Other caller headers carry over.
Every declared origin receives the client's credential when a redirect reaches it.
Caller-supplied credential headers other than `authorization`, `cookie` and `proxy-authorization` carry over to another declared origin.
Redirect bodies are cancelled. Following beyond `maxRedirects` throws `TOO_MANY_REDIRECTS`.

## Retries

GET and HEAD are idempotent by default. Other methods retry only with `idempotent: true`. `idempotent: false` disables retries for any method.
`retry.attempts` counts total attempts. The default permits two retries, and `attempts: 1` disables retries.
Only `NETWORK`, `TIMEOUT` and HTTP 429, 502, 503 and 504 are retryable.
Each retry starts from the original URL with a fresh attempt timer. Retryable response bodies are cancelled before waiting.

Before retry `n` (1-based), full-jitter backoff is `Math.floor(Math.random() * Math.min(maxDelayMS, baseDelayMS * 2 ** (n - 1)))`.
A valid `Retry-After` replaces backoff with its exact delay when at most `maxDelayMS`.
Non-negative integer seconds and HTTP dates are accepted. Past dates yield zero. Invalid values use normal backoff.
A larger delay stops retries immediately. `request()` returns the last response, including exhausted retries and an excessive `Retry-After`.
`client.json()` throws `STATUS` with `status`, `response` and parsed `retryAfterMS` on non-2xx responses.
Exhausted `NETWORK` and `TIMEOUT` retries throw the last error. Backoff waits are abortable and outside the attempt timer.
Policy refusals, redirect overflow, oversized responses, aborts and auth applier errors are never retried.

## Errors and `sent`

`HTTPClientError` exposes `code`, `sent`, optional `status`, `retryAfterMS`, `response` and the native `cause`.
Its constructor takes one `HTTPClientErrorParams` object.
`sent: false` means no fetch for the logical request has started. Once any hop or attempt starts fetch, subsequent errors retain `sent: true`.
`sent: true` does not prove delivery or server-side execution. A timeout or network failure may happen after the server acted.
Abort errors use the caller signal's reason as `cause`, including aborts during rate-limit or backoff waits.

| Code | Meaning |
| --- | --- |
| `INSECURE_URL` | Unparseable URL, refused scheme or URL user info |
| `ORIGIN_REFUSED` | Target or platform-followed final origin is undeclared |
| `ADDRESS_REFUSED` | Refused or unparseable target address |
| `TOO_MANY_REDIRECTS` | Manual redirect limit exceeded |
| `TIMEOUT` | Attempt timer expired |
| `ABORTED` | Caller signal aborted |
| `NETWORK` | Lookup or fetch failure, invalid redirect location, opaque redirect or status 0 |
| `RESPONSE_TOO_LARGE` | Declared or observed body exceeds the cap. Includes `status` |
| `STATUS` | `client.json()` received a non-2xx response. Includes `status` and `response` |

## Known limits

IPv4-translated (`::ffff:0:a.b.c.d`), 6to4 (`2002::/16`), Teredo (`2001::/32`), `64:ff9b:1::/48` and `192.0.0.0/24` addresses are not refused yet.

DNS resolution checks precede fetch's own resolution. DNS rebinding between the check and fetch remains possible.
React Native may follow redirects itself despite `redirect: 'manual'`.
The client checks a differing, non-empty `response.url` against declared origins after fetch. It cannot inspect or prevent those intermediate hops.
Browser-like opaque redirects and status 0 produce `NETWORK`.

`createHTTPClient` captures `Date.now` at construction for the rate limiter. Later replacements of `Date.now` do not change that captured clock.

Without `response.body`, the client buffers through `arrayBuffer()` before checking the observed length. The cap cannot prevent that initial allocation.
With a stream, it counts bytes while reading and cancels on overflow. An excessive `content-length` is refused before reading.
