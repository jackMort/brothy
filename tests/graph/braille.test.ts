import { expect, test } from "bun:test"
import { brailleCells, withGlyphs } from "../../src/graph/braille"
import { Canvas } from "../../src/graph/canvas"
import type { Ego } from "../../src/graph/ego"

test("a horizontal line through the second dot row of each cell is ⠒ in the line's colour; empty cells are null", () => {
  const cv = new Canvas(8, 8)
  cv.line(0, 1.5, 8, 1.5, [255, 0, 0], 0.9)
  const cells = brailleCells(cv, 4, 2)
  expect(cells[0]).toEqual(Array(4).fill({ ch: "⠒", fg: "#ff0000" }))
  expect(cells[1]).toEqual([null, null, null, null])
})

test("glyphs: ◉ the centre and the focused node, ● depth 1, • depth 2, ○ unresolved; the centre wins a shared cell", () => {
  const ego: Ego = {
    nodes: [
      { path: "/v/a.md", name: "a", depth: 0, dir: null, degree: 3, parent: -1 },
      { path: "/v/b.md", name: "b", depth: 1, dir: "out", degree: 1, parent: -1 },
      { path: "?c", name: "c", depth: 1, dir: "unresolved", degree: 0, parent: -1 },
      { path: "/v/d.md", name: "d", depth: 2, dir: "in", degree: 1, parent: 1 },
      { path: "/v/e.md", name: "e", depth: 1, dir: "in", degree: 1, parent: -1 },
    ],
    edges: [],
    rest: [],
    counts: { back: 1, out: 1, unresolved: 1 },
  }
  const at = { col: Float64Array.of(0.5, 3.2, 1.1, 2.9, 0.7), row: Float64Array.of(0.5, 1.7, 1.2, 0.4, 0.6) }
  const empty = Array.from({ length: 2 }, () => Array<null>(4).fill(null))
  const out = withGlyphs(empty, ego, at, (i) => `#00000${i}`, 1)
  expect(out[0]![0]).toEqual({ ch: "◉", fg: "#000000" })
  expect(out[1]![3]).toEqual({ ch: "◉", fg: "#000001" })
  expect(out[1]![1]!.ch).toBe("○")
  expect(out[0]![2]!.ch).toBe("•")
  expect(empty[0]![0]).toBeNull() // the input is not changed
})
