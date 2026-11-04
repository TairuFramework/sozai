import type { HTTPClientErrorCode, HTTPClientErrorParams, HTTPResponse } from './types.js'

export class HTTPClientError extends Error {
  #code: HTTPClientErrorCode
  #sent: boolean
  #status?: number
  #retryAfterMS?: number
  #response?: HTTPResponse

  constructor(params: HTTPClientErrorParams) {
    super(params.message ?? params.code, { cause: params.cause })
    this.name = 'HTTPClientError'
    this.#code = params.code
    this.#sent = params.sent
    this.#status = params.status
    this.#retryAfterMS = params.retryAfterMS
    this.#response = params.response
  }

  get code(): HTTPClientErrorCode {
    return this.#code
  }

  get sent(): boolean {
    return this.#sent
  }

  get status(): number | undefined {
    return this.#status
  }

  get retryAfterMS(): number | undefined {
    return this.#retryAfterMS
  }

  get response(): HTTPResponse | undefined {
    return this.#response
  }
}
