export const ZERO_TRACE_ID = '00000000000000000000000000000000'

export const SpanNames = {
  // Client
  CLIENT_CALL: 'sozai.client.call',
  CLIENT_RESPONSE: 'sozai.client.response',

  // Server
  SERVER_HANDLE: 'sozai.server.handle',
  SERVER_ACCESS_CONTROL: 'sozai.server.access_control',
  SERVER_HANDLER: 'sozai.server.handler',

  // Token
  TOKEN_SIGN: 'sozai.token.sign',
  TOKEN_VERIFY: 'sozai.token.verify',

  // Keystore
  KEYSTORE_GET_OR_CREATE: 'sozai.keystore.get_or_create',

  // Transport
  TRANSPORT_WRITE: 'sozai.transport.write',
  TRANSPORT_HTTP_REQUEST: 'sozai.transport.http.request',
  TRANSPORT_HTTP_SSE_CONNECT: 'sozai.transport.http.sse_connect',
  TRANSPORT_WS_CONNECT: 'sozai.transport.ws.connect',
  TRANSPORT_WS_MESSAGE: 'sozai.transport.ws.message',
  TRANSPORT_SOCKET_CONNECT: 'sozai.transport.socket.connect',
} as const

export const AttributeKeys = {
  // RPC (follows OTel semantic conventions)
  RPC_PROCEDURE: 'rpc.procedure',
  RPC_REQUEST_ID: 'rpc.request_id',
  RPC_TYPE: 'rpc.type',
  RPC_SYSTEM: 'rpc.system',

  // Auth
  AUTH_DID: 'sozai.auth.did',
  AUTH_ALGORITHM: 'sozai.auth.algorithm',
  AUTH_ALLOWED: 'sozai.auth.allowed',
  AUTH_REASON: 'sozai.auth.reason',

  // Keystore
  KEYSTORE_KEY_CREATED: 'sozai.keystore.key_created',
  KEYSTORE_STORE_TYPE: 'sozai.keystore.store_type',

  // Transport
  TRANSPORT_TYPE: 'sozai.transport.type',
  TRANSPORT_SESSION_ID: 'sozai.transport.session_id',

  // HTTP (standard OTel)
  HTTP_METHOD: 'http.method',
  HTTP_STATUS_CODE: 'http.status_code',

  // Network
  NET_PEER_NAME: 'net.peer.name',

  // Stream/Channel messaging
  STREAM_MESSAGE_INDEX: 'sozai.stream.message_index',
  CHANNEL_MESSAGE_INDEX: 'sozai.channel.message_index',
  MESSAGE_DIRECTION: 'sozai.message.direction',

  // Validation
  VALIDATION_SUCCESS: 'sozai.validation.success',
  VALIDATION_ERROR: 'sozai.validation.error',

  // Error
  ERROR_CODE: 'sozai.error.code',
  ERROR_MESSAGE: 'sozai.error.message',
} as const
