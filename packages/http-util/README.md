# @sozai/http-util

Environment-agnostic HTTP helpers with no dependencies and no Node imports, for Node, Electron and React Native/Hermes.

| Export | Purpose |
| --- | --- |
| `parseIPv4(text)`, `parseIPv6(text)` | Strict parsing to bytes, `null` when invalid. IPv6 accepts brackets and refuses zone IDs |
| `isIPLiteral(host)` | Whether a host is an IPv4 or IPv6 literal |
| `isPublicAddress(address)` | `false` for private, loopback, link-local, multicast, reserved and unparseable addresses, including IPv4 embedded in IPv6 |
| `isLoopbackAddress(address)` | `127/8` or `::1` |
| `isLoopbackHost(hostname)` | `localhost` or a loopback literal, without DNS |
| `normalizeHostname(url)` | Lower case, without one trailing dot or IPv6 brackets |
| `parseRetryAfter(value, now)` | `Retry-After` seconds or HTTP date as a delay in milliseconds, `undefined` when invalid |

These checks classify the text they are given. A DNS name needs its resolved addresses checked too; `@sozai/http-client` does that for each request.
