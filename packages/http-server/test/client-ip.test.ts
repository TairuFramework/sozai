import { describe, expect, test } from 'vitest'

import { isTrustedPeer, resolveClientIP } from '../src/client-ip.js'
import type { TrustProxy } from '../src/types.js'

type Row = {
  name: string
  peer: string
  forwardedFor: string | undefined
  trustProxy: TrustProxy
  expected: string
}

const rows: Array<Row> = [
  {
    name: 'ignores headers when trust is off',
    peer: '10.0.0.1',
    forwardedFor: '1.2.3.4',
    trustProxy: false,
    expected: '10.0.0.1',
  },
  {
    name: 'one hop returns the rightmost entry',
    peer: '10.0.0.1',
    forwardedFor: '6.6.6.6, 1.2.3.4',
    trustProxy: 1,
    expected: '1.2.3.4',
  },
  {
    name: 'two hops skip one forwarded proxy',
    peer: '10.0.0.1',
    forwardedFor: '1.2.3.4, 10.0.0.2',
    trustProxy: 2,
    expected: '1.2.3.4',
  },
  {
    name: 'short chain returns the last entry',
    peer: '10.0.0.1',
    forwardedFor: undefined,
    trustProxy: 2,
    expected: '10.0.0.1',
  },
  {
    name: 'cidr trust skips trusted proxies',
    peer: '10.0.0.1',
    forwardedFor: '6.6.6.6, 1.2.3.4, 10.0.0.2',
    trustProxy: ['10.0.0.0/8'],
    expected: '1.2.3.4',
  },
  {
    name: 'cidr trust ignores spoofed left entries',
    peer: '10.0.0.1',
    forwardedFor: '6.6.6.6, 1.2.3.4',
    trustProxy: ['10.0.0.0/8'],
    expected: '1.2.3.4',
  },
  {
    name: 'untrusted peer ignores headers under cidr trust',
    peer: '8.8.8.8',
    forwardedFor: '1.2.3.4',
    trustProxy: ['10.0.0.0/8'],
    expected: '8.8.8.8',
  },
  {
    name: 'malformed entry falls back to the peer',
    peer: '10.0.0.1',
    forwardedFor: '1.2.3.4, not-an-ip',
    trustProxy: 1,
    expected: '10.0.0.1',
  },
  {
    name: 'normalizes ipv4-mapped ipv6',
    peer: '::ffff:10.0.0.1',
    forwardedFor: undefined,
    trustProxy: false,
    expected: '10.0.0.1',
  },
  {
    name: 'matches ipv6 cidr',
    peer: 'fd00::1',
    forwardedFor: '2001:db8::5',
    trustProxy: ['fd00::/8'],
    expected: '2001:db8::5',
  },
]

describe('resolveClientIP', () => {
  test.each(rows)('$name', ({ peer, forwardedFor, trustProxy, expected }) => {
    expect(resolveClientIP({ peer, forwardedFor, trustProxy })).toBe(expected)
  })
})

test('isTrustedPeer', () => {
  expect(isTrustedPeer('10.0.0.1', ['10.0.0.0/8'])).toBe(true)
  expect(isTrustedPeer('8.8.8.8', ['10.0.0.0/8'])).toBe(false)
  expect(isTrustedPeer('8.8.8.8', 1)).toBe(true)
  expect(isTrustedPeer('8.8.8.8', false)).toBe(false)
})
