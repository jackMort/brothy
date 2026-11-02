import { expect, test } from "bun:test"
import { CAP_ALL, CAP_NEAR, egoGraph, noteName } from "../../src/graph/ego"
import { buildLinks } from "../../src/graph/links"
import { STDIN } from "../../src/notes/workspace"
import { hubVault, KITCHEN, vaultOf } from "../helpers/vault"

const { ix, tree } = vaultOf(KITCHEN)
const g = buildLinks(ix, tree)
const shape = (e: ReturnType<typeof egoGraph>) => e.nodes.map((n) => [n.name, n.depth, n.dir, n.parent])

test("depth 2: the centre, its neighbours best connected first then by name, unresolved last, then their neighbours", () => {
  const e = egoGraph(g, "/v/Broth.md", 2)
  expect(shape(e)).toEqual([
    ["Broth", 0, null, -1],
    ["Stock", 1, "both", -1],
    ["Garnish", 1, "in", -1],
    ["Simmering", 1, "out", -1],
    ["Nowhere", 1, "unresolved", -1],
    ["Bones", 2, "out", 1],
  ])
  expect(e.nodes[4]!.path).toBe("?Nowhere")
  expect(e.counts).toEqual({ back: 2, out: 2, unresolved: 1 })
  expect(e.rest).toEqual([])
})

test("edges: once per pair (Stock and Broth link both ways), a < b, the unresolved one to the centre", () => {
  const e = egoGraph(g, "/v/Broth.md", 2)
  expect(e.edges.map((x) => `${x.a}-${x.b}`).sort()).toEqual(["0-1", "0-2", "0-3", "0-4", "1-5"])
})

test("depth 1 stops at the neighbours", () => {
  const e = egoGraph(g, "/v/Broth.md", 1)
  expect(e.nodes.map((n) => n.name)).toEqual(["Broth", "Stock", "Garnish", "Simmering", "Nowhere"])
  expect(e.edges.some((x) => x.b === 5)).toBe(false)
})

test("an orphan is the centre alone; a self link never makes a node", () => {
  const e = egoGraph(g, "/v/Lonely.md", 2)
  expect(e.nodes).toHaveLength(1)
  expect(e.edges).toEqual([])
  expect(egoGraph(g, "/v/Broth.md", 2).nodes.filter((n) => n.name === "Broth")).toHaveLength(1)
})

test(`caps: ${CAP_NEAR} neighbours drawn, the rest listed; ${CAP_ALL} nodes in all at depth 2`, () => {
  const hub = hubVault()
  const hg = buildLinks(hub.ix, hub.tree)
  const two = egoGraph(hg, "/v/Hub.md", 2)
  expect(two.nodes.filter((n) => n.depth === 1)).toHaveLength(CAP_NEAR)
  expect(two.nodes).toHaveLength(CAP_ALL)
  expect(two.rest.map((n) => n.name)).toEqual(["n18", "n19", "n20", "n21", "n22", "n23", "n24"])
  expect(two.nodes.slice(19, 21).map((n) => n.name)).toEqual(["a00", "b00"])
  expect(egoGraph(hg, "/v/Hub.md", 1).nodes).toHaveLength(CAP_NEAR + 1)
})

test("noteName: the file's stem, `stdin` for a piped document", () => {
  expect(noteName("/v/d/Soup Base.md")).toBe("Soup Base")
  expect(noteName(STDIN)).toBe("stdin")
})
