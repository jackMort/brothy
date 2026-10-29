import { expect, test } from "bun:test"
import { basename, join } from "node:path"
import { projectRoot, STDIN, stdinWorkspace, workspace } from "../../src/notes/workspace"
import { useTmp } from "../helpers/tmp"

const fixture = useTmp("brothy-workspace-")

test("a folder opens its README first, whatever its case", () => {
  const root = fixture(["a.md", "ReadMe.md", "z.md"])
  const w = workspace(root)
  expect(w.openPath).toBe(join(root, "ReadMe.md"))
  expect(w.root).toBe(root)
  expect(w.expanded.size).toBe(0)
})

test("without a README the first top-level note opens, else the first note in a folder, which is expanded", () => {
  expect(workspace(fixture(["only.md", "docs/deep.md"])).openPath).toEndWith("only.md")
  const root = fixture(["docs/deep.md"])
  const w = workspace(root)
  expect(w.openPath).toBe(join(root, "docs", "deep.md"))
  expect([...w.expanded]).toEqual([join(root, "docs")])
})

test("an empty folder opens nothing", () => {
  const w = workspace(fixture(["empty/"]))
  expect(w.openPath).toBeNull()
  expect(w.expanded.size).toBe(0)
})

test("a given note opens with its folders expanded; links resolve against the same tree", () => {
  const root = fixture(["README.md", "a/b/note.md"])
  const note = join(root, "a", "b", "note.md")
  const w = workspace(root, note)
  expect(w.openPath).toBe(note)
  expect([...w.expanded]).toEqual([join(root, "a"), join(root, "a", "b")])
  expect(w.linkTree).toBe(w.tree)
  expect(w.linkRoot).toBeNull()
  expect(w.linkLazy).toBe(false)
  expect(w.piped).toBe(false)
})

test("a single note inside a vault links through the vault; at the vault's root it is the tree itself", () => {
  const vault = fixture([".obsidian/", "top.md", "Journal/day.md"])
  const dir = join(vault, "Journal")
  const note = join(dir, "day.md")
  const w = workspace(dir, note, true)
  expect(w.linkRoot).toBe(vault)
  expect(w.linkTree.path).toBe(vault)
  expect(w.tree.path).toBe(dir)
  expect(projectRoot(w)).toBe(vault)
  // not opened on its own: no vault lookup
  expect(workspace(dir, note).linkRoot).toBeNull()
  const atRoot = workspace(vault, join(vault, "top.md"), true)
  expect(atRoot.linkRoot).toBeNull()
  expect(atRoot.linkTree).toBe(atRoot.tree)
  expect(projectRoot(atRoot)).toBe(vault)
})

test("the piped document: an empty Files tree named after the folder, links scanned later", () => {
  const root = fixture(["a.md"])
  const w = stdinWorkspace(root)
  expect(w.openPath).toBe(STDIN)
  expect(w.tree).toEqual({ name: basename(root), path: root, rel: "", dir: true, children: [] })
  expect(w.linkTree).toBe(w.tree)
  expect(w.linkLazy).toBe(true)
  expect(w.piped).toBe(true)
  expect(w.linkRoot).toBeNull()
  expect(w.expanded.size).toBe(0)
  expect(stdinWorkspace("/").tree.name).toBe("/")
})
