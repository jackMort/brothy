// Note names over the picture, in cells: right of each node, else left, else below or above, one blank cell around each;
// a label that would touch another or cover a node is dropped, except the centre's and the focused node's. Pure.
import { truncate, width } from "../lib/text"
import type { Ego } from "./ego"
import type { Placed } from "./layout"

/** Columns a label gets at most. */
const LABEL_MAX = 18

export type LabelTone = "centre" | "focus" | "near" | "far"
/** A label at (row, col); `i` is its node, -1 the `+n more` note under the centre. */
export interface Label {
  i: number
  row: number
  col: number
  text: string
  tone: LabelTone
}

type Spot = [row: number, col: number]
interface Room {
  cols: number
  rows: number
  /** "row:col" of every cell a node or a label (with its blank) holds */
  taken: Set<string>
}
const key = (r: number, c: number) => `${r}:${c}`

/** The cells the nodes cover: their glyph, or a disc `gap` cells across. */
function nodeCells(at: Placed, gap: readonly number[]): Set<string> {
  const taken = new Set<string>()
  for (let i = 0; i < at.col.length; i++)
    for (let c = Math.floor(at.col[i]! - gap[i]!); c <= Math.floor(at.col[i]! + gap[i]!); c++)
      taken.add(key(Math.floor(at.row[i]!), c))
  return taken
}

/** The centre, the focused node, then depth 1 and depth 2, best connected first. */
function order(ego: Ego, focus: number | null): number[] {
  const rest = ego.nodes
    .map((_, i) => i)
    .filter((i) => i !== 0 && i !== focus)
    .sort((a, b) => ego.nodes[a]!.depth - ego.nodes[b]!.depth || ego.nodes[b]!.degree - ego.nodes[a]!.degree)
  return focus !== null && focus !== 0 ? [0, focus, ...rest] : [0, ...rest]
}

/** Right of the node, left of it, below, above. */
function around(col: number, row: number, gap: number, len: number): Spot[] {
  const r = Math.floor(row)
  const mid = Math.floor(col) - Math.floor(len / 2)
  return [
    [r, Math.floor(col + gap) + 2],
    [r, Math.floor(col - gap) - len - 1],
    [r + 1, mid],
    [r - 1, mid],
  ]
}

const inside = (room: Room, [r, c]: Spot, len: number) => r >= 0 && r < room.rows && c >= 0 && c + len <= room.cols

function free(room: Room, s: Spot, len: number) {
  if (!inside(room, s, len)) return false
  for (let k = -1; k <= len; k++) if (room.taken.has(key(s[0], s[1] + k))) return false
  return true
}

/** The first free spot for `l`; one that must show takes the first spot inside the picture even over others. */
function put(room: Room, out: Label[], l: Omit<Label, "row" | "col">, spots: Spot[], must: boolean) {
  const len = width(l.text)
  const s = spots.find((x) => free(room, x, len)) ?? (must ? spots.find((x) => inside(room, x, len)) : undefined)
  if (!s) return
  for (let k = -1; k <= len; k++) room.taken.add(key(s[0], s[1] + k))
  out.push({ ...l, row: s[0], col: s[1] })
}

const toneOf = (ego: Ego, i: number, focus: number | null): LabelTone => {
  const n = ego.nodes[i]!
  if (i === 0) return "centre"
  if (i === focus) return "focus"
  return n.depth === 1 && n.dir !== "unresolved" ? "near" : "far"
}

/** The labels of every node `dim` leaves alone, and `+more more` under the centre when neighbours are past the cap. */
export function placeLabels(
  ego: Ego,
  at: Placed,
  gap: readonly number[],
  cols: number,
  rows: number,
  focus: number | null,
  dim: ReadonlySet<number>,
  more: number,
): Label[] {
  const room: Room = { cols, rows, taken: nodeCells(at, gap) }
  const out: Label[] = []
  for (const i of order(ego, focus)) {
    if (dim.has(i)) continue
    const text = truncate(ego.nodes[i]!.name, LABEL_MAX)
    const spots = around(at.col[i]!, at.row[i]!, gap[i]!, width(text))
    put(room, out, { i, text, tone: toneOf(ego, i, focus) }, spots, i === 0 || i === focus)
    if (i !== 0 || !more) continue
    const note = `+${more} more`
    put(
      room,
      out,
      { i: -1, text: note, tone: "far" },
      around(at.col[0]!, at.row[0]!, gap[0]!, width(note)).slice(2),
      false,
    )
  }
  return out
}
