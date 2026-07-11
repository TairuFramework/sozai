/**
 * Web streams utilities for Sozai transports.
 *
 * ## Installation
 *
 * ```sh
 * npm install @sozai/stream
 * ```
 *
 * @module stream
 */

// `createChannel` stays internal — `createPipe` and `createConnection` are the supported
// arrangements of it. Its options type is public because it appears in both their signatures.
export type { ChannelOptions } from './channel.js'
export * from './connection.js'
export * from './json-lines.js'
export * from './pipe.js'
export * from './readable.js'
export * from './transform.js'
export * from './writable.js'
