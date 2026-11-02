import { expect, test } from "bun:test"
import { type Ego, egoGraph } from "../../src/graph/ego"
import { placeLabels } from "../../src/graph/labels"
import type { Placed } from "../../src/graph/layout"
import { buildLinks } from "../../src/graph/links"
import { truncate, width } from "../../src/lib/text"
import { KITCHEN, vaultOf } from "../helpers/vault"

const { ix, tree } = vaultOf(KITCHEN)
const ego = egoGraph(buildLinks(ix, tree), "/v/Broth.md", 2) // Broth, Stock, Garnish, Simmering, Nowhere, Bones
const at = (pts: [number, number][]): Placed => ({
  col: Float64Array.from(pts.map((p) => p[0])),
  row: Float64Array.from(pts.map((p) => p[1])),
})
const zero = (n: number) => Array<number>(n).fill(0)
const NONE: ReadonlySet<number> = new Set()
const solo = (name: string): Ego => ({
  nodes: [{ path: "/v/x.md", name, depth: 0, dir: null, degree: 0, parent: -1 }],
  edges: [],
  rest: [],
  counts: { back: 0, out: 0, unresolved: 0 },
})

test("each label right of its node with one cell between; no two labels touch; no label covers a node", () => {
  const p = at([
    [20, 10],
    [30, 5],
    [30, 15],
    [10, 10],
    [5, 3],
    [40, 5],
  ])
  const ls = placeLabels(ego, p, zero(6), 60, 20, null, NONE, 0)
  expect(ls.find((l) => l.i === 0)).toEqual({ i: 0, row: 10, col: 22, text: "Broth", tone: "centre" })
  expect(ls.find((l) => l.i === 5)).toMatchObject({ row: 5, col: 42, tone: "far" })
  expect(ls.find((l) => l.i === 4)!.tone).toBe("far") // unresolved reads muted
  const cells = ls.flatMap((l) => Array.from({ length: width(l.text) + 2 }, (_, k) => `${l.row}:${l.col - 1 + k}`))
  expect(new Set(cells).size).toBe(cells.length)
  for (const l of ls)
    for (let i = 0; i < 6; i++)
      if (Math.floor(p.row[i]!) === l.row) {
        const c = Math.floor(p.col[i]!)
        expect(c < l.col || c >= l.col + width(l.text)).toBe(true)
      }
})

test("crowded: the centre's and the focused node's labels stay", () => {
  const p = at(Array.from({ length: 6 }, (): [number, number] => [10, 2]))
  const ls = placeLabels(ego, p, zero(6), 40, 5, 3, NONE, 0)
  expect(ls.find((l) => l.i === 0)!.tone).toBe("centre")
  expect(ls.find((l) => l.i === 3)!.tone).toBe("focus")
})

test("a long name is cut to 18 cells with …; a wide one by its width", () => {
  const [l] = placeLabels(solo("A very long note name indeed"), at([[2, 1]]), [0], 60, 3, null, NONE, 0)
  expect(l!.text).toBe(truncate("A very long note name indeed", 18))
  const [w] = placeLabels(solo("鍋".repeat(12)), at([[2, 1]]), [0], 60, 3, null, NONE, 0)
  expect(width(w!.text)).toBeLessThanOrEqual(18)
  expect(w!.text.endsWith("…")).toBe(true)
})

test("`+n more` sits under the centre; a node the filter dims has no label", () => {
  const p = at([
    [20, 10],
    [30, 5],
    [30, 15],
    [10, 10],
    [5, 3],
    [40, 5],
  ])
  const ls = placeLabels(ego, p, zero(6), 60, 20, null, new Set([1]), 7)
  expect(ls.find((l) => l.i === -1)).toMatchObject({ row: 11, text: "+7 more", tone: "far" })
  expect(ls.some((l) => l.i === 1)).toBe(false)
})
