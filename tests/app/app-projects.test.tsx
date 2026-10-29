// App: the o picker, recent projects and config shared across instances.
import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  firstDocRow,
  HINT_ROW,
  keys,
  numbered,
  openHelp,
  sections,
  sleep,
  topLine,
  useAppHarness,
  wrapped,
} from "./helpers"

const { tmp, mount, configFile, writeConfig, savedConfig, writeProjects, readProjects } = useAppHarness()

const nameOf = (p: string) => p.split("/").pop()!

test("the start is recorded as a recent project; a single note records its folder", async () => {
  const a = tmp({ "a.md": "# Alpha\n", "b.md": "# Bee\n" })
  await mount(a, "b.md")
  expect(readProjects()[0]).toMatchObject({ root: a, lastNote: join(a, "b.md"), top: 0 })
})

test("o lists recent projects; ⏎ switches the tree, header and note, and records both", async () => {
  const a = tmp({ "a.md": "# Alpha note\n" })
  const b = tmp({ "README.md": "# Bravo readme\n", "sub/deep.md": "# Deep\n" })
  writeProjects([{ root: b, lastNote: null, top: 0, at: 1 }])
  const s = await mount(a)
  const f = await keys(s, "o")
  expect(f).toContain("Open")
  expect(f).toContain("Recent")
  expect(f).toContain(nameOf(b))
  const after = await keys(s, "enter")
  expect(after).toContain("Bravo readme")
  expect(after).not.toContain("Alpha note")
  expect(after.split("\n")[0]).toContain(nameOf(b))
  expect(after).toContain("sub") // b's folder in Files
  expect(readProjects().map((p) => p.root)).toEqual([b, a])
})

test("reopening a recent project restores its last note at its top", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const b = tmp({ "README.md": "# Bravo\n", "long.md": numbered(200, []) })
  writeProjects([{ root: b, lastNote: join(b, "long.md"), top: 40, at: 1 }])
  const s = await mount(a)
  expect(topLine(await keys(s, "o", "enter"))).toBe(41)
  // leaving b again records where it was left
  await keys(s, "j", "j", "o", "enter")
  expect(readProjects()[1]).toMatchObject({ root: b, lastNote: join(b, "long.md"), top: 42 })
})

test("switching clears history and the old note's watcher", async () => {
  const a = tmp({ "a.md": "# Alpha\n\n[[b]]\n", "b.md": "# Bee\n" })
  const b = tmp({ "c.md": "# Charlie\n" })
  writeProjects([{ root: b, at: 1 }])
  const s = await mount(a, "a.md")
  expect(await keys(s, "f", "a")).toContain("Bee")
  const f = await keys(s, "o", "enter")
  expect(f).toContain("Charlie")
  expect((await keys(s, "H")).split("\n")[HINT_ROW]).toContain("no earlier note")
  writeFileSync(join(a, "b.md"), "# Bee changed\n")
  await sleep(300)
  await s.renderOnce()
  expect(s.captureCharFrame()).not.toContain("reloaded")
})

test("a missing recent is muted, and ⏎ drops it with a toast", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const gone = join(a, "no-such-dir")
  writeProjects([{ root: gone, at: 1 }])
  const s = await mount(a)
  expect(await keys(s, "o")).toContain("missing")
  const f = await keys(s, "enter")
  expect(f).toContain("is gone")
  expect(f).toContain("No recent projects")
  expect(readProjects().map((p) => p.root)).not.toContain(gone)
})

test("a path query lists entries; tab completes; ⏎ on the folder itself opens it", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const b = tmp({ "notes/x.md": "# Xray\n", "skip.txt": "", "top.md": "# Top\n" })
  const s = await mount(a)
  let f = await keys(s, "o", `type:${b}/no`)
  expect(f).toContain("Path")
  expect(f).toContain("notes/")
  expect(f).not.toContain("skip.txt")
  f = await keys(s, "tab")
  expect(f).toContain(`${nameOf(b)}/notes/`)
  expect(f).toContain("this folder")
  f = await keys(s, "enter")
  expect(f).toContain("Xray")
  expect(f.split("\n")[0]).toContain("notes")
})

test("⏎ on a Markdown path opens it as a single note", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const b = tmp({ "one.md": "# One\n", "two.md": "# Two\n" })
  const s = await mount(a)
  const f = await keys(s, "o", `type:${b}/two`, "enter")
  expect(f).toContain("Two")
  expect(readProjects()[0]).toMatchObject({ root: b, lastNote: join(b, "two.md") })
})

test("esc closes the picker; help lists o", async () => {
  const s = await mount(tmp({ "a.md": "# Alpha\n" }))
  expect(await keys(s, "o")).toContain("Open")
  expect(await keys(s, "esc")).not.toContain("No recent projects")
  expect(await openHelp(s)).toContain("open a recent project")
})

test("a note opened by path inside a vault is recorded under the vault; reopening keeps that root", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const v = tmp({ ".obsidian/app.json": "{}", "sub/n.md": "# Nested\n", "top.md": "# Top\n" })
  const s = await mount(a)
  expect(await keys(s, "o", `type:${v}/sub/n`, "enter")).toContain("Nested")
  expect(readProjects()[0]).toMatchObject({ root: v, lastNote: join(v, "sub", "n.md") })
  // back to a, then reopen the vault from Recent: the vault is the workspace, the note restored
  await keys(s, "o", `type:${nameOf(a)}`, "enter")
  const f = await keys(s, "o", `type:${nameOf(v)}`, "enter")
  expect(f).toContain("Nested")
  expect(f).toContain("top") // the vault's Files tree
  expect(readProjects()[0]).toMatchObject({ root: v })
  expect(readProjects().filter((p) => p.root === v)).toHaveLength(1)
})

test("a recent project reopens at its section after a width change (w)", async () => {
  const a = tmp({ "a.md": wrapped() })
  const b = tmp({ "b.md": "# Bee\n" })
  writeProjects([{ root: b, lastNote: null, at: 1 }])
  const s = await mount(a, "a.md")
  expect(firstDocRow(await keys(s, "w", "]", "]", "]", "]", "]"))).toContain("Section 6")
  await keys(s, "o", "enter", "w") // to b, then back to the 80-column measure
  expect(readProjects().find((p) => p.root === a)).toHaveProperty("geo")
  expect(firstDocRow(await keys(s, "o", `type:${nameOf(a)}`, "enter"))).toContain("Section 6")
})

test("leaving a project from zen records the Preview position, moved in zen or not", async () => {
  writeConfig({ zen: { measure: "full", typewriter: false } })
  for (const moves of [
    ["]", "]", "]", "]", "]", "z"],
    ["z", "]", "]", "]", "]", "]"],
  ]) {
    const a = tmp({ "a.md": wrapped() })
    const b = tmp({ "b.md": "# Bee\n" })
    writeProjects([{ root: b, lastNote: null, at: 1 }])
    const s = await mount(a, "a.md")
    await keys(s, ...moves, "o", "enter", "z") // to b from zen, then out of zen
    expect(firstDocRow(await keys(s, "o", `type:${nameOf(a)}`, "enter")), moves.join(" ")).toContain("Section 6")
    s.renderer.destroy()
  }
})

test("a config.json that doesn't parse: saving toasts an error instead of claiming it", async () => {
  writeConfig("{ not json")
  const root = tmp({ "a.md": sections(2) })
  for (const k of [
    ["w"],
    ["T"],
    ["C-b"],
    ["2"],
    ["t", "down", "enter"],
    ["z", "<"],
    ["z", "+"],
    ["Z", "j", "space", "enter"],
  ]) {
    const s = await mount(root, "a.md")
    const f = await keys(s, ...k)
    expect(f.split("\n")[HINT_ROW], k.join(" ")).toContain(
      "config.json not saved · it doesn't parse or can't be written",
    )
    expect(f, k.join(" ")).not.toMatch(/full width|background|zen settings saved|theme ·|measure \d|wpm/)
    s.renderer.destroy()
  }
  expect(readFileSync(configFile(), "utf8")).toBe("{ not json")
})

test("saving writes only the changed field: another instance's sidebar and zen settings survive", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  writeConfig({ sidebar: { view: "files", hidden: true }, zen: { wpm: 300 } }) // another instance
  await keys(s, "2") // Outline: the view only
  expect(savedConfig().sidebar).toEqual({ view: "outline", hidden: true })
  await keys(s, "Z", "j", "space", "enter") // Spotlight off: that key only
  expect(savedConfig().zen).toEqual({ wpm: 300, spotlight: false })
  writeConfig({ ...savedConfig(), sidebar: { view: "info", hidden: true } })
  await keys(s, "<") // zen measure: that key only
  expect(Object.keys(savedConfig().zen).sort()).toEqual(["measure", "spotlight", "wpm"])
  expect(savedConfig().zen.wpm).toBe(300)
  expect(savedConfig().sidebar).toEqual({ view: "info", hidden: true })
})
