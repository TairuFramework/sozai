import type { AuthApplier } from './types.js'

export function bearerAuth(token: string | (() => string | Promise<string>)): AuthApplier {
  return async ({ headers }) => {
    const value = typeof token === 'function' ? await token() : token
    headers.set('authorization', `Bearer ${value}`)
  }
}

export function apiKeyAuth(params: {
  in: 'header' | 'query'
  name: string
  value: string
}): AuthApplier {
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

export const noAuth: AuthApplier = () => {}
