import { fromUTF, toB64 } from '@sozai/codec'

import type { APIKeyAuthParams, AuthApplier, BasicAuthParams, BearerToken } from './types.js'

export function bearerAuth(token: BearerToken): AuthApplier {
  return async ({ headers }) => {
    const value = typeof token === 'function' ? await token() : token
    headers.set('authorization', `Bearer ${value}`)
  }
}

export function apiKeyAuth(params: APIKeyAuthParams): AuthApplier {
  const { in: location, name, value } = params
  if (name === '') throw new TypeError('API key name must not be empty')
  return ({ url, headers }) => {
    if (location === 'header') {
      headers.set(name, value)
    } else {
      url.searchParams.set(name, value)
    }
  }
}

const controlCharacter = /\p{Cc}/u

/** HTTP basic auth (RFC 7617), UTF-8 encoded. */
export function basicAuth(params: BasicAuthParams): AuthApplier {
  const { username, password } = params
  if (username === '' || username.includes(':') || controlCharacter.test(username)) {
    throw new TypeError(
      'Basic auth username must be non-empty, without colons or control characters',
    )
  }
  if (controlCharacter.test(password)) {
    throw new TypeError('Basic auth password must not contain control characters')
  }
  const value = `Basic ${toB64(fromUTF(`${username}:${password}`))}`
  return ({ headers }) => {
    headers.set('authorization', value)
  }
}

export const noAuth: AuthApplier = () => {}
