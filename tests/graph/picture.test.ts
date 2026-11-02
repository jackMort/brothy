import { expect, test } from "bun:test"
import { egoGraph } from "../../src/graph/ego"
import { forceLayout } from "../../src/graph/layout"
import { buildLinks } from "../../src/graph/links"
import { dimOf, graphPicture, labelInk, nearestNode } from "../../src/graph/picture"
import { sheetGeo } from "../../src/graph/sheet"
import { A } from "../../src/lib/spans"
import { spanWidth } from "../../src/lib/text"
import { brothy as t } from "../helpers/theme"
import { KITCHEN, vaultOf } from "../helpers/vault"

const { ix, tree } = vaultOf(KITCHEN)
const ego = egoGraph(buildLinks(ix, tree), "/v/Broth.md", 2)
const lay = forceLayout(ego, 1)
const geo = sheetGeo(120, 34)
const term = { pixels: false, mux: false, cellW: 8, cellH: 16 }
const NONE: ReadonlySet<number> = new Set()

test("braille: rows of exactly the picture's width with dots, glyphs and the labels written in", () => {
  const p = graphPicture(ego, lay, geo, term, "braille", t, 1, NONE)
  expect(p.rgba).toBeNull()
  expect(p.rows).toHaveLength(geo.rows)
  for (const r of p.rows) expect(spanWidth(r)).toBe(geo.cols)
  const text = p.rows.map((r) => r.map((s) => s.text).join("")).join("\n")
  expect(text).toContain("◉")
  expect(text).toMatch(/[⠁-⣿]/)
  expect(text).toContain("Broth")
  expect(p.labels.find((l) => l.i === 1)!.tone).toBe("focus")
})

test("pixels: an RGBA raster at the picture's size in pixels, no rows; the labels still in cells", () => {
  const p = graphPicture(ego, lay, geo, { ...term, pixels: true }, "pixels", t, null, NONE)
  expect(p.rows).toEqual([])
  expect([p.rgba!.w, p.rgba!.h, p.rgba!.px.length]).toEqual([
    geo.cols * 8,
    geo.rows * 16,
    geo.cols * 8 * geo.rows * 16 * 4,
  ])
  expect(p.labels.some((l) => l.text === "Broth")).toBe(true)
})

test("labelInk: the centre bold primary, the focus bold on the element background, depth 2 muted", () => {
  expect(labelInk(t, "centre")).toEqual({ fg: t.primary, attr: A.BOLD })
  expect(labelInk(t, "focus")).toEqual({ fg: t.text, bg: t.backgroundElement, attr: A.BOLD })
  expect(labelInk(t, "far")).toEqual({ fg: t.textMuted })
})

test("nearestNode: within 2 cells of a node (a row counts `aspect` columns), else null", () => {
  const at = { col: Float64Array.of(10, 20), row: Float64Array.of(5, 5) }
  expect(nearestNode(at, 10, 5, 2)).toBe(0)
  expect(nearestNode(at, 19, 4, 2)).toBe(1)
  expect(nearestNode(at, 15, 5, 2)).toBeNull()
  expect(nearestNode(at, 10, 7, 2)).toBeNull()
})

test("dimOf: every node but the centre whose name the filter misses", () => {
  expect([...dimOf(ego, "sto")]).toEqual([2, 3, 4, 5])
  expect(dimOf(ego, "").size).toBe(0)
})
