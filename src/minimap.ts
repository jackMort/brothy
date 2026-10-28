// The braille minimap: every rendered line is a dot row, every textW/(2·cols) display columns a dot column.
// A note taller than 4·maxRows lines is scaled (each dot row ORs `scale` lines) so it always fits.
// A one-cell lane to its right marks the find hits, one dot per match line.
import type { Theme } from "./theme"

export const MINI_COLS = 2
/** columns the minimap takes at the screen's right edge: one gap, the braille cells, the find lane */
export const MINI_W = MINI_COLS + 2
export const MINI_MIN_W = 110

const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const
const braille = (v: number) => (v ? String.fromCharCode(0x2800 + v) : " ")
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Dot columns `0 … dots − 1` with ink in `line`: each grapheme covers its display width in cells, `per` cells a dot column. */
function inkedColumns(line: string, per: number, dots: number): boolean[] {
  const on = Array<boolean>(dots).fill(false)
  if (/^[\x20-\x7e]*$/.test(line)) {
    // printable ASCII, the common case: one cell per character, no segmenting
    for (let c = 0; c < line.length && c / per < dots; c++) if (line.charCodeAt(c) !== 32) on[Math.floor(c / per)] = true
    return on
  }
  let col = 0
  for (const { segment } of graphemes.segment(line)) {
    const w = Bun.stringWidth(segment)
    if (segment.trim() !== "") for (let c = col; c < col + Math.max(1, w); c++) if (c / per < dots) on[Math.floor(c / per)] = true
    col += w
  }
  return on
}
/** rule rows (heading underlines, `---`) draw no dots */
const RULE = /^[\s─━]*$/

export interface MiniInk {
  /** braille dot bits per cell, row-major (`rows × cols`) */
  bits: Uint8Array
  rows: number
  /** lines per dot row */
  scale: number
}

export function miniInk(plain: readonly string[], fills: readonly boolean[], textW: number, maxRows: number, cols = MINI_COLS): MiniInk {
  const n = plain.length
  const scale = Math.max(1, Math.ceil(n / (4 * Math.max(1, maxRows))))
  const rows = Math.ceil(n / (4 * scale))
  const bits = new Uint8Array(rows * cols)
  const per = Math.max(1, textW) / (cols * 2)
  for (let i = 0; i < n; i++) {
    const solid = fills[i] === true
    if (!solid && RULE.test(plain[i]!)) continue
    const dotRow = Math.floor(i / scale)
    const cy = dotRow >> 2
    const dy = dotRow & 3
    const on = solid ? null : inkedColumns(plain[i]!, per, cols * 2)
    for (let dc = 0; dc < cols * 2; dc++) {
      if (on && !on[dc]) continue
      const k = cy * cols + (dc >> 1)
      bits[k] = bits[k]! | BIT[dy]![dc & 1]!
    }
  }
  return { bits, rows, scale }
}

export type MiniKind = "head" | "view" | "rest" | "lane"
export interface MiniCell {
  ch: string
  kind: MiniKind
  /** on screen: drawn on the band */
  band: boolean
}

/**
 * One row of cells per ink row: a heading in it beats the viewport, the viewport beats the rest;
 * the band marks the rows on screen. With `lane`, one more cell per row carries the find hits.
 */
export function miniCells(
  ink: MiniInk,
  o: { top: number; h: number; heads: readonly number[]; hits: readonly number[]; total: number; lane: boolean },
  cols = MINI_COLS,
): MiniCell[][] {
  const span = 4 * ink.scale
  const heads = new Set(o.heads.map((l) => Math.floor(l / span)))
  const lane = new Uint8Array(ink.rows)
  for (const l of o.hits) {
    const dotRow = Math.floor(l / ink.scale)
    if (dotRow >> 2 < ink.rows) lane[dotRow >> 2] = lane[dotRow >> 2]! | BIT[dotRow & 3]![0]
  }
  const out: MiniCell[][] = []
  for (let cy = 0; cy < ink.rows; cy++) {
    const a = cy * span
    const b = Math.min(o.total, a + span)
    const band = a < o.top + o.h && b > o.top
    const kind: MiniKind = heads.has(cy) ? "head" : band ? "view" : "rest"
    const row = Array.from({ length: cols }, (_, cx): MiniCell => ({ ch: braille(ink.bits[cy * cols + cx]!), kind, band }))
    if (o.lane) row.push({ ch: braille(lane[cy]!), kind: "lane", band })
    out.push(row)
  }
  return out
}

/** The top that centres the first line of cell row `row`, clamped to [0, maxTop]. */
export const miniJump = (row: number, ink: MiniInk, h: number, maxTop: number) =>
  Math.max(0, Math.min(maxTop, row * 4 * ink.scale - Math.floor(h / 2)))

/** Theme roles only: headings as H1s, text on screen muted on the band, the rest as faint as a rule, hits as find marks them. */
export const miniColors = (t: Theme): Record<MiniKind, string> => ({
  head: t.primary,
  view: t.textMuted,
  rest: t.borderSubtle,
  lane: t.secondary,
})
