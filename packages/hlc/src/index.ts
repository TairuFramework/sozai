export type HLCTimestamp = {
  wallTime: number
  counter: number
  nodeID: string
}

type HLCParams = {
  nodeID: string
  // Test seam: lower the counter ceiling to exercise the clamp branch without
  // 1e8 calls. Capped at the real ceiling so it can only narrow, never widen
  // past the serialization pad. Omit in production.
  counterCeiling?: number
  // Runs before every local mint. Throwing here vetoes the mint (the caller
  // gets the throw) without touching `receive`: lets a holder gate its own
  // clock's authorship while still advancing it on peer input.
  beforeMint?: () => void
}

// The serialized counter is fixed-width zero-padded so that lexicographic string
// order matches numeric order. The pad width therefore caps the counter: any value
// reaching this ceiling would emit an extra digit and silently break that ordering.
const COUNTER_PAD = 8
const COUNTER_CEILING = 1e8

export class HLC {
  #nodeID: string
  #lastWallTime = 0
  #lastCounter = 0
  #counterCeiling: number
  #beforeMint?: () => void

  constructor(params: HLCParams) {
    this.#nodeID = params.nodeID
    this.#counterCeiling = Math.min(params.counterCeiling ?? COUNTER_CEILING, COUNTER_CEILING)
    this.#beforeMint = params.beforeMint
  }

  get nodeID(): string {
    return this.#nodeID
  }

  // Apply a candidate counter at the current wall time. If it would reach the
  // serialization ceiling, advance the wall time by 1ms and reset the counter to 0
  // instead of emitting a 9th digit. This keeps the result strictly greater than the
  // previous timestamp (counter ceiling < a +1ms wall time) while preserving the
  // lexicographic == numeric ordering invariant.
  #applyCounter(candidate: number): void {
    if (candidate >= this.#counterCeiling) {
      this.#lastWallTime += 1
      this.#lastCounter = 0
    } else {
      this.#lastCounter = candidate
    }
  }

  now(): HLCTimestamp {
    this.#beforeMint?.()
    const physicalTime = Date.now()
    if (physicalTime > this.#lastWallTime) {
      this.#lastWallTime = physicalTime
      this.#lastCounter = 0
    } else {
      this.#applyCounter(this.#lastCounter + 1)
    }
    return { wallTime: this.#lastWallTime, counter: this.#lastCounter, nodeID: this.#nodeID }
  }

  receive(remote: HLCTimestamp): HLCTimestamp {
    const physicalTime = Date.now()
    if (physicalTime > this.#lastWallTime && physicalTime > remote.wallTime) {
      this.#lastWallTime = physicalTime
      this.#lastCounter = 0
    } else if (remote.wallTime > this.#lastWallTime) {
      this.#lastWallTime = remote.wallTime
      this.#applyCounter(remote.counter + 1)
    } else if (this.#lastWallTime > remote.wallTime) {
      this.#applyCounter(this.#lastCounter + 1)
    } else {
      this.#applyCounter(Math.max(this.#lastCounter, remote.counter) + 1)
    }
    return { wallTime: this.#lastWallTime, counter: this.#lastCounter, nodeID: this.#nodeID }
  }

  static serialize(ts: HLCTimestamp): string {
    const iso = new Date(ts.wallTime).toISOString()
    const counter = ts.counter.toString().padStart(COUNTER_PAD, '0')
    return `${iso}:${counter}:${ts.nodeID}`
  }

  static parse(s: string): HLCTimestamp {
    const zIndex = s.indexOf('Z')
    const wallTime = new Date(s.slice(0, zIndex + 1)).getTime()
    const rest = s.slice(zIndex + 2)
    const colonIndex = rest.indexOf(':')
    const counter = Number.parseInt(rest.slice(0, colonIndex), 10)
    const nodeID = rest.slice(colonIndex + 1)
    return { wallTime, counter, nodeID }
  }

  /**
   * Parse a stamp that arrived from somewhere else, or answer `null`.
   *
   * `parse` never throws and never returns a uniformly-NaN record: a string with
   * no `Z` yields a NaN wall time beside a counter that may still parse, so a
   * caller checking one field admits the other. Every field is checked here, and
   * anything a peer sends has to come through this rather than `parse` —
   * `receive` assigns NaN straight into the clock, and the drift bound is blind
   * to it because every comparison against NaN is false.
   */
  static tryParse(s: string): HLCTimestamp | null {
    const ts = HLC.parse(s)
    return Number.isFinite(ts.wallTime) && Number.isFinite(ts.counter) && ts.nodeID !== ''
      ? ts
      : null
  }

  static compare(a: HLCTimestamp, b: HLCTimestamp): number {
    if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime
    if (a.counter !== b.counter) return a.counter - b.counter
    return a.nodeID < b.nodeID ? -1 : a.nodeID > b.nodeID ? 1 : 0
  }
}
