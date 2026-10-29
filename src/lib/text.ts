// Text helpers every module shares: display width, graphemes, span width and merging, cutting to a width,
// word wrapping (`wrap`), number words, `clamp` and superscript digits. Pure, and a leaf: it imports nothing but the `Span` type.

import type { Span } from "./spans"

// ------------------------------------------------------------- width

/** Display columns of `s`: graphemes, wide and zero-width characters; ANSI escape sequences count 0. */
export const width = (s: string) => Bun.stringWidth(s)

/** The one grapheme segmenter (`Intl.Segmenter` is costly to build). */
export const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** `s` as graphemes, the cells a terminal draws. */
export const graphemes = (s: string) => Array.from(segmenter.segment(s), (x) => x.segment)

/** Columns of a row of spans: the sum of each span's width. */
export const spanWidth = (spans: Span[]) => spans.reduce((n, s) => n + width(s.text), 0)

// ------------------------------------------------------------- spans

/** Do `a` and `b` look the same (colours, attributes, link)? A missing `attr` is 0; a link never merges with another. */
export const sameStyle = (a: Span, b: Span) =>
  a.fg === b.fg && a.bg === b.bg && (a.attr ?? 0) === (b.attr ?? 0) && a.link === b.link

/** Append a copy of `s` to `spans`, or its text to the last span when they look the same; empty text is dropped. */
export function pushSpan(spans: Span[], s: Span) {
  if (!s.text) return
  const last = spans[spans.length - 1]
  if (last && sameStyle(last, s)) last.text += s.text
  else spans.push({ ...s })
}

/** `spans` with empty ones dropped and same-looking neighbours merged (`pushSpan`); the input is not changed. */
export function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of spans) pushSpan(out, s)
  return out
}

// ------------------------------------------------------------- cutting

/**
 * A cut keeps the code points before the first one whose prefix no longer fits. Widths are summed per grapheme,
 * so it is linear, but a grapheme of several code points is measured part by part (it may be cut inside, and a
 * part can be wider than the whole, as 👍 + U+FE0E is), and text with escape sequences is measured whole (an
 * escape's width is not the sum of its parts).
 */
const ESCAPES = /[\x1b\x9b]/
const clustered = (g: string) => g.length > (g.codePointAt(0)! > 0xffff ? 2 : 1)

/** Cut `s` to `max` columns, ending in `…` when it had to be cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return ""
  if (width(s) <= max) return s
  if (ESCAPES.test(s)) {
    let out = ""
    for (const ch of s) {
      if (width(out + ch) > max - 1) break
      out += ch
    }
    return out + "…"
  }
  let w = 0
  for (const { segment: g, index } of segmenter.segment(s)) {
    const gw = width(g)
    if (w + gw > max - 1 || clustered(g)) {
      let part = ""
      for (const ch of g) {
        if (w + width(part + ch) > max - 1) return s.slice(0, index) + part + "…"
        part += ch
      }
    }
    w += gw
  }
  return s + "…"
}

/** Cut `s` from the left to `max` columns, starting with `…` when it had to be cut. */
export function truncateLeft(s: string, max: number): string {
  if (max <= 0) return ""
  if (width(s) <= max) return s
  if (ESCAPES.test(s)) {
    const chars = [...s]
    let out = ""
    for (let i = chars.length - 1; i >= 0; i--) {
      if (width(chars[i] + out) > max - 1) break
      out = chars[i] + out
    }
    return "…" + out
  }
  const gs = Array.from(segmenter.segment(s))
  let w = 0
  for (let k = gs.length - 1; k >= 0; k--) {
    const { segment: g, index } = gs[k]!
    const gw = width(g)
    if (w + gw > max - 1 || clustered(g)) {
      const cps = [...g]
      let part = ""
      for (let i = cps.length - 1; i >= 0; i--) {
        if (w + width(cps[i] + part) > max - 1) return "…" + part + s.slice(index + g.length)
        part = cps[i] + part
      }
    }
    w += gw
  }
  return "…" + s
}

// ------------------------------------------------------------- wrapping

/** The rows being filled: each starts with its prefix (`first`, then `rest`) and holds at most `max` columns. */
function rowWriter(max: number, first: Span[], rest: Span[]) {
  const rows: Span[][] = []
  let row: Span[] = first.map((s) => ({ ...s }))
  let w = spanWidth(first)
  let base = w
  let pendingSpace: Span | null = null
  const newRow = () => {
    rows.push(row)
    row = rest.map((s) => ({ ...s }))
    w = spanWidth(rest)
    base = w
    pendingSpace = null
  }
  /** Place text grapheme by grapheme, starting a new row when one would overflow. */
  const place = (s: Span, text: string) => {
    for (const g of graphemes(text)) {
      const gw = width(g)
      if (w + gw > max && w > base) newRow()
      pushSpan(row, { ...s, text: g })
      w += gw
    }
  }
  return {
    newRow,
    place,
    /** a run of blanks in `s`: one space, drawn only if a word follows on the same row and not at the row's start */
    gap(s: Span) {
      if (w > base) pendingSpace = { ...s, text: " " }
    },
    /** a word in `s`: after its pending space, on a new row if it does not fit, chopped if it is wider than any row */
    word(s: Span, text: string) {
      const pw = width(text)
      if (w > base && w + (pendingSpace ? 1 : 0) + pw > max) newRow()
      else if (pendingSpace) {
        pushSpan(row, pendingSpace)
        w += 1
      }
      pendingSpace = null
      if (pw > max - base) place(s, text)
      else {
        pushSpan(row, { ...s, text })
        w += pw
      }
    },
    done() {
      rows.push(row)
      return rows
    },
  }
}

type RowWriter = ReturnType<typeof rowWriter>

/** `wrap`'s `preserve` mode: whitespace verbatim, rows break only at "\n" or by hard-chopping. */
function wrapVerbatim(spans: Span[], out: RowWriter) {
  for (const s of spans) {
    s.text.split("\n").forEach((seg, i) => {
      if (i > 0) out.newRow()
      out.place(s, seg)
    })
  }
}

/** `wrap`'s word mode: the text cut into words, blank runs and "\n". */
function wrapWords(spans: Span[], out: RowWriter) {
  for (const s of spans) {
    for (const part of s.text.split(/(\n|[ \t]+)/)) {
      if (!part) continue
      if (part === "\n") out.newRow()
      else if (/^[ \t]+$/.test(part)) out.gap(s)
      else out.word(s, part)
    }
  }
}

/**
 * Word-wrap styled spans to `max` columns. `first`/`rest` are prefixes drawn
 * on the first and following rows (indentation, bullets, quote bars).
 * A "\n" inside a span forces a hard break. With `preserve`, whitespace is
 * kept verbatim and rows break only at "\n" or by hard-chopping (code).
 * Text is cut on grapheme boundaries and measured per grapheme.
 */
export function wrap(spans: Span[], max: number, first: Span[] = [], rest: Span[] = first, preserve = false): Span[][] {
  const out = rowWriter(max, first, rest)
  if (preserve) wrapVerbatim(spans, out)
  else wrapWords(spans, out)
  return out.done()
}

// ------------------------------------------------------------- numbers

/** `n` with thousands separators (`1,234`). */
export const fmtNum = (n: number) => n.toLocaleString("en-US")

/** `n` and `word`, plural unless `n` is 1 (`1 word`, `2,000 words`). */
export const plural = (n: number, word: string) => `${fmtNum(n)} ${word}${n === 1 ? "" : "s"}`

/** `n` held to `lo`…`hi`; `lo` wins when the range is empty. */
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹"
/** `n` in superscript digits (tab key numbers). */
export const superscript = (n: number) => [...String(n)].map((d) => SUP[Number(d)] ?? d).join("")
