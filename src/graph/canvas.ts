// An RGBA canvas for the graph picture: anti-aliased lines, discs and rings, source-over on a transparent background
// (the popup shows through), and the graph drawn on it in theme roles. Pure.
import { clamp } from "../lib/text"
import { mix, type Theme } from "../theme/theme"
import { DIM_OTHER } from "../ui/footnote"
import type { Dir, Ego, EgoEdge, EgoNode } from "./ego"
import type { Placed } from "./layout"

type RGB = readonly [number, number, number]
export const rgb = (hex: string): RGB => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]
export const hexOf = (c: readonly number[]) =>
  `#${c
    .slice(0, 3)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`

/** A segment from (x0, y0) along (vx, vy). */
interface Seg {
  x0: number
  y0: number
  vx: number
  vy: number
}
/** The segment's cross-axis position at major-axis step `a`, clamped to the segment. */
function crossAt(s: Seg, steep: boolean, a: number) {
  const [d, o, v, w] = steep ? [s.vy, s.y0, s.vx, s.x0] : [s.vx, s.x0, s.vy, s.y0]
  return w + (d ? clamp((a + 0.5 - o) / d, 0, 1) : 0) * v
}
/** Distance from (px, py) to the segment. */
function segDist(s: Seg, px: number, py: number) {
  const len2 = s.vx * s.vx + s.vy * s.vy || 1
  const u = clamp(((px - s.x0) * s.vx + (py - s.y0) * s.vy) / len2, 0, 1)
  return Math.hypot(px - (s.x0 + u * s.vx), py - (s.y0 + u * s.vy))
}

export class Canvas {
  readonly px: Uint8Array
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Uint8Array(w * h * 4)
  }

  /** Source-over `c` at alpha `a` (0–1) onto pixel (x, y); outside the canvas, nothing. */
  blend(x: number, y: number, c: RGB, a: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return
    const o = (y * this.w + x) * 4
    const da = this.px[o + 3]! / 255
    const oa = a + da * (1 - a)
    for (let i = 0; i < 3; i++) this.px[o + i] = Math.round((c[i]! * a + this.px[o + i]! * da * (1 - a)) / oa)
    this.px[o + 3] = Math.round(oa * 255)
  }

  /** An anti-aliased line `wd` wide: along the major axis, the few pixels across it at each step. */
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, wd = 1.2, alpha = 1) {
    const s: Seg = { x0, y0, vx: x1 - x0, vy: y1 - y0 }
    const steep = Math.abs(s.vy) > Math.abs(s.vx)
    const half = Math.ceil(wd / 2 + 1.5)
    const lo = steep ? Math.min(y0, y1) : Math.min(x0, x1)
    const hi = steep ? Math.max(y0, y1) : Math.max(x0, x1)
    for (let a = Math.floor(lo - half); a <= Math.ceil(hi + half); a++)
      this.across(s, steep, a, half, c, wd * 0.5, alpha)
  }

  private across(s: Seg, steep: boolean, a: number, half: number, c: RGB, hw: number, alpha: number) {
    const b = crossAt(s, steep, a)
    for (let k = Math.floor(b - half); k <= Math.ceil(b + half); k++) {
      const x = steep ? k : a
      const y = steep ? a : k
      this.blend(x, y, c, clamp(hw + 0.5 - segDist(s, x + 0.5, y + 0.5), 0, 1) * alpha)
    }
  }

  /** Every pixel within `reach` of (cx, cy), at the coverage `cov` gives its distance. */
  private round(cx: number, cy: number, reach: number, c: RGB, cov: (d: number) => number) {
    for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y++)
      for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++)
        this.blend(x, y, c, clamp(cov(Math.hypot(x + 0.5 - cx, y + 0.5 - cy)), 0, 1))
  }

  disc(cx: number, cy: number, r: number, c: RGB) {
    this.round(cx, cy, r + 2, c, (d) => r + 0.5 - d)
  }

  ring(cx: number, cy: number, r: number, c: RGB, wd = 1.2) {
    this.round(cx, cy, r + wd + 2, c, (d) => wd / 2 + 0.5 - Math.abs(d - r))
  }
}

/** How the picture is rastered: pixels per cell, and whether nodes are discs (pixels) or left to glyphs (braille). */
export interface Raster {
  sx: number
  sy: number
  pixels: boolean
}

const ROLE: Record<Dir, "secondary" | "accent" | "textMuted"> = {
  out: "secondary",
  in: "accent",
  both: "accent",
  unresolved: "textMuted",
}

/** A node's role: the centre primary, outgoing secondary, backlinks and both ways accent, unresolved muted; depth 2 dimmed. */
export function roleColor(t: Theme, dir: Dir | null, depth: number): string {
  const c = dir === null ? t.primary : t[ROLE[dir]]
  return depth === 2 ? mix(c, t.background, DIM_OTHER) : c
}

/** A node's colour, dimmed once more when the filter passes it by. */
export const nodePaint = (t: Theme, n: EgoNode, dim: boolean) => {
  const c = roleColor(t, n.dir, n.depth)
  return dim ? mix(c, t.background, DIM_OTHER) : c
}

/** The base radius by kind: the centre, an unresolved target, a depth-1 note, a depth-2 note. */
function baseRadius(n: EgoNode): number {
  if (n.depth === 0) return 7
  if (n.dir === "unresolved") return 4
  return n.depth === 1 ? 5 : 3.5
}

/** A node's radius in raster pixels (sized for 8-pixel-wide cells, scaled to `sx`). */
const nodeRadius = (n: EgoNode, sx: number) => baseRadius(n) * (sx / 8)

/** An edge's colour: its farther node's role; between two nodes of one depth a neutral (`border`, or `textMuted` in braille: dots are sparse). */
function edgeColor(t: Theme, ego: Ego, e: EgoEdge, pixels: boolean): string {
  const a = ego.nodes[e.a]!
  const b = ego.nodes[e.b]!
  if (a.depth !== b.depth) return roleColor(t, b.dir, b.depth)
  return mix(pixels ? t.border : t.textMuted, t.background, b.depth === 2 ? DIM_OTHER : 0)
}

/** Edges to the centre a little heavier; braille draws every edge solid (a dot is on or off). */
const stroke = (r: Raster, e: EgoEdge) =>
  r.pixels ? { w: (e.a === 0 ? 1.4 : 1) * (r.sx / 8), alpha: e.a === 0 ? 0.9 : 0.6 } : { w: 0.9, alpha: 1 }

function drawNode(
  cv: Canvas,
  n: EgoNode,
  x: number,
  y: number,
  t: Theme,
  sx: number,
  o: { focus: boolean; dim: boolean },
) {
  const r = nodeRadius(n, sx)
  const k = sx / 8
  const c = rgb(nodePaint(t, n, o.dim))
  if (n.dir === "unresolved") cv.ring(x, y, r, c, 1.2 * k)
  else cv.disc(x, y, r, c)
  if (n.dir === "both") cv.ring(x, y, r + 2.2 * k, rgb(t.secondary), 1.2 * k)
  if (o.focus) cv.ring(x, y, r + 4 * k, rgb(t.text), 1.6 * k)
}

/** The graph on `cv`: the edges, then (pixels only) the nodes, the centre on top. */
export function drawGraph(
  cv: Canvas,
  ego: Ego,
  at: Placed,
  t: Theme,
  r: Raster,
  focus: number | null,
  dim: ReadonlySet<number>,
) {
  const x = (i: number) => at.col[i]! * r.sx
  const y = (i: number) => at.row[i]! * r.sy
  for (const e of ego.edges) {
    const { w, alpha } = stroke(r, e)
    cv.line(x(e.a), y(e.a), x(e.b), y(e.b), rgb(edgeColor(t, ego, e, r.pixels)), w, alpha)
  }
  if (!r.pixels) return
  for (let i = ego.nodes.length - 1; i >= 0; i--)
    drawNode(cv, ego.nodes[i]!, x(i), y(i), t, r.sx, { focus: i === focus, dim: dim.has(i) })
}
