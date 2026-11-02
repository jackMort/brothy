import { expect, test } from "bun:test"
import { buildLinks, degree } from "../../src/graph/links"
import { STDIN } from "../../src/notes/workspace"
import { KITCHEN, vaultOf } from "../helpers/vault"

const { ix, tree } = vaultOf(KITCHEN)

test("out and back links by path; a self link is dropped; an unresolved target is kept by its text", () => {
  const g = buildLinks(ix, tree)
  expect([...g.out.get("/v/Broth.md")!]).toEqual(["/v/Stock.md", "/v/Simmering.md"])
  expect([...g.back.get("/v/Broth.md")!].sort()).toEqual(["/v/Garnish.md", "/v/Stock.md"])
  expect(g.unresolved.get("/v/Broth.md")).toEqual(["Nowhere"])
  expect(g.out.get("/v/Simmering.md")).toBeUndefined()
  expect(g.back.get("/v/Lonely.md")).toBeUndefined()
  expect(g.notes).toBe(6)
})

test("degree counts the links in and out", () => {
  const g = buildLinks(ix, tree)
  expect(degree(g, "/v/Stock.md")).toBe(3)
  expect(degree(g, "/v/Lonely.md")).toBe(0)
})

test("a live note's targets stand in for its index entry (a piped document is not in the index)", () => {
  const piped = buildLinks(ix, tree, { path: STDIN, targets: ["Bones", "Ghost"] })
  expect([...piped.out.get(STDIN)!]).toEqual(["/v/Bones.md"])
  expect(piped.back.get("/v/Bones.md")!.has(STDIN)).toBe(true)
  expect(piped.unresolved.get(STDIN)).toEqual(["Ghost"])
  const edited = buildLinks(ix, tree, { path: "/v/Broth.md", targets: [] })
  expect(edited.out.get("/v/Broth.md")).toBeUndefined()
})
