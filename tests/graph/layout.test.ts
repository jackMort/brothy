import { expect, test } from "bun:test"
import { egoGraph } from "../../src/graph/ego"
import { forceLayout, LABEL_ROOM, placeIn, seedOf } from "../../src/graph/layout"
import { buildLinks } from "../../src/graph/links"
import { hubVault, KITCHEN, vaultOf } from "../helpers/vault"

const { ix, tree } = vaultOf(KITCHEN)
const ego = egoGraph(buildLinks(ix, tree), "/v/Broth.md", 2)

test("the same graph and seed land the same way; another seed lands elsewhere", () => {
  const a = forceLayout(ego, seedOf("/v/Broth.md"))
  const b = forceLayout(ego, seedOf("/v/Broth.md"))
  expect([...a.x]).toEqual([...b.x])
  expect([...a.y]).toEqual([...b.y])
  expect([...forceLayout(ego, seedOf("/v/Other.md")).x]).not.toEqual([...a.x])
})

test("the centre stays at the origin; nothing is NaN, also for 40 nodes", () => {
  const hub = hubVault()
  for (const e of [ego, egoGraph(buildLinks(hub.ix, hub.tree), "/v/Hub.md", 2)]) {
    const p = forceLayout(e, 7)
    expect([p.x[0], p.y[0]]).toEqual([0, 0])
    expect([...p.x, ...p.y].every(Number.isFinite)).toBe(true)
  }
})

test("placeIn: every node inside the picture; the centre a quarter of the label room left of the middle", () => {
  const at = placeIn(forceLayout(ego, 1), 70, 28, 2)
  for (let i = 0; i < ego.nodes.length; i++) {
    expect(at.col[i]!).toBeGreaterThanOrEqual(0)
    expect(at.col[i]!).toBeLessThan(70)
    expect(at.row[i]!).toBeGreaterThanOrEqual(0)
    expect(at.row[i]!).toBeLessThan(28)
  }
  expect(at.col[0]!).toBeCloseTo(35 - LABEL_ROOM / 4)
  expect(at.row[0]!).toBeCloseTo(14)
})

test("a lone centre sits at the middle, also in a tiny picture", () => {
  const lone = egoGraph(buildLinks(ix, tree), "/v/Lonely.md", 2)
  const at = placeIn(forceLayout(lone, 1), 10, 3, 2)
  expect([...at.col, ...at.row].every(Number.isFinite)).toBe(true)
  expect(at.row[0]!).toBeCloseTo(1.5)
})
