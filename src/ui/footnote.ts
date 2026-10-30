// The AI family's print language, pure: a mark in the text, a short rule with its tail, the waiting row, notes with a
// hanging indent and sidenotes in the right margin. Gloss, TL;DR, what changed and ask all draw through it; every colour
// is a theme role (`footInk`). No React, no store, no timers.
import { type Span, safeLine } from "../lib/spans"
import { clamp, spanWidth, superscript, truncate, width, wrap } from "../lib/text"
import { mix, type Theme } from "../theme/theme"

/** columns of `─` in a rule, and the least it shrinks to before its tail is cut */
export const RULE = 16
export const RULE_MIN = 4
/** a model's name is cut to this many columns */
export const MODEL_W = 24
/** where the text will appear while the model works; never blinks */
export const CARET = "▍"
/** mixed this far toward the background: outdated or regenerating text, and notes about something not being read */
export const DIM_STALE = 0.4
export const DIM_OTHER = 0.6
/** sidenotes: never below SIDENOTE_MIN_W terminal columns, SIDENOTE_GAP from the text, SIDENOTE_W wide (mark, space, 28) */
export const SIDENOTE_MIN_W = 140
export const SIDENOTE_GAP = 3
export const SIDENOTE_W = 30
/** text rows of a sidenote: collapsed, the reading note expanded, the `Δ` summary */
export const SIDENOTE_ROWS = 6
export const SIDENOTE_ROWS_OPEN = 18
export const SIDENOTE_SUMMARY_ROWS = 5

type Ink = (c: string) => string
const same: Ink = (c) => c

// ------------------------------------------------------------- marks

/** `*` a note about the whole note, `Δ` about the whole change set, a number about one section or answer. */
export type Mark = "*" | "Δ" | number
export const markText = (m: Mark) => (typeof m === "number" ? superscript(m) : m)

export type MarkSource = "change" | "ask" | "gloss"
const MARK_RANK: Record<MarkSource, number> = { change: 0, ask: 1, gloss: 2 }

/** The one mark a heading gets: change, then ask, then gloss. */
export const markFor = <T extends { source: MarkSource }>(cands: readonly T[]): T | null =>
  cands.reduce<T | null>((best, c) => (best && MARK_RANK[best.source] <= MARK_RANK[c.source] ? best : c), null)

/** `row` without its trailing blanks. */
function trimEnd(row: Span[]): Span[] {
  const out = row.slice()
  while (out.length) {
    const last = out[out.length - 1]!
    const text = last.text.trimEnd()
    if (text) {
      out[out.length - 1] = text === last.text ? last : { ...last, text }
      break
    }
    out.pop()
  }
  return out
}

/**
 * A heading row's mark: right after its text, no space (`Checkpoints¹`), when that fits in `width`; else (a full row,
 * a `rules` fill) it goes in the gutter, the column two left of the text.
 */
export function placeMark(row: Span[], width_: number, mark: Span): { inline: Span[] } | { gutter: Span } {
  const text = trimEnd(row)
  return spanWidth(text) + width(mark.text) <= width_ ? { inline: [...text, mark] } : { gutter: mark }
}

// ------------------------------------------------------------- ink

/** Every colour a footnote uses, from the theme's roles. */
export interface FootInk {
  mark: string
  markStale: string
  markOther: string
  rule: string
  status: string
  key: string
  word: string
  /** TL;DR, the delta summary, ask answers */
  text: string
  /** gloss text, delta notes, ask footnotes */
  note: string
  stale: string
  other: string
  caret: string
  error: string
}

/** The roles, with `ink` (a fade) over every colour. */
export const footInk = (t: Theme, ink: Ink = same): FootInk => ({
  mark: ink(t.primary),
  markStale: ink(t.textMuted),
  markOther: ink(mix(t.primary, t.background, DIM_OTHER)),
  rule: ink(t.border),
  status: ink(t.textMuted),
  key: ink(t.text),
  word: ink(t.textMuted),
  text: ink(t.text),
  note: ink(t.textMuted),
  stale: ink(mix(t.textMuted, t.background, DIM_STALE)),
  other: ink(mix(t.textMuted, t.background, DIM_OTHER)),
  caret: ink(t.text),
  error: ink(t.error),
})

// ------------------------------------------------------------- staleness, waiting

/** Why a cached reply no longer matches: the text was edited, or the prompt changed. */
export type Stale = "edited" | "version"

export function staleKind(e: { hash: string; v: number }, hash: string, v: number): Stale | null {
  if (e.hash !== hash) return "edited"
  return e.v === v ? null : "version"
}

export const staleTail = (k: Stale, key: string): Tail => ({
  status: k === "edited" ? "edited since" : "older version",
  key,
  word: "refresh",
})

/** Whole seconds since `at`. */
export const waitSecs = (now: number, at: number) => Math.max(0, Math.floor((now - at) / 1000))

/** `asking <model> · <N> s`, the seconds from 1 s on; `model` (shortModel's) cut to MODEL_W, then to fit `room`. */
export function waitText(model: string, secs: number, room = Number.POSITIVE_INFINITY): string {
  const tail = secs >= 1 ? ` · ${secs} s` : ""
  const m = truncate(safeLine(model), Math.min(MODEL_W, room - width(`asking ${tail}`)))
  return truncate(m ? `asking ${m}${tail}` : `asking${tail}`, room)
}

// ------------------------------------------------------------- rule + tail

/** A rule's right end: `status · key word` (or `key word · status`), each part optional. */
export interface Tail {
  status?: string
  /** the model's name inside `status`: cut first when the row is short (to `…`, then out) */
  model?: string
  key?: string
  word?: string
  /** the key and its word before the status (`⏎ more · llama3.2`) */
  keyFirst?: boolean
  /** the part cut next, after the model: gloss keeps its key (`status`); the others keep the status (`key`, the default) */
  drop?: "status" | "key"
}

const SEP = " · "
const keyPart = (t: Tail) => (t.key ? t.key + (t.word ? ` ${t.word}` : "") : "")
const tailParts = (t: Tail) => {
  const parts = [t.status ?? "", keyPart(t)].filter(Boolean)
  return t.keyFirst ? parts.reverse() : parts
}
const tailWidth = (t: Tail) => width(tailParts(t).join(SEP))

/** `status` with `model` cut to `cut`; an empty cut takes the model out with the separator next to it. */
function cutModel(status: string, model: string, cut: string): string {
  const s = status.replace(model, cut)
  if (cut) return s
  return s
    .replace(/ {2,}/g, " ")
    .replace(/^ · | · $/, "")
    .trim()
}

/** `t` with its model cut to what `room` leaves (to `…`), or taken out. */
function shrinkModel(t: Tail, room: number): Tail {
  if (!t.model || !t.status?.includes(t.model)) return t
  const keep = width(t.model) - (tailWidth(t) - room)
  return { ...t, status: cutModel(t.status, t.model, keep >= 1 ? truncate(t.model, keep) : ""), model: undefined }
}

/** `t` without its `drop` part; a status left alone is cut to `room` with `…`. */
function dropPart(t: Tail, room: number): Tail | null {
  const rest = (t.drop ?? "key") === "key" ? { ...t, key: undefined } : { ...t, status: undefined }
  if (rest.key) return rest
  return rest.status && room >= 2 ? { ...rest, status: truncate(rest.status, room) } : null
}

/** `tail` in at most `room` columns: the model first (to `…`, then out), then the `drop` part, then the status to `…`. */
function fitTail(tail: Tail, room: number): Tail | null {
  const fits = (t: Tail | null): t is Tail => !!t && tailWidth(t) <= room
  if (fits(tail)) return tail
  const shrunk = shrinkModel(tail, room)
  if (fits(shrunk)) return shrunk
  const rest = dropPart(shrunk, room)
  return fits(rest) ? rest : null
}

/** A fitted tail as spans: statuses and `·` muted, the key in the text role, its word muted. */
function tailSpans(t: Tail, c: FootInk): Span[] {
  const status: Span[] = t.status ? [{ text: t.status, fg: c.status }] : []
  const key: Span[] = t.key ? [{ text: t.key, fg: c.key }] : []
  if (t.key && t.word) key.push({ text: ` ${t.word}`, fg: c.word })
  const parts = [status, key].filter((p) => p.length)
  if (t.keyFirst) parts.reverse()
  return parts.flatMap((p, i) => (i ? [{ text: SEP, fg: c.status }, ...p] : p))
}

/**
 * The rule under or over a note, exactly `width` wide: `─` × RULE in `border`, flush left, and `tail` right-aligned.
 * The rule shrinks to RULE_MIN before the tail loses anything; then `fitTail` cuts it. The rule itself is never cut.
 */
export function footnoteRule(t: Theme, width_: number, tail: Tail | null, ink: Ink = same): Span[] {
  const c = footInk(t, ink)
  const fit = tail ? fitTail(tail, width_ - 1 - RULE_MIN) : null
  const tw = fit ? tailWidth(fit) : 0
  const rule = fit ? clamp(width_ - tw - 1, RULE_MIN, RULE) : Math.max(0, Math.min(RULE, width_))
  const gap = width_ - rule - tw
  const spans: Span[] = [{ text: "─".repeat(rule), fg: c.rule }]
  if (gap > 0) spans.push({ text: " ".repeat(gap) })
  return fit ? [...spans, ...tailSpans(fit, c)] : spans
}

/** `tail` right-aligned in `width` columns, no rule: a sidenote's status row. */
function statusRow(tail: Tail, width_: number, c: FootInk): Span[] {
  const fit = fitTail(tail, width_)
  if (!fit) return []
  const gap = width_ - tailWidth(fit)
  return [...(gap > 0 ? [{ text: " ".repeat(gap) }] : []), ...tailSpans(fit, c)]
}

/**
 * The row a note keeps while the model works: `¹ ▍` where the text will appear (the status then goes on the rule), or,
 * with `status`, `▍ asking llama3.2 · 3 s` in `width` columns. `stale`: regenerating over an old text, the mark muted.
 */
export function waitingRow(
  t: Theme,
  o: { mark: Mark | null; model: string; secs: number; status: boolean; width: number; stale?: boolean },
  ink: Ink = same,
): Span[] {
  const c = footInk(t, ink)
  const row: Span[] =
    o.mark === null ? [] : [{ text: markText(o.mark), fg: o.stale ? c.markStale : c.mark }, { text: " " }]
  row.push({ text: CARET, fg: c.caret })
  const room = o.width - spanWidth(row) - 1
  if (!o.status || room < 1) return row
  return [...row, { text: " " }, { text: waitText(o.model, o.secs, room), fg: c.status }]
}

/**
 * A note as at most `max` rows of `width` columns: the mark and a space, then the text with a hanging indent of the same
 * width (`¹ `, `¹⁰ `). The last row ends in `cut` when text is left over (` …` by default); `tail` keeps the last rows
 * instead, uncut (a stream, its caret in view).
 */
export function noteRows(
  text: string,
  width_: number,
  mark: Mark | null,
  max: number,
  o: { tail?: boolean; cut?: " …" | "…" } = {},
): string[] {
  const head = mark === null ? "" : `${markText(mark)} `
  const w = width_ - width(head)
  const body = safeLine(text).trim()
  if (!body || w < 1 || max < 1) return []
  // truncate guards a single token wider than the row
  const rows = wrap([{ text: body }], w).map((r) =>
    truncate(
      r
        .map((s) => s.text)
        .join("")
        .trimEnd(),
      w,
    ),
  )
  let shown = rows
  if (rows.length > max && o.tail) shown = rows.slice(-max)
  else if (rows.length > max) shown = [...rows.slice(0, max - 1), truncate(rows[max - 1]! + (o.cut ?? " …"), w)]
  return shown.map((r, i) => (i ? " ".repeat(width(head)) : head) + r)
}

// ------------------------------------------------------------- sidenotes

/**
 * The screen column of the sidenotes, or null when the footnote under the rule is used instead: from SIDENOTE_MIN_W
 * columns, and only when a note SIDENOTE_GAP right of the text ends by `rightEdge` (`W − 1`, less the minimap).
 */
export function sidenoteAt(W: number, textLeft: number, CW: number, rightEdge: number): number | null {
  const x = textLeft + CW + SIDENOTE_GAP
  return W >= SIDENOTE_MIN_W && x + SIDENOTE_W <= rightEdge ? x : null
}

/** A note for the margin. The caller numbers it (`n`) and anchors it (`row`: its heading's last row on screen). */
export interface SideNote {
  n: number
  row: number
  /** "" while waiting (the caret row); ending in CARET while streaming (its last rows show) */
  text: string
  /** true: the note being read (kept on row 0 when its heading scrolls above, expands); false: a neighbour of it, dimmed */
  reading?: boolean
  stale?: boolean
  /** the mark muted, the text not: a note already acted on (an explained change) */
  markStale?: boolean
  /** the `Δ` summary, pinned on row 0, in the text role */
  summary?: boolean
  /** a status row under the text, right-aligned */
  status?: Tail | null
}

/** A placed note: its first row on screen and its rows, status row included, each at most SIDENOTE_W wide. */
export interface SidePlaced {
  n: number
  row: number
  rows: Span[][]
}

/** The colours of one note: the summary in text, outdated and neighbouring notes dimmed. */
function sideInk(note: SideNote, c: FootInk) {
  if (note.stale) return { mark: c.markStale, text: c.stale }
  if (note.reading === false) return { mark: c.markOther, text: c.other }
  return { mark: note.markStale ? c.markStale : c.mark, text: note.summary ? c.text : c.note }
}

/**
 * `noteRows`' rows as spans: the mark in `fg.mark` on the first row, the text in `fg.text`, a caret ending the last row in
 * `caret`. An empty `text` is the waiting row, `¹ ▍`; a `text` ending in CARET streams (its last rows show).
 */
export function noteSpans(
  text: string,
  width_: number,
  mark: Mark,
  max: number,
  fg: { mark: string; text: string; caret: string },
): Span[][] {
  const m = markText(mark)
  const rows = text ? noteRows(text, width_, mark, max, { tail: text.endsWith(CARET) }) : [`${m} ${CARET}`]
  return rows.map((r, i) => {
    const body = i ? r : r.slice(m.length)
    const spans: Span[] = i ? [] : [{ text: m, fg: fg.mark }]
    if (!body.endsWith(CARET)) return [...spans, { text: body, fg: fg.text }]
    return [...spans, { text: body.slice(0, -CARET.length), fg: fg.text }, { text: CARET, fg: fg.caret }]
  })
}

/** One note's rows: at most `max` of text, then its status row, all within `room` (text first gives way to the status). */
function sideRows(note: SideNote, max: number, room: number, c: FootInk): Span[][] {
  const status = note.status && room >= 2 ? statusRow(note.status, SIDENOTE_W, c) : []
  const textRows = Math.min(max, status.length ? room - 1 : room)
  const out = noteSpans(note.text, SIDENOTE_W, note.summary ? "Δ" : note.n, textRows, {
    ...sideInk(note, c),
    caret: c.caret,
  })
  return status.length ? [...out, status] : out
}

/** One note's rows from `start`: up to the row before `next` (the next note) and the body's bottom; expanded, past that. */
function placeRows(note: SideNote, start: number, next: number, CH: number, open: boolean, c: FootInk) {
  if (open) return sideRows(note, SIDENOTE_ROWS_OPEN, CH - start, c)
  const max = note.summary ? SIDENOTE_SUMMARY_ROWS : SIDENOTE_ROWS
  return sideRows(note, max, Math.min(Math.max(1, next - 1 - start), CH - start), c)
}

/** Where a note wants to start: the summary on row 0, the reading note no higher than 0, the others at their heading. */
function startOf(note: SideNote) {
  if (note.summary) return 0
  return note.reading ? Math.max(0, note.row) : note.row
}

/**
 * The margin's notes, top to bottom in `CH` body rows: each from its start row (the reading note no higher than 0),
 * one empty row before the next, cut ` …` at SIDENOTE_ROWS or where the next begins. The `Δ` summary is pinned on row 0
 * and moves the notes under it down; the reading note expanded (`open`) ignores the cap and hides the notes it covers.
 * Numbers are the caller's; nothing renumbers.
 */
export function sidenoteLayout(
  t: Theme,
  notes: readonly SideNote[],
  CH: number,
  o: { open: boolean; ink?: Ink },
): SidePlaced[] {
  const c = footInk(t, o.ink)
  const order = notes
    .filter((n) => n.summary || n.reading || (n.row >= 0 && n.row < CH))
    .map((note) => ({ note, want: startOf(note) }))
    .sort((a, b) => a.want - b.want || Number(!!b.note.summary) - Number(!!a.note.summary))
  const out: SidePlaced[] = []
  let free = 0
  let covered = -1
  order.forEach(({ note, want }, i) => {
    const start = Math.max(want, free)
    if (want <= covered || start >= CH) return
    const open = o.open && note.reading === true
    // the summary keeps its rows: notes under it move down instead of cutting it
    const next = note.summary ? CH + 1 : (order[i + 1]?.want ?? CH + 1)
    const rows = placeRows(note, start, next, CH, open, c)
    out.push({ n: note.n, row: start, rows })
    free = start + rows.length + 1
    if (open) covered = start + rows.length - 1
  })
  return out
}
