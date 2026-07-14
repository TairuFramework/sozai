export const ZERO_TRACE_ID = '00000000000000000000000000000000'

/**
 * The all-zero span ID: invalid per W3C, and what OTel's no-op spans carry.
 *
 * Internal. Prefer `isValidSpanID` over comparing against this.
 */
export const ZERO_SPAN_ID = '0000000000000000'

export const AttributeKeys = {
  // RPC (OTel semantic conventions)
  RPC_PROCEDURE: 'rpc.procedure',
  RPC_REQUEST_ID: 'rpc.request_id',
  RPC_TYPE: 'rpc.type',
  RPC_SYSTEM: 'rpc.system',

  // HTTP (standard OTel)
  HTTP_METHOD: 'http.method',
  HTTP_STATUS_CODE: 'http.status_code',

  // Network
  NET_PEER_NAME: 'net.peer.name',
} as const
