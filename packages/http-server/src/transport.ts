import type { Context } from 'hono'

/** Socket transport facts, independent of request headers and URL. */
export type TransportInfo = {
  secure: boolean
  localAddress: string | null
  remoteAddress: string | null
}

type TransportEnv = {
  incoming?: {
    socket?: {
      encrypted?: boolean
      localAddress?: string
      remoteAddress?: string
    }
  }
}

/** Read transport facts from the server socket, or undefined when no socket exists. */
export function transportInfo(c: Context): TransportInfo | undefined {
  const socket = (c.env as TransportEnv | undefined)?.incoming?.socket
  if (socket == null) return undefined
  return {
    secure: socket.encrypted === true,
    localAddress: socket.localAddress ?? null,
    remoteAddress: socket.remoteAddress ?? null,
  }
}

/** Recognize localhost and IPv4, IPv6, or mapped IPv4 loopback addresses. */
export function isLoopbackAddress(address: string | null): boolean {
  if (address == null) return false
  if (address === 'localhost') return true
  if (/^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)) {
    return address.split('.').every((part) => Number(part) <= 255)
  }
  try {
    const host = new URL(`http://[${address}]`).hostname
    // URL canonicalisation also covers expanded IPv6 and dotted mapped IPv4.
    return host === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
  } catch {
    return false
  }
}

/** Accept encrypted transport or a connection with both ends on loopback. */
export function isSecureTransport(info: TransportInfo | undefined): boolean {
  return (
    info !== undefined &&
    (info.secure === true ||
      (isLoopbackAddress(info.localAddress) && isLoopbackAddress(info.remoteAddress)))
  )
}
