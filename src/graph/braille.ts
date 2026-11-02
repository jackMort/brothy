// The graph picture in braille: the canvas drawn at 2×4 dots per cell, each cell one glyph in its most opaque pixel's
// colour (the minimap's idiom), and the nodes as glyphs over it. Pure.
import { BIT } from "../ui/minimap"
import { type Canvas, hexOf } from "./canvas"
import type { Ego, EgoNode } from "./ego"
import type { Placed } from "./layout"

/** A pixel at least this opaque (of 255) is a dot. */
const INK = 90

export interface Cell {
  ch: string
  fg: string
}

/** Cell (col, row)'s dots and its most opaque pixel's colour; null with no dot. */
function cellAt(cv: Canvas, col: number, row: number): Cell | null {
  let bits = 0
  let best = 0
  let at = 0
  for (let dy = 0; dy < 4; dy++)
    for (let dx = 0; dx < 2; dx++) {
      const o = ((row * 4 + dy) * cv.w + col * 2 + dx) * 4
      const a = cv.px[o + 3]!
      if (a > INK) bits |= BIT[dy]![dx]!
      if (a > best) [best, at] = [a, o]
    }
  return bits ? { ch: String.fromCharCode(0x2800 + bits), fg: hexOf([...cv.px.subarray(at, at + 3)]) } : null
}

/** `cols` × `rows` cells from a canvas drawn at 2 × 4 pixels per cell. */
export function brailleCells(cv: Canvas, cols: number, rows: number): (Cell | null)[][] {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cellAt(cv, c, r)))
}

function glyph(n: EgoNode, focused: boolean): string {
  if (n.depth === 0 || focused) return "◉"
  if (n.dir === "unresolved") return "○"
  return n.depth === 2 ? "•" : "●"
}

/** `cells` with each node's glyph in its cell, in `paint(i)`; later nodes first, so the centre wins a shared cell. */
export function withGlyphs(
  cells: readonly (Cell | null)[][],
  ego: Ego,
  at: Placed,
  paint: (i: number) => string,
  focus: number | null,
): (Cell | null)[][] {
  const out = cells.map((r) => [...r])
  for (let i = ego.nodes.length - 1; i >= 0; i--) {
    const row = out[Math.floor(at.row[i]!)]
    const c = Math.floor(at.col[i]!)
    if (row && c >= 0 && c < row.length) row[c] = { ch: glyph(ego.nodes[i]!, i === focus), fg: paint(i) }
  }
  return out
}
