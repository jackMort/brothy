// Pure navigation helpers for App: search and the Find picker's rows, scroll anchoring, sidebar cursor, key specs.

import { lineText, type Span } from "../lib/spans"
import { clamp, pushSpan, segmenter, superscript, width } from "../lib/text"
import type { Geometry, Pic } from "../markdown/render"
import { foldSame } from "../notes/vault"
import type { Theme } from "../theme/theme"
import { fitHits, hitSpans, type PickerItem } from "./rows"

// ------------------------------------------------------------- search

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Case-insensitive match ranges, as offsets into `text` itself (no lowercased copy). */
export function matchRanges(text: string, q: string): [number, number][] {
  if (!q) return []
  const re = new RegExp(escapeRe(q.replace(/\u00a0/g, " ")), "giu")
  const out: [number, number][] = []
  for (const m of text.replace(/\u00a0/g, " ").matchAll(re)) out.push([m.index, m.index + m[0].length])
  return out
}

/** Indexes of lines containing `q`, case-insensitively. */
export function findLines(lines: string[], q: string): number[] {
  if (!q) return []
  return lines.flatMap((l, i) => (matchRanges(l, q).length ? [i] : []))
}

/** The code point indexes of `q`'s matches in `text`, so a cut can keep the first one in view. */
export function matchHits(text: string, q: string): number[] {
  const hits: number[] = []
  for (const [a, b] of matchRanges(text, q)) {
    const from = [...text.slice(0, a)].length
    for (let i = from; i < from + [...text.slice(a, b)].length; i++) hits.push(i)
  }
  return hits
}

/**
 * The Find picker's rows: per match line its trimmed text with the hits of `q` in primary, cut to `room` columns
 * around them, after the line number (Preview only: Source rows carry their own).
 */
export function findItems(
  lines: readonly { spans: Span[] }[],
  matches: readonly number[],
  q: string,
  source: boolean,
  room: number,
  t: Theme,
): PickerItem[] {
  return matches.map((m) => {
    const num = source ? "" : String(m + 1).padStart(4) + "  "
    const text = lineText(lines[m]).trim()
    const f = fitHits(text, matchHits(text, q), room - num.length)
    return { spans: [...(num ? [{ text: num, fg: t.textMuted }] : []), ...hitSpans(f.text, f.hits, t.text, t.primary)] }
  })
}

/** Paint search matches inside a rendered line (`paint`: the find highlight, unless given). */
export function markMatches(spans: Span[], q: string, t: Theme, paint?: Pick<Span, "fg" | "bg">): Span[] {
  const ranges = matchRanges(spans.map((s) => s.text).join(""), q)
  if (!ranges.length) return spans
  const out: Span[] = []
  let pos = 0
  for (const s of spans) {
    let start = 0
    const end = s.text.length
    while (start < end) {
      const abs = pos + start
      const r = ranges.find(([a, b]) => abs < b && pos + end > a)
      if (!r) {
        out.push({ ...s, text: s.text.slice(start) })
        break
      }
      const a = Math.max(r[0] - pos, start)
      const b = Math.min(r[1] - pos, end)
      if (a > start) out.push({ ...s, text: s.text.slice(start, a) })
      out.push({ ...s, text: s.text.slice(a, b), ...(paint ?? { fg: t.background, bg: t.secondary }) })
      start = b
    }
    pos += s.text.length
  }
  return out
}

/**
 * The match `n` / `N` goes to. Steps from the current match while it is on screen
 * (`top`..`top+h`), otherwise from the viewport top; wraps at both ends.
 */
export function stepMatch(
  matches: number[],
  cur: number | null,
  top: number,
  h: number,
  dir: 1 | -1,
): number | undefined {
  if (!matches.length) return undefined
  const onScreen = cur !== null && matches.includes(cur) && cur >= top && cur < top + h
  const after = (m: number) => (onScreen ? m > cur! : m >= top)
  const before = (m: number) => m < (onScreen ? cur! : top)
  return dir === 1 ? (matches.find(after) ?? matches[0]) : (matches.findLast(before) ?? matches[matches.length - 1])
}

/** 1-based position of `matchLine` among `matches`; null when it is unset or no longer a match. */
export function matchIndex(matches: number[], matchLine: number | null): number | null {
  if (matchLine === null) return null
  const i = matches.indexOf(matchLine)
  return i < 0 ? null : i + 1
}

// ------------------------------------------------------------- scroll anchoring

/**
 * Carry a scroll offset across a re-layout (resize, reload): keep the same relative
 * position inside the same heading's section, or the same document fraction when
 * the headings no longer line up.
 */
export function remapTop(top: number, from: Geometry, to: Geometry): number {
  if (from.total === to.total && from.heads.length === to.heads.length && from.heads.every((h, i) => h === to.heads[i]))
    return top
  if (from.heads.length !== to.heads.length || !from.total)
    return from.total ? Math.round((top / from.total) * to.total) : 0
  const bounds = (g: Geometry, i: number) => [i < 0 ? 0 : g.heads[i]!, g.heads[i + 1] ?? g.total] as const
  const i = from.heads.findLastIndex((h) => h <= top)
  const [a, b] = bounds(from, i)
  const [c, d] = bounds(to, i)
  return c + Math.round(((top - a) / Math.max(1, b - a)) * (d - c))
}

// ------------------------------------------------------------- sidebar

/** First row of a `h`-tall window over `len` rows, moved as little as possible to show row `i`. */
export function keepVisible(top: number, i: number, h: number, len: number): number {
  let t = clamp(top, 0, len - h)
  if (i < t) t = i
  if (i >= t + h) t = i - h + 1
  return Math.max(0, t)
}

/** `keepVisible` for a picker list: row `hl`, and the section header right above it, in an `h`-tall window. */
export function keepHitVisible(top: number, rows: readonly { kind: string }[], hl: number, h: number): number {
  const head = rows[hl - 1]?.kind === "header" ? hl - 1 : hl
  return keepVisible(keepVisible(top, head, h, rows.length), hl, h, rows.length)
}

/** Re-find the sidebar cursor after the row list changed, and keep it in view. */
export function relocate(
  paths: string[],
  prefer: (string | null | undefined)[],
  cursor: number,
  sideTop: number,
  height: number,
): { cursor: number; sideTop: number } {
  if (!paths.length) return { cursor: 0, sideTop: 0 }
  let c = -1
  for (const p of prefer) if (p && (c = paths.indexOf(p)) >= 0) break
  if (c < 0) c = clamp(cursor, 0, paths.length - 1)
  return { cursor: c, sideTop: keepVisible(sideTop, c, height, paths.length) }
}

// ------------------------------------------------------------- panel

/** Scroll thumb for an `h`-row window at `top` over `n` rows; null when everything fits. */
export function thumb(top: number, h: number, n: number): { start: number; size: number } | null {
  if (h <= 0 || n <= h) return null
  const size = Math.max(1, Math.round((h * h) / n))
  const t = clamp(top, 0, n - h)
  return { start: Math.round(((h - size) * t) / (n - h)), size }
}

const STRIP = [
  ["files", "Files"],
  ["outline", "Outline"],
  ["info", "Info"],
] as const
/** Panels narrower than this get the compact strip: two-space gaps instead of three. */
const STRIP_COMPACT_BELOW = 30

export interface StripLabel {
  view: (typeof STRIP)[number][0]
  text: string
  /** superscript key number printed against the label */
  digit: string
  /** clickable range `[x0, x1)` in panel columns (col 0 is padding); the label text starts at `lx` */
  x0: number
  lx: number
  x1: number
}

/** Tab-strip geometry for a panel `SW` columns wide, shared by the renderer and mouse hit-testing. */
export function stripLayout(
  SW: number,
  views: readonly StripLabel["view"][] = STRIP.map(([v]) => v),
): { compact: boolean; labels: StripLabel[] } {
  const compact = SW < STRIP_COMPACT_BELOW
  const labels: StripLabel[] = []
  let x = 1
  STRIP.filter(([v]) => views.includes(v)).forEach(([view, text], i) => {
    const digit = superscript(i + 1)
    const lx = x + digit.length
    labels.push({ view, text, digit, x0: x, lx, x1: lx + text.length })
    x = lx + text.length + (compact ? 2 : 3)
  })
  return { compact, labels }
}

// ------------------------------------------------------------- keys

export interface KeyLike {
  name: string
  sequence?: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
}

/**
 * Match a key spec: `j`, `down`, `S-g` (G), `C-d` (ctrl+d). A single non-alphanumeric
 * character (`?`, `/`, `]`) is compared against the typed sequence.
 */
export function matchKey(spec: string, k: KeyLike): boolean {
  if (spec.length === 1 && !/[a-z0-9]/.test(spec)) return k.sequence === spec
  let ctrl = false
  let shift = false
  let meta = false
  let name = spec
  for (;;) {
    if (name.startsWith("C-")) ctrl = true
    else if (name.startsWith("S-")) shift = true
    else if (name.startsWith("M-")) meta = true
    else break
    name = name.slice(2)
  }
  if (k.name !== name || !!k.ctrl !== ctrl || !!k.meta !== meta) return false
  // shift only matters for letters (G vs g); arrows and named keys ignore it
  return /^[a-z]$/.test(name) ? !!k.shift === shift : true
}

// ------------------------------------------------------------- link labels

export interface LinkSpot {
  /** index into `Rendered.links` (a link spot) */
  link?: number
  /** index into `Rendered.pics` (a picture spot) */
  pic?: number
  /** absolute line index */
  row: number
  /** column of the target's first visible cell */
  col: number
}

/** Home-row-first keys for link labels. */
const LABEL_KEYS = "asdjklghreui"

/** Where a picture's label goes on its row: the reserved rows' left edge, a placeholder's `▣` (after any quote bar). */
function picCol(pic: Pic, spans: Span[]): number {
  if (pic.rows > 0) return pic.left
  let col = 0
  for (const s of spans) {
    if (s.text.startsWith("▣")) return col
    col += width(s.text)
  }
  return 0
}

/**
 * Links and pictures on rows `first`..`first+h`, each once (a wrapped link at its first visible row, a picture at the
 * first of its rows in view, the caption included), in reading order.
 */
export function visibleLinks(
  lines: { spans: Span[]; pic?: number }[],
  first: number,
  h: number,
  pics: Pic[] = [],
): LinkSpot[] {
  const seen = new Set<number>()
  const seenPic = new Set<number>()
  const out: LinkSpot[] = []
  for (let row = Math.max(0, first); row < Math.min(lines.length, first + h); row++) {
    const { spans, pic: id } = lines[row]!
    const pic = id === undefined ? undefined : pics[id]
    let col = 0
    for (const s of spans) {
      if (s.link !== undefined && !seen.has(s.link)) {
        seen.add(s.link)
        out.push({ link: s.link, row, col })
      }
      col += width(s.text)
    }
    if (pic && !seenPic.has(pic.id)) {
      seenPic.add(pic.id)
      out.push({ pic: pic.id, row, col: picCol(pic, spans) })
    }
  }
  return out
}

/** `n` prefix-free labels: one key each while they suffice, else two keys each (at most keys²). */
export function linkLabels(n: number, keys = LABEL_KEYS): string[] {
  const ks = [...keys]
  if (n <= ks.length) return ks.slice(0, n)
  return ks.flatMap((a) => ks.map((b) => a + b)).slice(0, n)
}

/** Indexes of the labels that start with `typed`. */
export function narrowLabels(labels: string[], typed: string): number[] {
  return labels.flatMap((l, i) => (l.startsWith(typed) ? [i] : []))
}

/** Draw `text` over the cells from column `col`, keeping the row's width; a wide grapheme it cuts becomes spaces. */
export function overlayAt(spans: Span[], col: number, text: string, style: Omit<Span, "text">): Span[] {
  const end = col + width(text)
  const out: Span[] = []
  const add = (s: Span) => pushSpan(out, s)
  let x = 0
  let placed = false
  for (const s of spans)
    for (const { segment: g } of segmenter.segment(s.text)) {
      const gw = width(g)
      if (x + gw <= col || x >= end) add({ ...s, text: g })
      else {
        if (x < col) add({ ...s, text: " ".repeat(col - x) })
        if (!placed) {
          add({ ...style, text })
          placed = true
        }
        if (x + gw > end) add({ ...s, text: " ".repeat(x + gw - end) })
      }
      x += gw
    }
  if (!placed && x <= col) {
    if (x < col) add({ text: " ".repeat(col - x) })
    add({ ...style, text })
  }
  return out
}

// ------------------------------------------------------------- memo

/** Single-entry memo usable outside render (key handlers read derived data through it). */
export function cached<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  let last: A | undefined
  let val: R
  return (...a) => {
    if (!last || a.length !== last.length || a.some((x, i) => x !== last![i])) {
      val = fn(...a)
      last = a
    }
    return val
  }
}

/**
 * A version that follows `ver` at once while not `busy`, and at most once per `ms` while it is: a memo keyed on it is
 * rebuilt at that pace while a build changes its input in place, and once more when the build ends.
 */
export function throttleVer(ms: number, now: () => number = Date.now): (ver: number, busy: boolean) => number {
  let held = Number.NaN
  let at = Number.NEGATIVE_INFINITY
  return (ver, busy) => {
    const t = now()
    if (ver !== held && (!busy || t - at >= ms)) {
      held = ver
      at = t
    }
    return held
  }
}

/** Copy-on-select text: rows are padded to their width, so trailing spaces and blank edge rows go. */
export function selectedText(raw: string) {
  const lines = raw.split("\n").map((l) => l.trimEnd())
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines.at(-1)) lines.pop()
  return lines.join("\n")
}

/** The copy toast's count: lines when there are several, else characters (code points). */
export function copiedCount(text: string): [number, string] {
  const n = text.split("\n").length
  return n > 1 ? [n, "line"] : [[...text].length, "char"]
}

/** Where a quote sits in the rows: its first and last rows, and the columns in them (`endCol` exclusive). */
export interface QuoteSpan {
  row: number
  col: number
  endRow: number
  endCol: number
}

/** The rows as one folded, space-joined text, with the row and column each of its characters came from. */
export interface Flat {
  text: string
  at: [number, number][]
}

/** Adds one row to `flat`: blank runs fold to one space (at the run's first column), rows join with a space. */
function flatRow(flat: Flat, row: string, i: number) {
  let gap = -1
  for (let c = 0; c < row.length; c++) {
    if (/\s/.test(row[c]!)) {
      if (gap < 0) gap = c
      continue
    }
    if (flat.text && (gap >= 0 || flat.at.at(-1)![0] !== i)) {
      flat.text += " "
      flat.at.push([i, gap >= 0 ? gap : c])
    }
    gap = -1
    flat.text += row[c]
    flat.at.push([i, c])
  }
}

/** Rows `from..to` of `plain` as one `Flat`: what `quoteSpan` reads; `spanIn` looks in one built once. */
export function flatten(plain: readonly string[], from: number, to: number): Flat {
  const flat: Flat = { text: "", at: [] }
  for (let i = Math.max(0, from); i < Math.min(to, plain.length); i++) flatRow(flat, foldSame(plain[i]!), i)
  return flat
}

/**
 * Where `needle` sits within rows `from..to` of `plain`, read as one space-joined text so a phrase may wrap;
 * case-insensitive (length-keeping, so columns hold), whitespace runs count as one space. Columns are
 * offsets into each row's text.
 */
export function quoteSpan(plain: readonly string[], from: number, to: number, needle: string): QuoteSpan | null {
  return foldSame(needle).trim() ? spanIn(flatten(plain, from, to), needle) : null
}

/** `quoteSpan` within rows already flattened, so several needles share one pass over them. */
export function spanIn({ text, at }: Flat, needle: string): QuoteSpan | null {
  const want = foldSame(needle).replace(/\s+/g, " ").trim()
  if (!want) return null
  const k = text.indexOf(want)
  if (k < 0) return null
  const [row, col] = at[k]!
  const [endRow, last] = at[k + want.length - 1]!
  return { row, col, endRow, endCol: last + 1 }
}

/** Row where `needle` starts within rows `from..to` of `plain` (`quoteSpan`'s first row). */
export function findQuote(plain: string[], from: number, to: number, needle: string): number | null {
  return quoteSpan(plain, from, to, needle)?.row ?? null
}
