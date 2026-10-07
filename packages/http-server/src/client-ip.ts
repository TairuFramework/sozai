import { BlockList, isIP } from 'node:net'

import type { TrustProxy } from './types.js'

const MAPPED_IPV4_PREFIX = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

function normalize(address: string): string {
  const mapped = MAPPED_IPV4_PREFIX.exec(address)
  return mapped?.[1] ?? address.toLowerCase()
}

function family(address: string): 'ipv4' | 'ipv6' {
  return isIP(address) === 6 ? 'ipv6' : 'ipv4'
}

function createBlockList(entries: Array<string>): BlockList {
  const list = new BlockList()
  for (const entry of entries) {
    const [address, prefix] = entry.split('/')
    if (address == null) {
      continue
    }
    if (prefix == null) {
      list.addAddress(address, family(address))
    } else {
      list.addSubnet(address, Number.parseInt(prefix, 10), family(address))
    }
  }
  return list
}

function matches(list: BlockList, address: string): boolean {
  const version = isIP(address)
  return version !== 0 && list.check(address, version === 6 ? 'ipv6' : 'ipv4')
}

/**
 * Check whether a peer address is a trusted proxy under the given configuration.
 */
export function isTrustedPeer(peer: string, trustProxy: TrustProxy): boolean {
  if (trustProxy === false) {
    return false
  }
  if (typeof trustProxy === 'number') {
    return trustProxy > 0
  }
  return matches(createBlockList(trustProxy), normalize(peer))
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
  const { peer, forwardedFor, trustProxy } = params
  const peerIP = normalize(peer)
  if (trustProxy === false || forwardedFor == null) {
    return peerIP
  }

  const entries = forwardedFor.split(',').map((entry) => entry.trim())
  if (entries.some((entry) => isIP(entry) === 0)) {
    return peerIP
  }

  const chain = [peerIP, ...entries.reverse().map(normalize)]
  if (typeof trustProxy === 'number') {
    return chain[Math.min(trustProxy, chain.length - 1)] ?? peerIP
  }

  const trusted = createBlockList(trustProxy)
  return chain.find((address) => !matches(trusted, address)) ?? chain[chain.length - 1] ?? peerIP
}
