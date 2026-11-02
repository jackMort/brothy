import { expect, test } from "bun:test"
import { Canvas, drawGraph, hexOf, nodePaint, rgb, roleColor } from "../../src/graph/canvas"
import type { Ego } from "../../src/graph/ego"
import { mix } from "../../src/theme/theme"
import { DIM_OTHER } from "../../src/ui/footnote"
import { brothy as t } from "../helpers/theme"

const px = (cv: Canvas, x: number, y: number) => [...cv.px.subarray((y * cv.w + x) * 4, (y * cv.w + x) * 4 + 4)]
/** A centre linking out to one note. */
const two = (): Ego => ({
  nodes: [
    { path: "/v/a.md", name: "a", depth: 0, dir: null, degree: 1, parent: -1 },
    { path: "/v/b.md", name: "b", depth: 1, dir: "out", degree: 1, parent: -1 },
  ],
  edges: [{ a: 0, b: 1 }],
  rest: [],
  counts: { back: 0, out: 1, unresolved: 0 },
})
const NONE: ReadonlySet<number> = new Set()

test("rgb and hexOf round-trip", () => {
  expect(rgb("#fe9962")).toEqual([254, 153, 98])
  expect(hexOf(rgb("#0a0b0c"))).toBe("#0a0b0c")
})

test("line: covers its pixels, leaves the rest transparent; a zero-length line is a dot, never NaN", () => {
  const cv = new Canvas(20, 10)
  cv.line(2, 5, 18, 5, [255, 0, 0])
  expect(px(cv, 10, 4)).toEqual([255, 0, 0, expect.any(Number)])
  expect(px(cv, 10, 4)[3]).toBeGreaterThan(100)
  expect(px(cv, 10, 0)[3]).toBe(0)
  const steep = new Canvas(10, 20)
  steep.line(5, 2, 5, 18, [0, 255, 0])
  expect(px(steep, 4, 10)[3]).toBeGreaterThan(100)
  const dot = new Canvas(10, 10)
  dot.line(5, 5, 5, 5, [0, 0, 255])
  expect(px(dot, 5, 5)[3]).toBeGreaterThan(0)
})

test("roles: centre primary, out secondary, in and both accent, unresolved textMuted, depth 2 dimmed", () => {
  expect(roleColor(t, null, 0)).toBe(t.primary)
  expect(roleColor(t, "out", 1)).toBe(t.secondary)
  expect(roleColor(t, "in", 1)).toBe(t.accent)
  expect(roleColor(t, "both", 1)).toBe(t.accent)
  expect(roleColor(t, "unresolved", 1)).toBe(t.textMuted)
  expect(roleColor(t, "out", 2)).toBe(mix(t.secondary, t.background, DIM_OTHER))
  expect(nodePaint(t, two().nodes[1]!, true)).toBe(mix(t.secondary, t.background, DIM_OTHER))
})

test("pixels: the edge's midpoint in its role, the centre node primary, the rest transparent", () => {
  const cv = new Canvas(80, 64)
  drawGraph(
    cv,
    two(),
    { col: Float64Array.of(2, 8), row: Float64Array.of(2, 2) },
    t,
    { sx: 8, sy: 16, pixels: true },
    null,
    NONE,
  )
  expect(px(cv, 40, 32).slice(0, 3)).toEqual([...rgb(t.secondary)])
  expect(px(cv, 40, 32)[3]).toBeGreaterThan(100)
  expect(px(cv, 16, 32).slice(0, 3)).toEqual([...rgb(t.primary)])
  expect(px(cv, 0, 0)[3]).toBe(0)
  expect(px(cv, 40, 5)[3]).toBe(0)
})

test("braille raster: edges only, no discs (glyphs stand for the nodes)", () => {
  const cv = new Canvas(16, 8)
  drawGraph(
    cv,
    two(),
    { col: Float64Array.of(1, 7), row: Float64Array.of(1, 1) },
    t,
    { sx: 2, sy: 4, pixels: false },
    null,
    NONE,
  )
  expect(px(cv, 8, 4).slice(0, 3)).toEqual([...rgb(t.secondary)])
  expect(px(cv, 2, 4).slice(0, 3)).toEqual([...rgb(t.secondary)])
})
