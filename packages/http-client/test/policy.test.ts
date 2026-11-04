import { expect, test, vi } from 'vitest'

import { HTTPClientError } from '../src/errors.js'
import { checkTarget, resolvePolicy, toURL } from '../src/policy.js'
import type { HTTPClientErrorCode, RequestPolicy } from '../src/types.js'

async function expectCode(promise: Promise<void>, code: HTTPClientErrorCode, sent: boolean) {
  await expect(promise).rejects.toBeInstanceOf(HTTPClientError)
  await expect(promise).rejects.toMatchObject({ code, sent })
}

const origins = ['https://api.example.com']

test('applies defaults', () => {
  expect(resolvePolicy({ origins })).toEqual({
    origins: new Set(origins),
    timeoutMS: 15_000,
    maxResponseBytes: 5 * 1024 * 1024,
    maxRedirects: 3,
    retry: { attempts: 3, baseDelayMS: 250, maxDelayMS: 10_000 },
    allowInsecureLoopback: false,
  })
})

const invalidPolicies: Array<RequestPolicy> = [
  { origins: [] },
  ...[
    'https://api.example.com/v1',
    'https://api.example.com?x=1',
    'https://api.example.com#fragment',
    'https://api.example.com?',
    'https://api.example.com#',
    'https://u:p@api.example.com',
    'http://api.example.com',
    'http://localhost:8080',
    'not a URL',
    'ftp://api.example.com',
  ].map((origin) => ({ origins: [origin] })),
  { origins: ['http://api.example.com'], allowInsecureLoopback: true },
  { origins: ['http://a.localhost'], allowInsecureLoopback: true },
  { origins: ['http://[::ffff:127.0.0.1]'], allowInsecureLoopback: true },
  ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((timeoutMS) => ({ origins, timeoutMS })),
  ...[-1, Number.NaN, Number.POSITIVE_INFINITY].map((maxResponseBytes) => ({
    origins,
    maxResponseBytes,
  })),
  ...[-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY].map((maxRedirects) => ({
    origins,
    maxRedirects,
  })),
  ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map((attempts) => ({
    origins,
    retry: { attempts, baseDelayMS: 250, maxDelayMS: 10_000 },
  })),
  ...[-1, Number.NaN, Number.POSITIVE_INFINITY].map((baseDelayMS) => ({
    origins,
    retry: { attempts: 2, baseDelayMS, maxDelayMS: 10_000 },
  })),
  ...[100, Number.NaN, Number.POSITIVE_INFINITY].map((maxDelayMS) => ({
    origins,
    retry: { attempts: 2, baseDelayMS: 500, maxDelayMS },
  })),
  ...[0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY].map((requests) => ({
    origins,
    rateLimit: { requests, perMS: 1000 },
  })),
  ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((perMS) => ({
    origins,
    rateLimit: { requests: 1, perMS },
  })),
]

test.each(invalidPolicies)('rejects invalid policy %j', (policy) => {
  expect(() => resolvePolicy(policy)).toThrow(TypeError)
})

test('preserves explicit values including permitted zero values', () => {
  const policy: RequestPolicy = {
    origins: ['https://API.Example.com:443/'],
    timeoutMS: 100,
    maxResponseBytes: 0,
    maxRedirects: 0,
    retry: { attempts: 1, baseDelayMS: 0, maxDelayMS: 0 },
    rateLimit: { requests: 2, perMS: 1000 },
    allowInsecureLoopback: true,
  }
  expect(resolvePolicy(policy)).toEqual({ ...policy, origins: new Set(origins) })
})

test.each(['http://127.0.0.1:4000', 'http://localhost:4000', 'http://[::1]:4000'])(
  'accepts http loopback origin only with allowInsecureLoopback: %s',
  async (origin) => {
    expect(() => resolvePolicy({ origins: [origin] })).toThrow(TypeError)
    const policy = resolvePolicy({ origins: [origin], allowInsecureLoopback: true })
    await expect(
      checkTarget({ url: new URL(`${origin}/x`), policy, sent: false }),
    ).resolves.toBeUndefined()
  },
)

test.each([
  'https://API.Example.com/x',
  'https://api.example.com:443/x',
  'https://api.example.com',
])('matches origins after normalization: %s', async (input) => {
  const policy = resolvePolicy({ origins: ['https://api.example.com'] })
  await expect(checkTarget({ url: new URL(input), policy, sent: false })).resolves.toBeUndefined()
})

test.each([
  ['https://api.example.com:8443/x', 'ORIGIN_REFUSED'],
  ['http://api.example.com/', 'INSECURE_URL'],
  ['ftp://api.example.com/', 'INSECURE_URL'],
  ['https://u:p@api.example.com/', 'INSECURE_URL'],
  ['https://u:p@other.example.com/', 'INSECURE_URL'],
  ['https://10.0.0.1/', 'ORIGIN_REFUSED'],
] as Array<[string, HTTPClientErrorCode]>)('refuses %s with %s', async (input, code) => {
  const policy = resolvePolicy({ origins })
  await expectCode(checkTarget({ url: new URL(input), policy, sent: false }), code, false)
})

test('reports the sent flag it is given', async () => {
  const policy = resolvePolicy({ origins })
  await expectCode(
    checkTarget({ url: new URL('https://other.example.com'), policy, sent: true }),
    'ORIGIN_REFUSED',
    true,
  )
})

test.each([
  'https://10.0.0.1',
  'https://10.0.0.1.',
  'https://127.1',
  'https://2130706433',
  'https://0177.0.0.1',
  'https://0x7f.1',
  'https://0x7f.0.0.1',
  'https://[::ffff:127.0.0.1]',
  'https://[::ffff:7f00:1]',
  'https://[::1]',
  'https://localhost',
  'https://a.localhost',
  'https://localhost.',
  'https://a.localhost.',
])('refuses private literals and localhost names: %s', async (origin) => {
  const policy = resolvePolicy({ origins: [origin] })
  const resolveHost = vi.fn(async () => ['93.184.216.34'])
  await expectCode(
    checkTarget({ url: new URL(`${origin}/`), policy, resolveHost, sent: false }),
    'ADDRESS_REFUSED',
    false,
  )
  expect(resolveHost).not.toHaveBeenCalled()
})

test.each(['1.2.3.4..', '.', '..', '...'])(
  'refuses an unparseable numeric-and-dots host before resolution: %s',
  async (hostname) => {
    const url = new URL(`https://${hostname}/`)
    const policy = resolvePolicy({ origins: [url.origin] })
    const resolveHost = vi.fn(async () => ['93.184.216.34'])
    await expectCode(
      checkTarget({ url, policy, resolveHost, sent: false }),
      'ADDRESS_REFUSED',
      false,
    )
    expect(resolveHost).not.toHaveBeenCalled()
  },
)

test.each(['https://8.8.8.8', 'https://[2606:4700::1111]'])(
  'checks public literals without resolving: %s',
  async (origin) => {
    const resolveHost = vi.fn(async () => ['10.0.0.1'])
    await expect(
      checkTarget({
        url: new URL(origin),
        policy: resolvePolicy({ origins: [origin] }),
        resolveHost,
        sent: false,
      }),
    ).resolves.toBeUndefined()
    expect(resolveHost).not.toHaveBeenCalled()
  },
)

test.each(['https://127.9.8.7', 'https://[::1]', 'https://localhost.'])(
  'allows loopback hosts with the flag: %s',
  async (origin) => {
    await expect(
      checkTarget({
        url: new URL(`${origin}/x`),
        policy: resolvePolicy({ origins: [origin], allowInsecureLoopback: true }),
        sent: false,
      }),
    ).resolves.toBeUndefined()
  },
)

test.each(['https://a.localhost', 'https://10.0.0.1', 'https://[::ffff:127.0.0.1]'])(
  'does not exempt other private hosts with the flag: %s',
  async (origin) => {
    await expectCode(
      checkTarget({
        url: new URL(origin),
        policy: resolvePolicy({ origins: [origin], allowInsecureLoopback: true }),
        sent: false,
      }),
      'ADDRESS_REFUSED',
      false,
    )
  },
)

test('checks resolved public addresses and normalizes the resolver hostname', async () => {
  const origin = 'https://API.Example.com.'
  const resolveHost = vi.fn(async () => ['93.184.216.34'])
  await expect(
    checkTarget({
      url: new URL(origin),
      policy: resolvePolicy({ origins: [origin] }),
      resolveHost,
      sent: false,
    }),
  ).resolves.toBeUndefined()
  expect(resolveHost).toHaveBeenCalledExactlyOnceWith('api.example.com')
})

test.each([['93.184.216.34', '10.1.2.3'], ['garbage'], ['127.0.0.1']])(
  'refuses resolved private or invalid addresses: %j',
  async (...addresses) => {
    const policy = resolvePolicy({ origins, allowInsecureLoopback: true })
    await expectCode(
      checkTarget({
        url: new URL('https://api.example.com'),
        policy,
        resolveHost: async () => addresses,
        sent: false,
      }),
      'ADDRESS_REFUSED',
      false,
    )
  },
)

test('reports empty resolution as NETWORK with sent false', async () => {
  await expectCode(
    checkTarget({
      url: new URL('https://api.example.com'),
      policy: resolvePolicy({ origins }),
      resolveHost: async () => [],
      sent: true,
    }),
    'NETWORK',
    false,
  )
})

test('preserves resolution failure as the NETWORK cause with sent false', async () => {
  const cause = new Error('DNS failed')
  const promise = checkTarget({
    url: new URL('https://api.example.com'),
    policy: resolvePolicy({ origins }),
    resolveHost: async () => {
      throw cause
    },
    sent: true,
  })
  await expectCode(promise, 'NETWORK', false)
  await expect(promise).rejects.toHaveProperty('cause', cause)
})

test('skips name resolution when resolveHost is absent', async () => {
  await expect(
    checkTarget({
      url: new URL('https://api.example.com/'),
      policy: resolvePolicy({ origins }),
      sent: false,
    }),
  ).resolves.toBeUndefined()
})

test('toURL copies a URL object', () => {
  const url = new URL('https://api.example.com/x?y=1#z')
  const copy = toURL(url)
  expect(copy).not.toBe(url)
  expect(copy.href).toBe(url.href)
})

test('toURL parses a string', () => {
  expect(toURL('https://api.example.com/x').href).toBe('https://api.example.com/x')
})

test.each(['not a URL', '/relative', 'https://[invalid]'])(
  'toURL refuses unparseable input %j',
  (input) => {
    expect(() => toURL(input)).toThrow(HTTPClientError)
    try {
      toURL(input)
    } catch (error) {
      expect(error).toMatchObject({ code: 'INSECURE_URL', sent: false })
    }
  },
)
