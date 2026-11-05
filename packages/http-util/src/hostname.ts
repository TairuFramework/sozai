import { isLoopbackAddress } from './address.js'

/** A URL's hostname in lower case, without one trailing dot or IPv6 brackets. */
export function normalizeHostname(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
}

/** Whether a hostname is `localhost` or a literal loopback address. Does not resolve DNS. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname.toLowerCase() === 'localhost' || isLoopbackAddress(hostname)
}
