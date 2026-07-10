import { map, transform } from './transform.js'

const SEPARATOR = '\n'

export class JSONLinesError extends Error {}

export type DecodeJSON<T = unknown> = (value: string) => T

/**
 * Size limits for the JSON-lines framer, measured in characters (UTF-16 code
 * units), not bytes.
 *
 * - `maxBufferSize` bounds total live framer memory (the un-terminated input
 *   buffer plus the partially-accumulated message). A stream that exceeds it
 *   errors, preventing unbounded growth from malformed or malicious input.
 * - `maxMessageSize` is an optional tighter cap on a single decoded message.
 */
export type FramingLimits = {
  maxBufferSize?: number
  maxMessageSize?: number
}

export type FromJSONLinesOptions<T = unknown> = FramingLimits & {
  decode?: DecodeJSON<unknown>
  onInvalidJSON?: (value: string, controller: TransformStreamDefaultController<T>) => void
}

function defaultOnInvalidJSON(value: string): void {
  const preview = value.length > 200 ? `${value.slice(0, 200)}…` : value
  console.warn(`Invalid JSON line dropped: ${preview}`)
}

export function fromJSONLines<T = unknown>(
  options: FromJSONLinesOptions<T> = {},
): TransformStream<Uint8Array | string, T> {
  const {
    decode = JSON.parse,
    maxBufferSize,
    maxMessageSize,
    onInvalidJSON = defaultOnInvalidJSON,
  } = options

  const decoder = new TextDecoder()
  let input = ''
  let output: Array<string> = []
  let nestingDepth = 0
  let isInString = false
  let isEscapingChar = false
  // Whether `output` holds any non-whitespace character. Replaces `output.length > 0` as the
  // emit condition now that whitespace is retained, so blank lines stay silently ignored.
  let hasContent = false

  function resetFramer(): void {
    output = []
    nestingDepth = 0
    isInString = false
    isEscapingChar = false
    hasContent = false
  }

  /** Returns false when the character unbalances the framer beyond recovery. */
  function processChar(char: string): boolean {
    if (isInString) {
      if (char === '\\') {
        isEscapingChar = !isEscapingChar
      } else {
        if (char === '"' && !isEscapingChar) {
          isInString = false
        }
        isEscapingChar = false
      }
      output.push(char)
      return true
    }
    switch (char) {
      case '"':
        isInString = true
        hasContent = true
        output.push(char)
        return true
      case '{':
      case '[':
        nestingDepth++
        hasContent = true
        output.push(char)
        return true
      case '}':
      case ']':
        output.push(char)
        if (nestingDepth === 0) {
          // A closing bracket with nothing open. Everything accumulated is garbage.
          return false
        }
        nestingDepth--
        return true
      default:
        output.push(char)
        // Whitespace is retained but does not make a message worth emitting.
        // charCode comparison instead of a regex.
        if (char.charCodeAt(0) > 32) {
          hasContent = true
        }
        return true
    }
  }

  function emit(controller: TransformStreamDefaultController<T>): void {
    const value = output.join('')
    resetFramer()
    try {
      controller.enqueue(decode(value))
    } catch {
      onInvalidJSON(value, controller)
    }
  }

  function invalidate(controller: TransformStreamDefaultController<T>): void {
    const value = output.join('')
    resetFramer()
    onInvalidJSON(value, controller)
  }

  /**
   * Feed one framed line through the state machine.
   *
   * Returns false when the line corrupted the framer, in which case the accumulated message
   * has already been reported to `onInvalidJSON` and the state reset. The remainder of a
   * corrupt line is captured verbatim so the report shows what actually arrived.
   */
  function feedLine(line: string, controller: TransformStreamDefaultController<T>): boolean {
    let corrupt = false
    for (const char of line) {
      if (corrupt) {
        output.push(char)
      } else if (!processChar(char)) {
        corrupt = true
      }
    }
    if (corrupt) {
      invalidate(controller)
      return false
    }
    return true
  }

  function checkOutputSize(): void {
    if (maxMessageSize != null && output.length > maxMessageSize) {
      throw new JSONLinesError(
        `Message size ${output.length} exceeds maximum message size of ${maxMessageSize}`,
      )
    }
  }

  function checkBufferSize(): void {
    if (maxBufferSize != null && input.length + output.length > maxBufferSize) {
      throw new JSONLinesError(
        `Buffer size ${input.length + output.length} exceeds maximum buffer size of ${maxBufferSize}`,
      )
    }
  }

  return transform<Uint8Array | string, T>(
    (chunk, controller) => {
      try {
        input += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
        checkBufferSize()
        let newLineIndex = input.indexOf(SEPARATOR)
        while (newLineIndex !== -1) {
          const line = input.slice(0, newLineIndex)
          input = input.slice(newLineIndex + SEPARATOR.length)
          if (feedLine(line, controller)) {
            checkBufferSize()
            if (nestingDepth === 0 && !isInString && hasContent) {
              checkOutputSize()
              emit(controller)
            } else if (isInString) {
              // Retained for now; Task 7 replaces this with rejection
              output.push('\\n')
            } else if (nestingDepth === 0) {
              // Whitespace-only line: clear it so it cannot carry into the next message
              resetFramer()
            }
          }
          newLineIndex = input.indexOf(SEPARATOR)
        }
      } catch (cause) {
        if (cause instanceof JSONLinesError) {
          throw cause
        }
        controller.error(new JSONLinesError('Error processing chunk', { cause }))
      }
    },
    (controller) => {
      // No checkBufferSize() here: every chunk already passed the cap in the
      // transform callback, and flush only appends the decoder's pending
      // multibyte remainder (bounded) before emitting the final buffered value.
      input += decoder.decode()
      if (feedLine(input, controller) && nestingDepth === 0 && !isInString && hasContent) {
        checkOutputSize()
        emit(controller)
      }
    },
  )
}

export type EncodeJSON<T = unknown> = (value: T) => string

function safeStringify<T>(value: T): string {
  try {
    const result = JSON.stringify(value)
    if (result === undefined) {
      throw new Error('JSON.stringify returned undefined')
    }
    return result
  } catch (error) {
    throw new JSONLinesError(
      `Failed to stringify value: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

export function toJSONLines<T = unknown>(
  encode: EncodeJSON<T> = safeStringify,
): TransformStream<T, string> {
  return map((value) => {
    try {
      return encode(value) + SEPARATOR
    } catch (cause) {
      throw cause instanceof JSONLinesError
        ? cause
        : new JSONLinesError('Error encoding value', { cause })
    }
  })
}
