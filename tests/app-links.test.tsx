// App: link labels (f), following links and vault link resolution.
import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EditResult } from "../src/editor"
import { B, hex, HINT_ROW, keys, longB, onBg, spansOf, waitFor, waitFrame, useAppHarness } from "./helpers/app"

const { tmp, mount } = useAppHarness()

const linkNote = "# A\n\nsee [[b]] and [[c|Sea]] and [[nope]] and [[b#Part two]]\n"

const linkVault = () => tmp({ "a.md": linkNote, "b.md": longB, "c.md": "# Sea note\n" })

test("f labels the links on screen; typing a label opens the note", async () => {
  const s = await mount(linkVault(), "a.md")
  expect(await keys(s, "f")).toContain("see a and sea and dope and j › Part two")
  expect(onBg(s, B.warning).join("")).toBe("asdj") // brothy warning fill under the four labels
  expect(await keys(s, "a")).toContain("Bee")
})

test("a heading link opens the note at that heading", async () => {
  const f = await keys(await mount(linkVault(), "a.md"), "f", "j")
  expect(f).toContain("Part two")
  expect(f).toContain("end")
  expect(f).not.toContain("see b")
  expect(f).not.toMatch(/\brow 1\b/)
})

test("an unresolved link only says so", async () => {
  const f = await keys(await mount(linkVault(), "a.md"), "f", "d")
  expect(f).toContain("no note named “nope”")
  expect(f).toContain("see b and Sea")
})

test("missing heading: the note opens at its remembered position with a toast", async () => {
  const root = tmp({ "a.md": "see [[b#Nowhere]]\n", "b.md": longB + "\nback to [[a]]\n" })
  const s = await mount(root, "a.md")
  const first = await keys(s, "f", "a")
  expect(first).toContain("Bee")
  expect(first).toContain("no heading “Nowhere”")
  await keys(s, "G") // b's bottom is now its remembered position
  expect(await keys(s, "f", "a")).toContain("see b › Nowhere") // back in a (only [[a]] is on screen)
  const again = await keys(s, "f", "a")
  expect(again).toContain("back to a")
  expect(again).not.toMatch(/\brow 1\b/)
  expect(again).toContain("no heading “Nowhere”")
})

test("esc or a non-label key cancels; f without links flashes", async () => {
  expect(await keys(await mount(linkVault(), "a.md"), "f", "esc")).toContain("see b and Sea")
  expect(await keys(await mount(linkVault(), "a.md"), "f", "x")).toContain("see b and Sea")
  expect(await keys(await mount(linkVault(), "c.md"), "f")).toContain("no links on screen")
})

test("Source and zen do not label", async () => {
  expect(await keys(await mount(linkVault(), "a.md"), "s", "f")).toContain("links: preview only")
  const z = await keys(await mount(linkVault(), "a.md"), "z", "f")
  expect(z).toContain("see b and Sea")
})

test("labels drop when the view moves", async () => {
  const root = tmp({ "a.md": "see [[b]]\n\n" + Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n"), "b.md": "# Bee\n" })
  const s = await mount(root, "a.md")
  await keys(s, "f")
  await s.mockMouse.scroll(70, 10, "down") // inside the document column
  const f = await keys(s, "a")
  expect(f).not.toContain("Bee")
})

test("link labels: survive code highlighting landing, and the typed label is followed", async () => {
  const root = tmp({ "a.md": "see [[b]]\n\n```ts\nconst labelsLand = 20260429 // not highlighted by an earlier test: the cache is shared\n```\n", "b.md": "# Bee\n" })
  const s = await mount(root, "a.md")
  expect(await keys(s, "f")).toContain("a–z follow")
  // `f` came before the parser answered (or at least right with it); the highlight re-render keeps the geometry
  await waitFor(s, () => spansOf(s).some((sp) => sp.text.includes("const") && hex(sp.fg) === B.secondary), 5000)
  expect(s.captureCharFrame()).toContain("a–z follow")
  expect(onBg(s, B.warning).join("")).toBe("a")
  expect(await keys(s, "a")).toContain("Bee")
})

test("link labels: a label letter typed after they went stale is swallowed, not run as a command", async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n")
  const root = tmp({ "a.md": "see [[b]]\n\n" + lines, "b.md": "# Bee\n" })
  const spawned: string[][] = []
  const s = await mount(root, "a.md", { edit: (argv) => (spawned.push(argv), { code: 0, signal: null } as EditResult) })
  await keys(s, "f")
  await s.mockMouse.scroll(70, 10, "down") // inside the document column: the labels are stale
  await keys(s, "e")
  expect(spawned).toEqual([])
  await keys(s, "g") // the `e` above already dropped the labels: back to the link
  s.resize(70, 30)
  await keys(s)
  await keys(s, "f") // fresh labels, then a resize makes them stale
  expect(onBg(s, B.warning).join("")).toBe("a")
  s.resize(80, 30)
  await keys(s)
  await keys(s, "s")
  expect(await keys(s, "f")).not.toContain("links: preview only") // `s` did not toggle Source
})

test("labels gone stale (live reload) end label mode: the footer drops them and the next key is swallowed", async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n")
  const root = tmp({ "a.md": "see [[b]]\n\n" + lines, "b.md": "# Bee\n" })
  const s = await mount(root, "a.md")
  expect(await keys(s, "f")).toContain("a–z follow")
  writeFileSync(join(root, "a.md"), "# changed\n\nsee [[b]]\n\n" + lines)
  await waitFrame(s, (f) => f.includes("changed") && !f.includes("a–z follow"))
  expect(await keys(s, "G")).not.toContain("line 79") // swallowed, like any key that cancels live labels
  expect(await keys(s, "G")).toContain("line 79")
})

test("unresolved wikilinks are drawn muted in the document", async () => {
  const s = await mount(linkVault(), "a.md")
  const nope = s.captureSpans().lines.flatMap((l) => l.spans).find((sp) => sp.text.includes("nope"))!
  expect(hex(nope.fg)).toBe(B.textMuted) // brothy textMuted
})

test("the doc footer offers f links, and drops it first when narrow", async () => {
  const s = await mount(linkVault(), "a.md")
  const wide = (await keys(s)).split("\n")[HINT_ROW]!
  expect(wide).toContain("f links")
  expect(wide).toContain("? keys")
  const n = await mount(linkVault(), "a.md", { size: { width: 70, height: 30 } })
  const narrow = (await keys(n)).split("\n")[HINT_ROW]!
  expect(narrow).not.toContain("f links")
  expect(narrow).toContain("? keys")
})

test("Source, where f only says preview only, does not offer f links", async () => {
  const src = (await keys(await mount(linkVault(), "a.md"), "s")).split("\n")[HINT_ROW]!
  expect(src).toContain("? keys")
  expect(src).not.toContain("f links")
})

test("a single note inside a vault resolves links against the vault root", async () => {
  const v = tmp({ "Journal/a.md": "see [[Elsewhere/b]] and [[c]]\n", "Elsewhere/b.md": "# Bee\n", "c.md": "# Sea note\n" })
  mkdirSync(join(v, ".obsidian"))
  const s = await mount(join(v, "Journal"), "a.md")
  const b = s.captureSpans().lines.flatMap((l) => l.spans).find((sp) => sp.text === "b")!
  expect(hex(b.fg)).toBe(B.info) // brothy info: resolved, not muted
  expect(await keys(s, "f", "s")).toContain("Sea note")
})

test("a note reached outside the opened folder names its vault folder in the top line, not ..", async () => {
  const v = tmp({ "Journal/a.md": "see [[Elsewhere/b]] and [[c]]\n", "Elsewhere/b.md": "# Bee\n", "c.md": "# Sea note\n" })
  mkdirSync(join(v, ".obsidian"))
  const s = await mount(join(v, "Journal"), "a.md")
  const top = (await keys(s, "f", "a")).split("\n")[0]!
  expect(top).toContain("Elsewhere")
  expect(top).not.toContain("..")
})

test("outside a vault, a single note's links resolve only within its folder", async () => {
  const v = tmp({ "Journal/a.md": "see [[c]]\n", "c.md": "# Sea note\n" })
  expect(await keys(await mount(join(v, "Journal"), "a.md"), "f", "a")).toContain("no note named “c”")
})
