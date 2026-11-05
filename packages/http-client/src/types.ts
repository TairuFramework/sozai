import type { Fetch } from '@sozai/runtime'

export type AuthTarget = { url: URL; headers: Headers }
export type AuthApplier = (request: AuthTarget) => void | Promise<void>

export type BearerTokenProvider = () => string | Promise<string>
export type BearerToken = string | BearerTokenProvider
export type APIKeyAuthParams = { in: 'header' | 'query'; name: string; value: string }
export type BasicAuthParams = { username: string; password: string }

export type HTTPRetryPolicy = { attempts: number; baseDelayMS: number; maxDelayMS: number }
export type RateLimit = { requests: number; perMS: number }

export type RequestPolicy = {
  origins: Array<string>
  timeoutMS?: number
  maxResponseBytes?: number
  maxRedirects?: number
  retry?: HTTPRetryPolicy
  rateLimit?: RateLimit
  allowInsecureLoopback?: boolean
}

export type ResolveHostOptions = { signal?: AbortSignal }
export type ResolveHost = (hostname: string, options?: ResolveHostOptions) => Promise<Array<string>>

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export type HTTPClientParams = {
  policy: RequestPolicy
  auth?: AuthApplier
  fetch?: Fetch
  resolveHost?: ResolveHost
  sleep?: Sleep
}

export type HTTPRequest = {
  method?: string
  url: string | URL
  headers?: Record<string, string>
  json?: unknown
  body?: string | Uint8Array
  idempotent?: boolean
  signal?: AbortSignal
}

export type HTTPResponse = {
  status: number
  statusText: string
  ok: boolean
  headers: Headers
  url: string
  bytes(): Uint8Array
  text(): string
  json<T>(): T
}

export type HTTPClient = {
  request(request: HTTPRequest): Promise<HTTPResponse>
  json<T>(request: HTTPRequest): Promise<T>
}

export type HTTPClientErrorCode =
  | 'INSECURE_URL'
  | 'ORIGIN_REFUSED'
  | 'ADDRESS_REFUSED'
  | 'TOO_MANY_REDIRECTS'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK'
  | 'RESPONSE_TOO_LARGE'
  | 'STATUS'

export type HTTPClientErrorParams = {
  code: HTTPClientErrorCode
  sent: boolean
  message?: string
  status?: number
  retryAfterMS?: number
  response?: HTTPResponse
  cause?: unknown
}
