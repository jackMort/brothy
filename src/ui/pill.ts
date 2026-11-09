// The chat pill's pure side: where the pill and its card sit, their frames, the chips and the input, the card's rows by
// stage, the `[[` list, the quote's tint, and the ink and steam steps every frame is drawn from. No React, no store.
import { fmtTokens } from "../ai/client"
import type { Chip, Part, Thread } from "../ai/thread"
import { A, type Span, safeLine } from "../lib/spans"
import { spanWidth, superscript, truncate, truncateLeft, width } from "../lib/text"
import type { Theme } from "../theme/theme"
import { chip, INK_MS, inkAt } from "./chrome"
import { CARET, footInk } from "./footnote"
import type { QuoteSpan } from "./nav"
import { STEAM_MS, STILL_TICK, steamRows } from "./welcome"

const PILL_W = 72
const PILL_H = 3
/** A chip's title is cut to this; the input keeps at least INPUT_MIN_W columns beside the chips. */
const CHIP_MAX_W = 16
const INPUT_MIN_W = 20

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

const pad = (n: number): Span => ({ text: " ".repeat(Math.max(0, n)) })
/** `l` and `r` with the gap between them, `w` wide. */
const right = (l: Span[], r: Span[], w: number): Span[] => [...l, pad(w - spanWidth(l) - spanWidth(r)), ...r]
/** `spans` cut or padded to exactly `w` columns. */
function fit(spans: Span[], w: number): Span[] {
  const out: Span[] = []
  let x = 0
  for (const s of spans) {
    if (x >= w) break
    const text = truncate(s.text, w - x)
    out.push({ ...s, text })
    x += width(text)
  }
  return x < w ? [...out, pad(w - x)] : out
}

/** A rounded box `w` wide around `content` (a blank column inside each side), every cell on `bg`; `foot` ends 2 columns before the bottom-right corner. */
export function frameRows(content: Span[][], w: number, border: string, bg: string, foot?: Span[]): Span[][] {
  const b = (text: string): Span => ({ text, fg: border })
  const top = [b(`╭${"─".repeat(w - 2)}╮`)]
  const mid = content.map((r) => [b("│ "), ...fit(r, w - 4), b(" │")])
  const fw = foot ? Math.min(spanWidth(foot), w - 4) : 0
  const bottom =
    foot && fw ? [b(`╰${"─".repeat(w - 4 - fw)}`), ...fit(foot, fw), b("──╯")] : [b(`╰${"─".repeat(w - 2)}╯`)]
  return [top, ...mid, bottom].map((r) => r.map((s) => ({ ...s, bg: s.bg ?? bg })))
}

/** ` ~3.1k tokens `: what `⏎` would send, for the pill's bottom border. */
export const sizeFoot = (t: Theme, size: number): Span[] => [{ text: ` ${fmtTokens(size)} `, fg: footInk(t).status }]

/** One chip: the first note secondary, the others accent, a clipped one's ` · clipped` muted. */
function oneChip(t: Theme, c: Chip, first: boolean, clipped: boolean): Span[] {
  const spans = chip(t, truncate(safeLine(c.title), CHIP_MAX_W), first ? t.secondary : t.accent)
  if (clipped) spans.splice(2, 0, { text: " · clipped", fg: t.textMuted, bg: t.backgroundElement })
  return spans
}

/** The chips in `room` columns; while they don't fit, the last ones fold into a `+n` chip. */
export function chipRow(t: Theme, chips: readonly Chip[], clipped: readonly string[], room: number): Span[] {
  for (let shown = chips.length; shown >= 1; shown--) {
    const parts = chips.slice(0, shown).map((c, i) => oneChip(t, c, i === 0, clipped.includes(c.path)))
    if (shown < chips.length) parts.push(chip(t, `+${chips.length - shown}`, t.textMuted))
    const row = parts.flatMap((p, i) => (i ? [{ text: " " }, ...p] : p))
    if (spanWidth(row) <= room) return row
  }
  return []
}

/** The input's tail and the caret in `room` columns; empty: the caret, then the muted placeholder. */
export function inputSpans(t: Theme, text: string, caret: boolean, room: number, placeholder: string): Span[] {
  const c = footInk(t)
  const cur: Span = { text: caret ? CARET : " ", fg: c.caret }
  if (!text) return [cur, { text: truncate(placeholder, room - 1), fg: c.status }]
  return [{ text: truncateLeft(safeLine(text), room - 1), fg: t.text }, cur]
}

/** Folded on a cite: `¹ “quote”`, and `1 of 3 · ] next` (`[ prev` at the last, the count alone for one). */
function citeRow(t: Theme, v: PillView, iw: number): Span[] {
  const c = footInk(t)
  const cites = v.thread.turns[v.land?.exchange ?? -1]?.cites ?? []
  const cite = cites.find((k) => k.n === v.land?.n)
  if (!cite) return []
  const last = cite.n === cites.length
  const tail: Span[] = [{ text: `${cite.n} of ${cites.length}`, fg: c.status }]
  if (cites.length > 1)
    tail.push(
      { text: " · ", fg: c.status },
      { text: last ? "[" : "]", fg: c.key },
      { text: last ? " prev" : " next", fg: c.word },
    )
  const mark = `${superscript(cite.n)} `
  const room = iw - spanWidth(tail) - width(mark) - 3
  return right(
    [
      { text: mark, fg: c.mark, attr: A.BOLD },
      { text: `“${truncate(safeLine(cite.quote), room)}”`, fg: c.note },
    ],
    tail,
    iw,
  )
}

/** The pill's middle row, `w − 4` wide: the wisp, the input or placeholder, the chips right; folded, the cite. */
export function pillRow(t: Theme, v: PillView, now: number, motion: boolean): Span[] {
  const iw = v.geo.w - 4
  if (v.land) return citeRow(t, v, iw)
  const tick = v.running ? steamTick(v.running.at, now, motion) : STILL_TICK
  const wisp: Span = { text: (steamRows(tick, 2, 1)[0] ?? "").replace(/ /g, "⠀"), fg: t.primary }
  const chips = chipRow(t, v.thread.chips, v.clipped, Math.max(0, iw - 4 - INPUT_MIN_W))
  const room = iw - 3 - spanWidth(chips) - (chips.length ? 1 : 0)
  const answered = v.thread.turns.some((e) => e.raw !== null)
  const placeholder = answered ? "ask a follow-up" : "ask about this note…"
  return right([wisp, pad(1), ...inputSpans(t, v.input, v.focus, room, placeholder)], chips, iw)
}

/** The pill's border: borderActive inked in from `openedAt` while it has focus; border when folded. */
export const pillBorder = (t: Theme, v: Pick<PillView, "focus" | "openedAt">, now: number, motion: boolean) =>
  v.focus ? inkAt(t, inkStep(v.openedAt, now, motion), t.borderActive) : t.border

/** The caret's column from the text column: where the `[[` list sits. */
export function caretCol(v: PillView): number {
  const iw = v.geo.w - 4
  return v.geo.x + 2 + 3 + Math.min(width(safeLine(v.input)), iw - 3 - INPUT_MIN_W)
}
