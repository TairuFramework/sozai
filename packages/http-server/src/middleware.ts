import { getConnInfo } from '@hono/node-server/conninfo'
import type { Logger } from '@sozai/log'
import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { RequestIdVariables } from 'hono/request-id'

import type { TrustMatcher } from './client-ip.js'

const REQUEST_ID_HEADER = 'X-Request-Id'
const VALID_REQUEST_ID = /^[\w-]{1,255}$/

/**
 * Read the peer address from the underlying socket, or `undefined` when the request
 * is not backed by a Node.js socket.
 */
function getPeerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address
  } catch {
    return undefined
  }
}

/**
 * Assign a request ID, honouring a valid incoming `X-Request-Id` header only when
 * the socket peer is a trusted proxy. The ID is exposed as `c.var.requestId` and
 * the `X-Request-Id` response header.
 */
export function requestIDMiddleware(
  trust: TrustMatcher,
): MiddlewareHandler<{ Variables: RequestIdVariables }> {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER)
    let requestID: string | undefined
    if (incoming != null && VALID_REQUEST_ID.test(incoming)) {
      const peer = getPeerAddress(c)
      if (peer != null && trust.isTrusted(peer)) {
        requestID = incoming
      }
    }
    requestID ??= crypto.randomUUID()
    c.set('requestId', requestID)
    c.header(REQUEST_ID_HEADER, requestID)
    await next()
  }
}

/**
 * Log one line per request once the response is ready.
 */
export function accessLogMiddleware(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now()
    await next()
    logger.info('HTTP request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
      requestID: c.get('requestId'),
    })
  }
}

/**
 * Resolve the client IP of a request from its socket peer and, when the peer is a
 * trusted proxy, the `X-Forwarded-For` header. Returns an empty string when the
 * request is not backed by a socket.
 */
export function getClientIP(c: Context, trust: TrustMatcher): string {
  const peer = getPeerAddress(c)
  return peer == null ? '' : trust.resolve(peer, c.req.header('X-Forwarded-For'))
}

/**
 * Pass `HTTPException` responses through and turn any other error into a generic
 * 500 response carrying the request ID, logging the error details.
 */
export function errorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse()
    }
    const requestID = c.get('requestId')
    logger.error('Unhandled error in HTTP handler', {
      requestID,
      method: c.req.method,
      path: c.req.path,
      error: err,
      stack: err.stack,
    })
    return c.json({ error: 'Internal Server Error', requestID }, 500)
  }
}

export const notFoundHandler: NotFoundHandler = (c) => c.json({ error: 'Not Found' }, 404)
