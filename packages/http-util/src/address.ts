export function parseIPv4(text: string): Uint8Array | null {
  if (/[^0-9.]/.test(text)) return null
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const bytes = new Uint8Array(4)
  for (const [index, part] of parts.entries()) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return null
    bytes[index] = Number(part)
  }
  return bytes
}

export function parseIPv6(text: string): Uint8Array | null {
  let input = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  if (input.includes('%')) return null

  if (input.includes('.')) {
    const tailStart = input.lastIndexOf(':') + 1
    if (tailStart === 0) return null
    const tail = parseIPv4(input.slice(tailStart))
    if (tail === null) return null
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    const high = view.getUint16(0).toString(16)
    const low = view.getUint16(2).toString(16)
    input = `${input.slice(0, tailStart)}${high}:${low}`
  }

  if (/[^0-9a-f:]/i.test(input)) return null
  const sections = input.split('::')
  if (sections.length > 2) return null
  const [before = '', after = ''] = sections
  const left = before === '' ? [] : before.split(':')
  const right = after === '' ? [] : after.split(':')
  const groups = [...left, ...right]
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null
  if (sections.length === 1 ? groups.length !== 8 : groups.length >= 8) return null

  const expanded = [...left, ...Array<string>(8 - groups.length).fill('0'), ...right]
  const bytes = new Uint8Array(16)
  for (const [index, group] of expanded.entries()) {
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = value >> 8
    bytes[index * 2 + 1] = value & 0xff
  }
  return bytes
}

export function isIPLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null
}

function isPublicIPv4(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const second = view.getUint8(1)
  return !(
    bytes[0] === 0 ||
    bytes[0] === 10 ||
    bytes[0] === 127 ||
    view.getUint8(0) >= 224 ||
    (bytes[0] === 198 && (second === 18 || second === 19)) ||
    (bytes[0] === 172 && (second & 0xf0) === 16) ||
    (bytes[0] === 192 && bytes[1] === 168) ||
    (bytes[0] === 169 && bytes[1] === 254) ||
    (bytes[0] === 100 && (second & 0xc0) === 64)
  )
}

export function isPublicAddress(address: string): boolean {
  const ipv4 = parseIPv4(address)
  if (ipv4 !== null) return isPublicIPv4(ipv4)
  const ipv6 = parseIPv6(address)
  if (ipv6 === null) return false
  if (ipv6.slice(0, 10).every((byte) => byte === 0) && ipv6[10] === 255 && ipv6[11] === 255) {
    return isPublicIPv4(ipv6.subarray(12))
  }
  if (
    ipv6.slice(0, 12).every((byte) => byte === 0) ||
    (ipv6[0] === 0 &&
      ipv6[1] === 0x64 &&
      ipv6[2] === 0xff &&
      ipv6[3] === 0x9b &&
      ipv6.slice(4, 12).every((byte) => byte === 0))
  ) {
    return isPublicIPv4(ipv6.subarray(12))
  }
  const view = new DataView(ipv6.buffer, ipv6.byteOffset, ipv6.byteLength)
  return !(
    ipv6[0] === 0xff ||
    (view.getUint8(0) & 0xfe) === 0xfc ||
    (ipv6[0] === 0xfe && (view.getUint8(1) & 0xc0) === 0x80) ||
    (ipv6.slice(0, 15).every((byte) => byte === 0) && view.getUint8(15) <= 1)
  )
}

export function isLoopbackAddress(address: string): boolean {
  const ipv4 = parseIPv4(address)
  if (ipv4 !== null) return ipv4[0] === 127
  const ipv6 = parseIPv6(address)
  if (ipv6 === null) return false
  return ipv6.slice(0, 15).every((byte) => byte === 0) && ipv6[15] === 1
}
