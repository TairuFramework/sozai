import { BlockList, isIP } from 'node:net'

import type { TrustProxy } from './types.js'

// Canonical IPv6 serialisation writes an IPv4-mapped address in hex: `::ffff:7f00:1`.
const MAPPED_IPV4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/

/**
 * Normalise an address so that equal addresses compare equal: IPv6 is canonicalised
 * (lowercase, compressed) and IPv4-mapped IPv6, in dotted or hex form, becomes IPv4.
 */
function normalize(address: string): string {
  if (isIP(address) !== 6) {
    return address
  }
  let canonical: string
  try {
    canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
  } catch {
    // Zone-scoped addresses (`fe80::1%eth0`) are not valid URL hosts.
    return address.toLowerCase()
  }
  const mapped = MAPPED_IPV4.exec(canonical)
  if (mapped == null) {
    return canonical
  }
  const high = Number.parseInt(mapped[1] ?? '0', 16)
  const low = Number.parseInt(mapped[2] ?? '0', 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

function invalidEntry(entry: string | number): Error {
  return new Error(`Invalid trustProxy entry "${entry}"`)
}

const PREFIX_LENGTH = /^\d{1,3}$/

function createBlockList(entries: ReadonlyArray<string>): BlockList {
  const list = new BlockList()
  for (const entry of entries) {
    const parts = entry.split('/')
    const [address, prefix] = parts
    const version = address == null ? 0 : isIP(address)
    if (address == null || version === 0 || parts.length > 2) {
      throw invalidEntry(entry)
    }
    const addressFamily = version === 6 ? 'ipv6' : 'ipv4'
    if (prefix == null) {
      list.addAddress(address, addressFamily)
      continue
    }
    const length = Number.parseInt(prefix, 10)
    if (!PREFIX_LENGTH.test(prefix) || length > (version === 6 ? 128 : 32)) {
      throw invalidEntry(entry)
    }
    list.addSubnet(address, length, addressFamily)
  }
  return list
}

function matches(list: BlockList, address: string): boolean {
  const version = isIP(address)
  return version !== 0 && list.check(address, version === 6 ? 'ipv6' : 'ipv4')
}

/**
 * Proxy trust configuration compiled once, used to check peers and resolve client IPs.
 */
export type TrustMatcher = {
  /** Whether the given socket peer is a trusted proxy. */
  isTrusted(peer: string): boolean
  /** Resolve the client IP from the socket peer and the `X-Forwarded-For` header. */
  resolve(peer: string, forwardedFor: string | undefined): string
}

/**
 * Compile a proxy trust configuration, throwing on malformed entries so that
 * configuration errors surface before any request is handled.
 */
export function createTrustMatcher(trustProxy: TrustProxy): TrustMatcher {
  if (trustProxy === false) {
    return {
      isTrusted: () => false,
      resolve: (peer) => normalize(peer),
    }
  }

  if (typeof trustProxy === 'number') {
    if (!Number.isInteger(trustProxy) || trustProxy < 0) {
      throw invalidEntry(trustProxy)
    }
    return {
      isTrusted: () => trustProxy > 0,
      resolve: (peer, forwardedFor) => {
        const chain = forwardedChain(peer, forwardedFor)
        return chain[Math.min(trustProxy, chain.length - 1)] ?? normalize(peer)
      },
    }
  }

  const trusted = createBlockList(trustProxy)
  return {
    isTrusted: (peer) => matches(trusted, normalize(peer)),
    resolve: (peer, forwardedFor) => {
      const chain = forwardedChain(peer, forwardedFor)
      return (
        chain.find((address) => !matches(trusted, address)) ??
        chain[chain.length - 1] ??
        normalize(peer)
      )
    },
  }
}

/**
 * Build the hop chain starting at the peer, from the nearest hop outwards. Header
 * entries are dropped entirely when any of them is not a valid IP.
 */
function forwardedChain(peer: string, forwardedFor: string | undefined): Array<string> {
  const peerIP = normalize(peer)
  if (forwardedFor == null) {
    return [peerIP]
  }
  const entries = forwardedFor.split(',').map((entry) => entry.trim())
  if (entries.some((entry) => isIP(entry) === 0)) {
    return [peerIP]
  }
  return [peerIP, ...entries.reverse().map(normalize)]
}

/**
 * Check whether a peer address is a trusted proxy under the given configuration.
 */
export function isTrustedPeer(peer: string, trustProxy: TrustProxy): boolean {
  return createTrustMatcher(trustProxy).isTrusted(peer)
}

export type ResolveClientIPParams = {
  peer: string
  forwardedFor: string | undefined
  trustProxy: TrustProxy
}

/**
 * Resolve the client IP from the socket peer and the `X-Forwarded-For` header,
 * only trusting header entries added by trusted proxies.
 */
export function resolveClientIP(params: ResolveClientIPParams): string {
  return createTrustMatcher(params.trustProxy).resolve(params.peer, params.forwardedFor)
}
