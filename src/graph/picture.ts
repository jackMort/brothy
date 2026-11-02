// The graph picture at the sheet's size: the layout placed in cells, drawn on a canvas (pixels for OpenTUI's image, or
// 2 × 4 dots per cell for braille), the node glyphs and the labels; and which node a pointer cell is on. Pure.
import { A, type Span } from "../lib/spans"
import { graphemes, pushSpan, width } from "../lib/text"
import { fuzzyHits } from "../notes/files"
import type { Theme } from "../theme/theme"
import { brailleCells, type Cell, withGlyphs } from "./braille"
import { Canvas, drawGraph, nodePaint, nodeRadius, type Raster } from "./canvas"
import type { Ego } from "./ego"
import { type Label, type LabelTone, placeLabels } from "./labels"
import { type Layout, type Placed, placeIn } from "./layout"
import type { GraphMode, GraphTerm, SheetGeo } from "./sheet"

export interface Picture {
  mode: GraphMode
  /** each node's cell (fractional) */
  at: Placed
  labels: Label[]
  /** braille: the picture's rows, labels written in; pixels: [] */
  rows: Span[][]
  /** pixels: the raster for `NativeImage.fromRgba`; braille: null */
  rgba: { px: Uint8Array; w: number; h: number } | null
}

type Ink = { fg: string; bg?: string; attr?: number }
const TONE: Record<LabelTone, (t: Theme) => Ink> = {
  centre: (t) => ({ fg: t.primary, attr: A.BOLD }),
  focus: (t) => ({ fg: t.text, bg: t.backgroundElement, attr: A.BOLD }),
  near: (t) => ({ fg: t.text }),
  far: (t) => ({ fg: t.textMuted }),
}
/** A label's colours. */
export const labelInk = (t: Theme, tone: LabelTone): Ink => TONE[tone](t)

const NO_DIM: ReadonlySet<number> = new Set()
/** The nodes the filter `q` passes by: every one but the centre whose name it misses. */
export function dimOf(ego: Ego, q: string): ReadonlySet<number> {
  if (!q) return NO_DIM
  return new Set(ego.nodes.flatMap((n, i) => (i > 0 && !fuzzyHits(n.name, q) ? [i] : [])))
}

type Grid = ({ ch: string } & Partial<Ink>)[][]

/** `l` written over its cells; a wide grapheme's second cell is "". */
function writeLabel(grid: Grid, l: Label, ink: Ink) {
  const row = grid[l.row]
  if (!row) return
  let c = l.col
  for (const g of graphemes(l.text)) {
    const w = width(g)
    if (c + w > row.length) return
    row[c] = { ch: g, ...ink }
    for (let k = 1; k < w; k++) row[c + k] = { ch: "", ...ink }
    c += w
  }
}

/** The braille cells as rows of spans, the labels written over them. */
function brailleRows(cells: readonly (Cell | null)[][], labels: readonly Label[], t: Theme): Span[][] {
  const grid: Grid = cells.map((row) => row.map((c) => c ?? { ch: " " }))
  for (const l of labels) writeLabel(grid, l, labelInk(t, l.tone))
  return grid.map((row) => {
    const out: Span[] = []
    for (const k of row) pushSpan(out, { text: k.ch, fg: k.fg, bg: k.bg, attr: k.attr })
    return out
  })
}

/** The picture of `ego` laid out by `lay` in `geo`'s picture, drawn by `mode`. */
export function graphPicture(
  ego: Ego,
  lay: Layout,
  geo: SheetGeo,
  term: GraphTerm,
  mode: GraphMode,
  t: Theme,
  focus: number | null,
  dim: ReadonlySet<number>,
): Picture {
  const at = placeIn(lay, geo.cols, geo.rows, term.cellH / term.cellW)
  const r: Raster =
    mode === "pixels" ? { sx: term.cellW, sy: term.cellH, pixels: true } : { sx: 2, sy: 4, pixels: false }
  const cv = new Canvas(Math.max(1, Math.round(geo.cols * r.sx)), Math.max(1, Math.round(geo.rows * r.sy)))
  drawGraph(cv, ego, at, t, r, focus, dim)
  const gap = ego.nodes.map((n) => (r.pixels ? nodeRadius(n, r.sx) / r.sx : 0))
  const labels = placeLabels(ego, at, gap, geo.cols, geo.rows, focus, dim, ego.rest.length)
  if (r.pixels) return { mode, at, labels, rows: [], rgba: { px: cv.px, w: cv.w, h: cv.h } }
  const paint = (i: number) => (i === focus ? t.text : nodePaint(t, ego.nodes[i]!, dim.has(i)))
  const cells = withGlyphs(brailleCells(cv, geo.cols, geo.rows), ego, at, paint, focus)
  return { mode, at, labels, rows: brailleRows(cells, labels, t), rgba: null }
}

/** The node nearest the middle of cell (col, row) within 2 cells (a row counts `aspect` columns), else null. */
export function nearestNode(at: Placed, col: number, row: number, aspect: number): number | null {
  let best: number | null = null
  let bd = 4
  for (let i = 0; i < at.col.length; i++) {
    const d = (at.col[i]! - col - 0.5) ** 2 + ((at.row[i]! - row - 0.5) * aspect) ** 2
    if (d < bd) [best, bd] = [i, d]
  }
  return best
}
