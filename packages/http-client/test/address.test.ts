import { expect, test } from 'vitest'

import {
  isIPLiteral,
  isLoopbackAddress,
  isPublicAddress,
  parseIPv4,
  parseIPv6,
} from '../src/address.js'

const refused = [
  '10.0.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '127.0.0.1',
  '127.255.255.254',
  '169.254.169.254',
  '100.64.0.1',
  '100.127.255.255',
  '0.0.0.0',
  '0.1.2.3',
  '::1',
  '::',
  '0:0:0:0:0:0:0:1',
  'fc00::1',
  'fd12:3456::1',
  'fe80::1',
  'febf::1',
  '::ffff:10.0.0.1',
  '::ffff:7f00:1',
  '::ffff:169.254.169.254',
  '[::1]',
  'fe80::1%en0',
  '01.2.3.4',
  '256.1.1.1',
  'not-an-ip',
  '',
]
const allowed = [
  '8.8.8.8',
  '172.15.255.255',
  '172.32.0.1',
  '100.63.255.255',
  '100.128.0.1',
  '192.169.0.1',
  '2001:4860:4860::8888',
  '::ffff:8.8.8.8',
  'fec0::1',
  '[2606:4700::1111]',
]

test.each(refused)('refuses %s', (address) => expect(isPublicAddress(address)).toBe(false))
test.each(allowed)('allows %s', (address) => expect(isPublicAddress(address)).toBe(true))

test('parses compressed IPv6 with an IPv4 tail', () => {
  expect(parseIPv6('::ffff:1.2.3.4')).toEqual(
    Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 1, 2, 3, 4]),
  )
})

test.each([
  '1::2::3',
  '1:2:3:4:5:6:7:8:9',
  'g::1',
  ':::',
  '',
  ':1',
  '1:',
  '1:2:3:4:5:6:7',
  '1:2:3:4:5:6:7:8::',
  '12345::',
  '::ffff:01.2.3.4',
  '::ffff:256.1.1.1',
  '1.2.3.4::',
  '::1.2.3.4:5',
  '[::1',
  '::1]',
  '[[::1]]',
  'fe80::1%en0',
  '[fe80::1%25en0]',
  ' ::1',
  '::1\n',
])('rejects malformed IPv6 %j', (text) => expect(parseIPv6(text)).toBeNull())

test.each([
  ['::', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['[::1]', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]],
  ['1:2:3:4:5:6:7:8', [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]],
  ['ABCD::EF01', [171, 205, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 239, 1]],
  ['1:2:3:4:5:6:1.2.3.4', [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 1, 2, 3, 4]],
] as Array<[string, Array<number>]>)('parses IPv6 %s into bytes', (text, bytes) => {
  expect(parseIPv6(text)).toEqual(Uint8Array.from(bytes))
})

test.each([
  '01.2.3.4',
  '256.1.1.1',
  '1.2.3',
  '1.2.3.4.5',
  '-1.2.3.4',
  '+1.2.3.4',
  '1e0.2.3.4',
  '0x1.2.3.4',
  ' 1.2.3.4',
  '1.2.3.4\n',
  '1..3.4',
  '',
])('rejects malformed IPv4 %j', (text) => expect(parseIPv4(text)).toBeNull())

test.each([
  ['0.1.2.3', [0, 1, 2, 3]],
  ['255.255.255.255', [255, 255, 255, 255]],
] as Array<[string, Array<number>]>)('parses IPv4 %s into bytes', (text, bytes) => {
  expect(parseIPv4(text)).toEqual(Uint8Array.from(bytes))
})

test.each(['127.9.9.9', '::1', '[::1]', '0:0:0:0:0:0:0:1'])('flags loopback %s', (text) => {
  expect(isLoopbackAddress(text)).toBe(true)
})
test.each(['10.0.0.1', '128.0.0.1', '::', '::ffff:127.0.0.1', 'localhost', 'garbage'])(
  'does not flag loopback %s',
  (text) => expect(isLoopbackAddress(text)).toBe(false),
)

test.each(['8.8.8.8', '127.0.0.1', '::', '[::1]', '::ffff:8.8.8.8'])(
  'recognises IP literal %s',
  (text) => expect(isIPLiteral(text)).toBe(true),
)
test.each(['localhost', 'example.com', '', '01.2.3.4', 'fe80::1%en0', '1::2::3'])(
  'rejects non-literal %j',
  (text) => expect(isIPLiteral(text)).toBe(false),
)

test.each([
  ['9.255.255.255', true],
  ['11.0.0.0', true],
  ['126.255.255.255', true],
  ['128.0.0.0', true],
  ['169.253.255.255', true],
  ['169.255.0.0', true],
  ['192.167.255.255', true],
  ['192.169.0.0', true],
  ['fbff::1', true],
  ['fe7f::1', true],
  ['fec0::', true],
  ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
  ['febf:ffff::', false],
  ['::ffff:172.16.0.1', false],
  ['::ffff:192.168.1.1', false],
  ['::ffff:100.64.0.1', false],
  ['::ffff:0.1.2.3', false],
  ['::ffff:808:808', true],
  ['::fffe:10.0.0.1', true],
] as Array<[string, boolean]>)('classifies boundary or mapped address %s', (text, expected) => {
  expect(isPublicAddress(text)).toBe(expected)
})
