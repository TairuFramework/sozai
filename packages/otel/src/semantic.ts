export const ZERO_TRACE_ID = '00000000000000000000000000000000'

/**
 * The all-zero span ID. W3C Trace Context declares it invalid, and OTel's no-op
 * spans carry it. Internal — not re-exported from the package index, because no
 * consumer has a use for it. `ZERO_TRACE_ID` is public only because it predates
 * this module.
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
