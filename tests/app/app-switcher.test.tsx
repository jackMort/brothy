// App: the C-p switcher and its peek pane.
import { expect, spyOn, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as vaultModule from "../../src/notes/vault"
import { filler, keys, OLLAMA, onBg, PRIMARY, sleep, useAppHarness, waitFrame } from "./helpers"

const { tmp, mount, aiConfig, seedSummary } = useAppHarness()

test("switcher: keys move the highlight away from a pointer resting on the list", async () => {
  const s = await mount(tmp({ "alpha.md": "# a", "bravo.md": "# b", "charlie.md": "# c", "delta.md": "# d" }), "alpha.md")
  const rows = (await keys(s, "C-p")).split("\n")
  const y = rows.findIndex((r) => /\bcharlie\b/.test(r))
  expect(y).toBeGreaterThan(0)
  await s.mockMouse.moveTo(rows[y]!.indexOf("charlie"), y)
  await keys(s)
  const sel = () => onBg(s, PRIMARY).join("")
  expect(sel()).toContain("charlie")
  await keys(s, "down")
  expect(sel()).toContain("delta")
  await keys(s, "up", "up")
  expect(sel()).toContain("bravo")
})

test("switcher: an index build that fails toasts the error and ends indexing", async () => {
  const spy = spyOn(vaultModule, "refreshIndex").mockRejectedValue(new Error("boom"))
  try {
    const s = await mount(tmp({ "a.md": "# a\n", "b.md": "# b\n" }), "a.md")
    await keys(s, "C-p")
    const f = await waitFrame(s, (f) => f.includes("index failed"))
    expect(f).toContain("index failed · boom")
    expect(f).not.toMatch(/indexing \d/) // the header counter is gone
  } finally {
    spy.mockRestore()
  }
})

test("C-p, type, ⏎ opens the note; esc closes and keeps the document", async () => {
  const d = tmp({ "alpha.md": "# Alpha body\n", "beta.md": "# Beta body\n" })
  const s = await mount(d, "alpha.md")
  const f = await keys(s, "C-p", "type:bet")
  expect(f).toContain("Go to")
  expect(f).toContain("Notes")
  expect(await keys(s, "enter")).toContain("Beta body")
  expect(s.captureCharFrame()).not.toContain("Go to")
  const g = await keys(s, "C-p", "esc")
  expect(g).not.toContain("Go to")
  expect(g).toContain("Beta body")
})

test("empty query lists recent notes first, then the open note's folder-mates", async () => {
  const d = tmp({ "alpha.md": "# A\n", "beta.md": "# B\n", "gamma.md": "# G\n" })
  const s = await mount(d, "alpha.md")
  await keys(s, "C-b") // no panel, so note names appear only in the popup
  await keys(s, "C-p", "type:gamma", "enter")
  const rows = (await keys(s, "C-p")).split("\n")
  const at = rows.findIndex((r) => r.includes("Recent"))
  const list = rows.slice(at, at + 4).join("\n") // the section only, not the title or progress lines
  expect(list.indexOf("alpha")).toBeGreaterThan(-1)
  expect(list.indexOf("alpha")).toBeLessThan(list.indexOf("beta"))
  expect(list).not.toContain("gamma")
})

test("C-p while typing the panel filter still moves up", async () => {
  const d = tmp({ "alpha.md": "# A\n", "alps.md": "# B\n" })
  const s = await mount(d, "alpha.md")
  expect(await keys(s, "tab", "/", "type:al", "C-p")).not.toContain("Go to")
})

test("the switcher works in zen and opens there", async () => {
  const d = tmp({ "alpha.md": "# Alpha body\n", "beta.md": "# Beta body\n" })
  const s = await mount(d, "alpha.md")
  const f = await keys(s, "z", "C-p", "type:beta", "enter")
  expect(f).toContain("Beta body")
  expect(f).not.toContain("Files") // still zen: no panel strip
})

test("a single note inside a vault: the switcher searches the vault root", async () => {
  const v = tmp({ "Journal/a.md": "# Day\n", "Elsewhere/far.md": "# Far note\n" })
  mkdirSync(join(v, ".obsidian"))
  const s = await mount(join(v, "Journal"), "a.md")
  const f = await keys(s, "C-p", "type:far")
  expect(f).toContain("Elsewhere")
  expect(await keys(s, "enter")).toContain("Far note")
})

test("a heading hit lands on its line", async () => {
  const d = tmp({ "a.md": "# A\n", "b.md": `# Intro\n\n${filler(40)}\n\n## Deep part\n\nbody\n` })
  const s = await mount(d, "a.md")
  await keys(s, "C-p", "type:deep")
  await waitFrame(s, (f) => f.includes("b › Deep part"))
  const f = await keys(s, "enter")
  expect(f).toContain("Deep part")
  expect(f).not.toMatch(/filler 0\b/)
})

test("a text hit sets the find query and selects the first match in its section", async () => {
  const body = `# One\n\nneedle one\n\n${filler(40)}\n\n# Two\n\nneedle two\n\nneedle three\n`
  const d = tmp({ "a.md": body, "b.md": "# B\n" })
  const s = await mount(d, "b.md")
  await keys(s, "C-p", "type:needle")
  await waitFrame(s, (f) => f.includes("Text"))
  const f = await keys(s, "down", "enter") // second text hit: "needle two"
  expect(f).toContain("/needle 2/3")
  expect(f).toContain("needle two")
  expect(f).not.toContain("needle one")
})

test("a later text hit in a section selects its own occurrence, not the section's first", async () => {
  const body = `# One\n\nneedle one\n\n${filler(40)}\n\n# Two needles\n\nneedle two\n\n${filler(40)}\n\nneedle three\n`
  const d = tmp({ "a.md": body, "b.md": "# B\n" })
  const s = await mount(d, "b.md")
  await keys(s, "C-p", "type:needle")
  await waitFrame(s, (f) => f.includes("Text"))
  await keys(s, "tab") // Headings ("Two needles") → Text
  const f = await keys(s, "down", "down", "enter") // third text hit: "needle three"
  expect(f).toContain("/needle 4/4") // the heading "Two needles" is match 2
  expect(f).toContain("needle three")
})

test("Source keeps Source and a text hit lands on its source row", async () => {
  const body = `# One\n\nneedle one\n\n${filler(40)}\n\n# Two\n\nneedle two\n`
  const s = await mount(tmp({ "a.md": body }), "a.md")
  await keys(s, "s", "C-p", "type:needle")
  await waitFrame(s, (f) => f.includes("Text"))
  const f = await keys(s, "down", "enter")
  expect(f).toMatch(/\d+ +needle two/) // gutter number: still Source
  expect(f).toContain("/needle 2/2")
})

test("a hit the preview cannot show: the note opens at the section, the query stays, a toast says so", async () => {
  const d = tmp({ "a.md": "# A\n", "c.md": "# Sec\n\nsee [x](http://zzqx.example)\n" })
  const s = await mount(d, "a.md")
  await keys(s, "C-p", "type:zzqx")
  await waitFrame(s, (f) => f.includes("Text"))
  const f = await keys(s, "enter")
  expect(f).toContain("Sec")
  expect(f).toContain("“zzqx” is not in the preview")
  expect(f).toContain("/zzqx")
})

test("an edited note is re-read on the next C-p", async () => {
  const d = tmp({ "a.md": "# Old\n" })
  const s = await mount(d, "a.md")
  await keys(s, "C-p")
  await waitFrame(s, (f) => f.includes("1 note"))
  await keys(s, "esc")
  writeFileSync(join(d, "a.md"), "# Old\n\n## Fresh head\n")
  await keys(s, "C-p", "type:fresh")
  await waitFrame(s, (f) => f.includes("a › Fresh head"))
})

// ------------------------------------------------------------- C-p peek pane

test("C-p at 120 columns peeks at the highlighted note, with its fresh TL;DR and no AI request", async () => {
  const d = tmp({ "a.md": "# Alpha\n", "notes/beta.md": "# Beta notes\n\nPeek body line.\n\n## Part\n\nmore\n" })
  aiConfig(OLLAMA)
  seedSummary(join(d, "notes/beta.md"), "Beta is about peeking.")
  let calls = 0
  const s = await mount(d, "a.md", { size: { width: 120, height: 34 }, fetch: (async () => (calls++, new Response(""))) as unknown as typeof fetch })
  await keys(s, "C-p", "type:beta")
  const f = await waitFrame(s, (x) => x.includes("Peek body line."))
  expect(f).toContain("notes/beta.md")
  expect(f).toContain("Beta notes")
  expect(f).toContain("└ Part")
  expect(f).toContain("TL;DR · llama3.2")
  expect(f).toContain("Beta is about peeking.")
  expect(f.split("\n").filter((r) => r.includes("│")).length).toBeGreaterThan(3)
  expect(calls).toBe(0)
})

test("C-p peek: an outdated TL;DR is left out; a heading hit starts after its heading", async () => {
  const d = tmp({ "a.md": "# Alpha\n", "beta.md": "# Beta\n\nIntro.\n\n## Gamma part\n\nUnder the heading.\n" })
  seedSummary(join(d, "beta.md"), "Stale words.", "not-the-hash")
  const s = await mount(d, "a.md", { size: { width: 120, height: 34 } })
  await keys(s, "C-p", "type:gamma")
  const f = await waitFrame(s, (x) => x.includes("Under the heading."))
  expect(f).toContain("Under the heading.")
  expect(f).not.toContain("Stale words.")
  expect(f).not.toContain("TL;DR")
  expect(f).not.toContain("Intro.")
})

test("C-p below 100 columns has no peek pane", async () => {
  const d = tmp({ "a.md": "# Alpha\n", "beta.md": "# Beta\n\nPlain words here.\n" })
  const s = await mount(d, "a.md", { size: { width: 90, height: 30 } })
  const f = await keys(s, "C-p", "type:beta")
  await sleep(100)
  expect(await keys(s)).not.toContain("Plain words here.")
  expect(f).toContain("Go to")
})
