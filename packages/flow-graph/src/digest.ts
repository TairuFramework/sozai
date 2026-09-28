import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { canonicalizeJSON, type JSONValue } from '@sozai/json'

export function digestDefinition(value: JSONValue): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeJSON(value))))
}
