import { describe, expect, test } from 'vitest'

import { AttributeKeys } from '../src/semantic.js'

describe('AttributeKeys', () => {
  test('has RPC attributes', () => {
    expect(AttributeKeys.RPC_PROCEDURE).toBe('rpc.procedure')
    expect(AttributeKeys.RPC_REQUEST_ID).toBe('rpc.request_id')
    expect(AttributeKeys.RPC_TYPE).toBe('rpc.type')
    expect(AttributeKeys.RPC_SYSTEM).toBe('rpc.system')
  })

  test('has HTTP attributes', () => {
    expect(AttributeKeys.HTTP_METHOD).toBe('http.method')
    expect(AttributeKeys.HTTP_STATUS_CODE).toBe('http.status_code')
  })

  test('has network attributes', () => {
    expect(AttributeKeys.NET_PEER_NAME).toBe('net.peer.name')
  })

  test('exposes no SpanNames export', async () => {
    const mod = await import('../src/semantic.js')
    expect('SpanNames' in mod).toBe(false)
  })

  test('exposes no domain attributes', () => {
    const keys = Object.keys(AttributeKeys)
    for (const k of keys) {
      expect(AttributeKeys[k as keyof typeof AttributeKeys]).not.toMatch(/^sozai\./)
    }
  })
})
