// The chat pill's pure side: where the pill and its card sit, their frames, the chips and the input, the card's rows by
// stage, the `[[` list, the quote's tint, and the ink and steam steps every frame is drawn from. No React, no store.
import { fmtTokens } from "../ai/client"
import type { Chip, Exchange, Part, Thread } from "../ai/thread"
import { A, type Span, safeLine } from "../lib/spans"
import { mergeSpans, spanWidth, superscript, truncate, truncateLeft, width, wrap } from "../lib/text"
import type { Rendered } from "../markdown/render"
import { mix, type Theme } from "../theme/theme"
import { chip, INK_MS, inkAt, steamColors } from "./chrome"
import { CARET, footInk, footnoteRule, type Tail, waitText } from "./footnote"
import type { QuoteSpan } from "./nav"
import { STEAM_MS, STILL_TICK, steamRows } from "./welcome"

const PILL_W = 72
const PILL_H = 3
/** The body rows the pill takes from the bottom while it shows: itself and the clear row above it. */
export const PILL_ROOM = PILL_H + 1
/** A chip's title is cut to this; the input keeps at least INPUT_MIN_W columns beside the chips. */
const CHIP_MAX_W = 16
const INPUT_MIN_W = 20
/** The thinking card's steam field. */
const CARD_STEAM_W = 14
const CARD_STEAM_H = 3
/** An error shows at most this many rows. */
const ERROR_ROWS = 3
/** The `[[` list: its width (a frame's inner width is PICK_W − 4) and most rows. */
const PICK_W = 36
export const PICK_ROWS = 5
const PICK_MARK = 2
const PICK_HINT = "  linked from here"

/** What the footer follows. */
export type ChatStage = "input" | "pick" | "waiting" | "answer" | "error"
/** One delta: the cleaned reply's length after it, and when it came. */
export interface Arrival {
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
export interface PickItem {
  path: string
  name: string
  linked: boolean
}
/** The exchange in flight: its answer so far, arrivals, start, whether text came, the model and its seconds. */
export interface Running {
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
  if (!clipped) return spans
  const tail = spans.pop()
  return [...spans, { text: " · clipped", fg: t.textMuted, bg: t.backgroundElement }, ...(tail ? [tail] : [])]
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

/** The typing row's pieces, shared by the row and the caret so they cannot disagree: chips and the input's room. */
function typingLayout(t: Theme, v: PillView) {
  const iw = v.geo.w - 4
  const chips = chipRow(t, v.thread.chips, v.clipped, Math.max(0, iw - 4 - INPUT_MIN_W))
  const room = iw - 3 - spanWidth(chips) - (chips.length ? 1 : 0)
  return { iw, chips, room }
}

/** The pill's middle row, `w − 4` wide: the wisp, the input or placeholder, the chips right; folded, the cite. */
export function pillRow(t: Theme, v: PillView, now: number, motion: boolean): Span[] {
  if (v.land) return citeRow(t, v, v.geo.w - 4)
  const { iw, chips, room } = typingLayout(t, v)
  const tick = v.running ? steamTick(v.running.at, now, motion) : STILL_TICK
  const wisp: Span = { text: (steamRows(tick, 2, 1)[0] ?? "").replace(/ /g, "⠀"), fg: t.primary }
  const answered = v.thread.turns.some((e) => e.raw !== null)
  const placeholder = answered ? "ask a follow-up" : "ask about this note…"
  return right([wisp, pad(1), ...inputSpans(t, v.input, v.focus, room, placeholder)], chips, iw)
}

/** The pill's border: borderActive inked in from `openedAt` while it has focus; border when folded. */
export const pillBorder = (t: Theme, v: Pick<PillView, "focus" | "openedAt">, now: number, motion: boolean) =>
  v.focus ? inkAt(t, inkStep(v.openedAt, now, motion), t.borderActive) : t.border

/** The caret's column from the text column (where `[[` anchors its list): after the wisp and the input as pillRow draws it. */
export function caretCol(t: Theme, v: PillView): number {
  const { room } = typingLayout(t, v)
  const shown = inputSpans(t, v.input, true, room, "")[0]
  return v.geo.x + 2 + 3 + (v.input ? width(shown?.text ?? "") : 0)
}

type CardView = Pick<PillView, "running" | "hl" | "wheres">
/** One exchange's rows and its cite stops, the stops' rows relative to the exchange. */
interface Made {
  rows: Span[][]
  stops: CardOut["stops"]
}
/** What every stage draws with. */
interface Cx {
  t: Theme
  w: number
  now: number
  motion: boolean
}

/** `› question`, bold, a 2-column hang. */
const questionRows = (t: Theme, q: string, w: number) =>
  wrap([{ text: safeLine(q), fg: t.text, attr: A.BOLD }], w, [{ text: "› ", fg: t.primary }], [pad(2)])

/** The rule under an answer, indented 2. */
const ruleRow = (t: Theme, w: number, tail: Tail | null): Span[] => [pad(2), ...footnoteRule(t, w - 2, tail)]

/** No text yet: steam rising, centred, and `asking <model> · N s` under it. */
function thinkingRows(c: Cx, r: Running): Span[][] {
  const cols = steamColors(c.t).slice(-CARD_STEAM_H)
  const centre = (s: Span[]): Span[] => [pad(Math.floor((c.w - spanWidth(s)) / 2)), ...s]
  const field = steamRows(steamTick(r.at, c.now, c.motion), CARD_STEAM_W, CARD_STEAM_H)
  const steam = field.map((s, i) => centre([{ text: s.replace(/ /g, "⠀"), fg: cols[i] }]))
  return [...steam, centre([{ text: waitText(r.model, r.secs, c.w), fg: footInk(c.t).status }])]
}

/** A mark as a superscript: `fg`, bold on backgroundElement when selected. */
const markSpan = (t: Theme, n: number, fg: string, sel: boolean): Span =>
  sel ? { text: superscript(n), fg, attr: A.BOLD, bg: t.backgroundElement } : { text: superscript(n), fg }

/** Streaming parts: each character inked by its arrival, marks muted, then the caret. */
function streamSpans(c: Cx, r: Running): Span[] {
  const out: Span[] = []
  let pos = 0
  for (const p of r.parts) {
    if (typeof p === "number") {
      out.push({ text: superscript(p), fg: c.t.textMuted })
      pos += String(p).length + 2
      continue
    }
    for (const ch of safeLine(p))
      out.push({ text: ch, fg: inkAt(c.t, charInk(r.arrivals, pos++, c.now, c.motion), c.t.text) })
  }
  return mergeSpans([...out, { text: CARET, fg: footInk(c.t).caret }])
}

/** A finished answer: text in `text`, marks glowing in from `doneAt`, the selected one bold. */
function answerSpans(c: Cx, e: Exchange, sel: number | null): Span[] {
  const glow = inkAt(c.t, inkStep(e.doneAt ?? 0, c.now, c.motion), c.t.primary)
  return mergeSpans(
    e.parts.map((p) =>
      typeof p === "number" ? markSpan(c.t, p, glow, p === sel) : { text: safeLine(p), fg: c.t.text },
    ),
  )
}

/** One row per cite (wrapped under its text), `▌` on the selected; their first rows as offsets. */
function citeRows(t: Theme, cites: Exchange["cites"], wheres: readonly string[], sel: number | null, w: number) {
  const ink = footInk(t)
  const rows: Span[][] = []
  const at: number[] = []
  cites.forEach((k, i) => {
    at.push(rows.length)
    const body: Span[] = [
      { text: `${safeLine(wheres[i] ?? "")} · `, fg: ink.status },
      { text: `“${safeLine(k.quote)}”`, fg: ink.note },
    ]
    wrap(body, w - 4).forEach((r, j) => {
      const cur: Span = k.n === sel && j === 0 ? { text: "▌ ", fg: t.primary } : pad(2)
      const mark: Span = j ? pad(2) : { text: `${superscript(k.n)} `, fg: ink.mark, attr: k.n === sel ? A.BOLD : 0 }
      rows.push([cur, mark, ...r])
    })
  })
  return { rows, at }
}

/** The rule's tail for a finished answer: `↑↓ ⏎ go to · <model>` with marks, the model alone without. */
const answerTail = (e: Exchange): Tail =>
  e.cites.length
    ? { status: e.model, model: e.model, key: "↑↓ ⏎", word: "go to", keyFirst: true }
    : { status: e.model, model: e.model }

const thinkingExchange = (c: Cx, head: Span[][], r: Running): Made => ({
  rows: [...head, ...thinkingRows(c, r)],
  stops: [],
})

function streamingExchange(c: Cx, head: Span[][], r: Running): Made {
  const tail: Tail = { status: `${r.model} · ${r.secs} s`, model: r.model, key: "esc", word: "cancel", drop: "status" }
  return { rows: [...head, ...wrap(streamSpans(c, r), c.w, [pad(2)]), [], ruleRow(c.t, c.w, tail)], stops: [] }
}

function errorExchange(c: Cx, head: Span[][], error: string): Made {
  const msg: Span[] = [
    { text: "✗ ", fg: c.t.error },
    { text: safeLine(error), fg: c.t.error },
  ]
  const err = wrap(msg, c.w, [pad(2)], [pad(4)]).slice(0, ERROR_ROWS)
  return { rows: [...head, ...err, [], ruleRow(c.t, c.w, { key: "⏎", word: "retry" })], stops: [] }
}

function answerExchange(c: Cx, head: Span[][], e: Exchange, i: number, view: CardView): Made {
  const sel = view.hl?.[0] === i ? view.hl[1] : null
  const body = [...head, ...wrap(answerSpans(c, e, sel), c.w, [pad(2)]), [], ruleRow(c.t, c.w, answerTail(e))]
  const cites = citeRows(c.t, e.cites, view.wheres[i] ?? [], sel, c.w)
  const stops = cites.at.map((k, j) => ({ cite: [i, j + 1] as [number, number], row: body.length + k }))
  return { rows: [...body, ...cites.rows], stops }
}

/** One exchange by its stage: thinking, streaming, error or answer. */
function exchangeRows(c: Cx, e: Exchange, i: number, view: CardView): Made {
  const head = [...questionRows(c.t, e.q, c.w), []]
  const r = e.raw === null && !e.error ? view.running : null
  if (r) return r.live ? streamingExchange(c, head, r) : thinkingExchange(c, head, r)
  if (e.error) return errorExchange(c, head, e.error)
  return answerExchange(c, head, e, i, view)
}

/** The whole thread, oldest first, a blank row between exchanges; the cite stops by row. `w` is the card's inner width. */
export function cardRows(t: Theme, thread: Thread, view: CardView, w: number, now: number, motion: boolean): CardOut {
  const c: Cx = { t, w, now, motion }
  const out: CardOut = { rows: [], stops: [] }
  thread.turns.forEach((e, i) => {
    if (i) out.rows.push([])
    const x = exchangeRows(c, e, i, view)
    out.stops.push(...x.stops.map((s) => ({ ...s, row: s.row + out.rows.length })))
    out.rows.push(...x.rows)
  })
  return out
}

/** The rows on screen: from `top`, or pinned to the bottom (null); `below` counts the rows under them. */
export function cardWindow(
  rows: Span[][],
  max: number,
  top: number | null,
): { rows: Span[][]; top: number; below: number } {
  const bottom = Math.max(0, rows.length - max)
  const from = top === null ? bottom : Math.max(0, Math.min(top, bottom))
  return { rows: rows.slice(from, from + max), top: from, below: Math.max(0, rows.length - from - max) }
}

/** ` ↓ n more ` for the card's bottom border while it is scrolled up. */
export const cardFoot = (t: Theme, below: number): Span[] | undefined =>
  below ? [{ text: ` ↓ ${below} more `, fg: footInk(t).status }] : undefined

/** The `[[` list's rows: at most PICK_ROWS names, the highlight `▌` and bold on backgroundElement, `linked from here` muted. */
export function pickRows(t: Theme, items: readonly PickItem[], hl: number): Span[][] {
  const c = footInk(t)
  const nameW = PICK_W - 4 - PICK_MARK - width(PICK_HINT)
  return items.slice(0, PICK_ROWS).map((it, i) => {
    const sel = i === hl
    const row: Span[] = [
      sel ? { text: "▌ ", fg: t.primary } : pad(PICK_MARK),
      { text: truncate(safeLine(it.name), nameW), fg: sel ? t.text : c.other, attr: sel ? A.BOLD : 0 },
      ...(it.linked ? [{ text: PICK_HINT, fg: c.status }] : []),
    ]
    return sel ? row.map((s) => ({ ...s, bg: t.backgroundElement })) : row
  })
}

/** `spans` with columns `from..to` on `bg`; columns are UTF-16 offsets into the row's text, as `quoteSpan` gives them. */
export function tintSpans(spans: Span[], from: number, to: number, bg: string): Span[] {
  const out: Span[] = []
  let x = 0
  for (const s of spans) {
    const len = s.text.length
    const a = Math.max(0, Math.min(len, from - x))
    const b = Math.max(a, Math.min(len, to - x))
    if (a > 0) out.push({ ...s, text: s.text.slice(0, a) })
    if (b > a) out.push({ ...s, text: s.text.slice(a, b), bg })
    if (b < len) out.push({ ...s, text: s.text.slice(b) })
    x += len
  }
  return out
}

/** The quote's tint at ink step `step`: backgroundElement fading in from the background. */
export const tintBg = (t: Theme, step: number) => mix(t.backgroundElement, t.background, 1 - step / 3)

/** The rows a cite's quote is looked for in: its section (Preview: heading to heading, the lead-in from 0); Source from the cite's row. */
export function citeRange(
  view: Pick<Rendered, "headings" | "lines" | "srcRow">,
  source: boolean,
  index: number,
  line: number,
): { from: number; to: number } {
  const to = view.headings[index + 1]?.line ?? view.lines.length
  if (source) return { from: view.srcRow?.[line] ?? 0, to }
  return { from: index < 0 ? 0 : (view.headings[index]?.line ?? 0), to }
}

const INKING = 3 * INK_MS
const recent = (at: number | null | undefined, now: number) => at != null && now - at < INKING
const openGlow = (v: PillView, now: number) => v.focus && recent(v.openedAt, now)
/** Folded, the tint fades from the landing; unfolded, the last answer from when it finished. */
const answerGlow = (v: PillView, now: number) =>
  v.land ? recent(v.land.at, now) : recent(v.thread.turns.at(-1)?.doneAt, now)
const arrivalGlow = (v: PillView, now: number) => recent(v.running?.arrivals.at(-1)?.at, now)

/** What still moves on the pill: the steam (STEAM_MS frames), something inking (INK_MS frames), or nothing. */
export function pillMoving(v: PillView, now: number): "steam" | "ink" | null {
  if (v.running && !v.running.live) return "steam"
  return openGlow(v, now) || arrivalGlow(v, now) || answerGlow(v, now) ? "ink" : null
}
