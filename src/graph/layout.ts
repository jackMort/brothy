// The ego graph's layout: rings by depth, then Fruchterman–Reingold forces with the centre pinned, from a seed taken
// from the centre's path, so a redraw never moves a node. Then fitted into the picture, in cells. Pure.
import type { Ego, EgoEdge } from "./ego"

/** steps of the force layout */
const ITERS = 300
/** the ideal edge length and the ring spacing, layout units */
const K = 70
const RING = 100
/** cells kept clear at the picture's edges, and kept at most on the right for labels */
const PAD = 2
export const LABEL_ROOM = 14

export interface Layout {
  x: Float64Array
  y: Float64Array
}
/** Node positions in the picture, in cells (fractional). */
export interface Placed {
  col: Float64Array
  row: Float64Array
}
interface Forces {
  dx: Float64Array
  dy: Float64Array
}

/** FNV-1a over `s`: the layout's seed. */
export function seedOf(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** A seeded LCG over [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Each depth on its own ring, evenly spread, a little jitter; the centre at 0. */
function rings(ego: Ego, rand: () => number): Layout {
  const n = ego.nodes.length
  const p: Layout = { x: new Float64Array(n), y: new Float64Array(n) }
  const byDepth: number[][] = [[], [], []]
  ego.nodes.forEach((nd, i) => byDepth[nd.depth]!.push(i))
  byDepth.forEach((list, d) =>
    list.forEach((i, k) => {
      const a = (2 * Math.PI * k) / list.length + d * 0.5 + rand() * 0.2
      p.x[i] = d * RING * Math.cos(a)
      p.y[i] = d * RING * Math.sin(a)
    }),
  )
  return p
}

/** Nodes `i` and `j` push apart (two on one spot are nudged apart at random). */
function pushApart(p: Layout, f: Forces, i: number, j: number, rand: () => number) {
  let ex = p.x[i]! - p.x[j]!
  let ey = p.y[i]! - p.y[j]!
  let d2 = ex * ex + ey * ey
  if (d2 < 0.01) {
    ex = rand() - 0.5
    ey = rand() - 0.5
    d2 = 0.01
  }
  const k = (K * K) / d2
  f.dx[i] = f.dx[i]! + ex * k
  f.dy[i] = f.dy[i]! + ey * k
  f.dx[j] = f.dx[j]! - ex * k
  f.dy[j] = f.dy[j]! - ey * k
}

function repel(p: Layout, f: Forces, rand: () => number) {
  for (let i = 0; i < p.x.length; i++) for (let j = i + 1; j < p.x.length; j++) pushApart(p, f, i, j, rand)
}

/** Every edge pulls its ends together like a spring. */
function attract(p: Layout, f: Forces, edges: readonly EgoEdge[]) {
  for (const { a, b } of edges) {
    const ex = p.x[a]! - p.x[b]!
    const ey = p.y[a]! - p.y[b]!
    const s = (Math.hypot(ex, ey) || 0.01) / K
    f.dx[a] = f.dx[a]! - ex * s
    f.dy[a] = f.dy[a]! - ey * s
    f.dx[b] = f.dx[b]! + ex * s
    f.dy[b] = f.dy[b]! + ey * s
  }
}

/** Every node but the centre moves along its force, pulled a little toward the middle, at most `temp`. */
function move(p: Layout, f: Forces, temp: number) {
  for (let i = 1; i < p.x.length; i++) {
    const fx = f.dx[i]! - p.x[i]! * 0.02
    const fy = f.dy[i]! - p.y[i]! * 0.02
    const d = Math.hypot(fx, fy) || 1
    const s = Math.min(d, temp) / d
    p.x[i] = p.x[i]! + fx * s
    p.y[i] = p.y[i]! + fy * s
  }
}

/** The layout of `ego` from `seed`: O(n² · iters), fine for 40 nodes. */
export function forceLayout(ego: Ego, seed: number, iters = ITERS): Layout {
  const rand = rng(seed)
  const p = rings(ego, rand)
  const f: Forces = { dx: new Float64Array(p.x.length), dy: new Float64Array(p.x.length) }
  for (let it = 0; it < iters; it++) {
    f.dx.fill(0)
    f.dy.fill(0)
    repel(p, f, rand)
    attract(p, f, ego.edges)
    move(p, f, 20 * (1 - it / iters) + 0.5)
  }
  return p
}

/** `p` fitted into `cols` × `rows` cells (a row is `aspect` columns tall), the centre in the middle less room for labels. */
export function placeIn(p: Layout, cols: number, rows: number, aspect: number): Placed {
  let mx = 1
  let my = 1
  for (let i = 0; i < p.x.length; i++) {
    mx = Math.max(mx, Math.abs(p.x[i]!))
    my = Math.max(my, Math.abs(p.y[i]!))
  }
  const room = Math.min(LABEL_ROOM, cols / 4)
  const halfW = Math.max(1, cols / 2 - PAD - room / 2)
  const halfH = Math.max(0.5, rows / 2 - PAD / 2)
  const s = Math.min(halfW / mx, (halfH * aspect) / my)
  const cx = cols / 2 - room / 4
  const cy = rows / 2
  return { col: p.x.map((v) => cx + v * s), row: p.y.map((v) => cy + (v * s) / aspect) }
}
