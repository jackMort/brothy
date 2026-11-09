// The chat pill's pure side: where the pill and its card sit, their frames, the chips and the input, the card's rows by
// stage, the `[[` list, the quote's tint, and the ink and steam steps every frame is drawn from. No React, no store.
import type { Part, Thread } from "../ai/thread"
import type { Span } from "../lib/spans"
import { INK_MS } from "./chrome"
import type { QuoteSpan } from "./nav"
import { STEAM_MS, STILL_TICK } from "./welcome"

const PILL_W = 72
const PILL_H = 3

/** What the footer follows. */
type ChatStage = "input" | "pick" | "waiting" | "answer" | "error"
/** One delta: the cleaned reply's length after it, and when it came. */
interface Arrival {
  len: number
  at: number
}
/**
 * Relative to the text column: the pill's left and width, its first row, and the card's most rows. `cardMax` is the
 * card's TOTAL height, its two border rows included (CH − pill 3 − the gap row − one row kept at the top); a window of
 * content takes `cardMax − 2`.
 */
interface PillGeo {
  x: number
  w: number
  top: number
  cardMax: number
}
interface PickItem {
  path: string
  name: string
  linked: boolean
}
/** The exchange in flight: its answer so far, arrivals, start, whether text came, the model and its seconds. */
interface Running {
  parts: Part[]
  arrivals: readonly Arrival[]
  at: number
  live: boolean
  model: string
  secs: number
}
/** The card's rows and its cite stops (`cite`: exchange index, n; `row`: in `rows`). */
interface CardOut {
  rows: Span[][]
  stops: { cite: [number, number]; row: number }[]
}
/** The pill as derive builds it (`app/derive/pill.ts`); null while hidden. */
export interface PillView {
  path: string
  focus: boolean
  card: boolean
  input: string
  thread: Thread
  running: Running | null
  hl: [number, number] | null
  top: number | null
  pick: { q: string; hl: number; items: PickItem[] } | null
  land: { exchange: number; n: number; path: string; at: number } | null
  openedAt: number
  geo: PillGeo
  /** tokens `⏎` would send */
  size: number
  /** the chips `⏎` would clip */
  clipped: readonly string[]
  /** per exchange, per cite: where it is (`citeWhere`) */
  wheres: readonly (readonly string[])[]
  stage: ChatStage
  /** the folded cite's quote in the view on screen */
  quote: QuoteSpan | null
  cardOut: CardOut | null
}

export function pillGeo(L: { CW: number; CH: number }): PillGeo {
  const w = Math.min(PILL_W, L.CW)
  return { x: Math.floor((L.CW - w) / 2), w, top: L.CH - PILL_H, cardMax: L.CH - PILL_H - 2 }
}

export function chatStage(v: Pick<PillView, "pick" | "running" | "card" | "thread">): ChatStage {
  if (v.pick) return "pick"
  if (v.running) return "waiting"
  const last = v.thread.turns.at(-1)
  if (!v.card || !last) return "input"
  return last.error ? "error" : "answer"
}

/** 0–3: INK_MS steps since `since`; 3 with motion off. */
export const inkStep = (since: number, now: number, motion: boolean) =>
  motion ? Math.max(0, Math.min(3, Math.floor((now - since) / INK_MS))) : 3

/** The ink step of answer character `i`: that of the delta it arrived in; past the log, full. */
export function charInk(arrivals: readonly Arrival[], i: number, now: number, motion: boolean): number {
  const a = arrivals.find((x) => x.len > i)
  return a ? inkStep(a.at, now, motion) : 3
}

/** The steam frame `now`; STILL_TICK with motion off. */
export const steamTick = (at: number, now: number, motion: boolean) =>
  motion ? Math.floor((now - at) / STEAM_MS) : STILL_TICK
