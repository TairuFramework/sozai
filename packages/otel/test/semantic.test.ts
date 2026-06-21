import { describe, expect, test } from 'vitest'

import { AttributeKeys, SpanNames } from '../src/semantic.js'

describe('SpanNames', () => {
  test('has client span names', () => {
    expect(SpanNames.CLIENT_CALL).toBe('sozai.client.call')
    expect(SpanNames.CLIENT_RESPONSE).toBe('sozai.client.response')
  })

  test('has server span names', () => {
    expect(SpanNames.SERVER_HANDLE).toBe('sozai.server.handle')
    expect(SpanNames.SERVER_ACCESS_CONTROL).toBe('sozai.server.access_control')
    expect(SpanNames.SERVER_HANDLER).toBe('sozai.server.handler')
  })

  test('has token span names', () => {
    expect(SpanNames.TOKEN_SIGN).toBe('sozai.token.sign')
    expect(SpanNames.TOKEN_VERIFY).toBe('sozai.token.verify')
  })

  test('has keystore span names', () => {
    expect(SpanNames.KEYSTORE_GET_OR_CREATE).toBe('sozai.keystore.get_or_create')
  })

  test('has transport span names', () => {
    expect(SpanNames.TRANSPORT_WRITE).toBe('sozai.transport.write')
    expect(SpanNames.TRANSPORT_HTTP_REQUEST).toBe('sozai.transport.http.request')
    expect(SpanNames.TRANSPORT_HTTP_SSE_CONNECT).toBe('sozai.transport.http.sse_connect')
    expect(SpanNames.TRANSPORT_WS_CONNECT).toBe('sozai.transport.ws.connect')
    expect(SpanNames.TRANSPORT_WS_MESSAGE).toBe('sozai.transport.ws.message')
  })

  test('has socket transport span name', () => {
    expect(SpanNames.TRANSPORT_SOCKET_CONNECT).toBe('sozai.transport.socket.connect')
  })
})

describe('AttributeKeys', () => {
  test('has RPC attributes', () => {
    expect(AttributeKeys.RPC_PROCEDURE).toBe('rpc.procedure')
    expect(AttributeKeys.RPC_REQUEST_ID).toBe('rpc.request_id')
    expect(AttributeKeys.RPC_TYPE).toBe('rpc.type')
    expect(AttributeKeys.RPC_SYSTEM).toBe('rpc.system')
  })

  test('has auth attributes', () => {
    expect(AttributeKeys.AUTH_DID).toBe('sozai.auth.did')
    expect(AttributeKeys.AUTH_ALGORITHM).toBe('sozai.auth.algorithm')
    expect(AttributeKeys.AUTH_ALLOWED).toBe('sozai.auth.allowed')
    expect(AttributeKeys.AUTH_REASON).toBe('sozai.auth.reason')
  })

  test('has keystore attributes', () => {
    expect(AttributeKeys.KEYSTORE_KEY_CREATED).toBe('sozai.keystore.key_created')
    expect(AttributeKeys.KEYSTORE_STORE_TYPE).toBe('sozai.keystore.store_type')
  })

  test('has transport attributes', () => {
    expect(AttributeKeys.TRANSPORT_TYPE).toBe('sozai.transport.type')
  })

  test('has transport session ID attribute', () => {
    expect(AttributeKeys.TRANSPORT_SESSION_ID).toBe('sozai.transport.session_id')
  })

  test('has HTTP attributes', () => {
    expect(AttributeKeys.HTTP_METHOD).toBe('http.method')
    expect(AttributeKeys.HTTP_STATUS_CODE).toBe('http.status_code')
  })

  test('has network attributes', () => {
    expect(AttributeKeys.NET_PEER_NAME).toBe('net.peer.name')
  })

  test('has stream message index attribute', () => {
    expect(AttributeKeys.STREAM_MESSAGE_INDEX).toBe('sozai.stream.message_index')
  })

  test('has channel message index attribute', () => {
    expect(AttributeKeys.CHANNEL_MESSAGE_INDEX).toBe('sozai.channel.message_index')
  })

  test('has message direction attribute', () => {
    expect(AttributeKeys.MESSAGE_DIRECTION).toBe('sozai.message.direction')
  })

  test('has validation success attribute', () => {
    expect(AttributeKeys.VALIDATION_SUCCESS).toBe('sozai.validation.success')
  })

  test('has validation error attribute', () => {
    expect(AttributeKeys.VALIDATION_ERROR).toBe('sozai.validation.error')
  })

  test('has error attributes', () => {
    expect(AttributeKeys.ERROR_CODE).toBe('sozai.error.code')
    expect(AttributeKeys.ERROR_MESSAGE).toBe('sozai.error.message')
  })
})
