// App: the Files tree, the Outline and Info.
import { expect, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { join } from "node:path"
import { mix } from "../../src/theme/theme"
import { B, keys, onBg, sections, spansOf, useAppHarness } from "./helpers"
import { hex } from "../helpers/theme"

const { tmp, mount, unmount, vault } = useAppHarness()

const STOCK = "Work/Projects/Soup Base Stock.md"

const infoNote = "---\ntitle: Calm\ntags:\n  - focus\n  - reading\n---\nSee [[b]] and [[nowhere]] and [[c]].\n\n# H\n\n- [x] one\n- [ ] two\n"

const tallInfo = "---\n" + Array.from({ length: 8 }, (_, i) => `prop${i}: value${i}`).join("\n") + "\n---\nSee [[b]] and [[c]].\n\n# H\n\nword\n"
const tallFiles = { "a.md": tallInfo, "b.md": "# bee", "c.md": "# sea" }

test("only the open note's path starts expanded; closed folders show note counts", async () => {
  const f = await keys(await mount(vault(), STOCK))
  expect(f).toMatch(/▸ Journal\s+3/)
  expect(f).toContain("▾ Work")
  expect(f).toContain("▾ Projects")
  expect(f).toContain("● Soup Base Stock")
  expect(f).toContain("Soup Garnish")
  expect(f).not.toContain("day one")
})

test("a note reached through a symlinked folder still reveals its path", async () => {
  const root = tmp({ "a.md": "# a" })
  const outside = tmp({ "inside.md": "# inside" }) // a link out of the tree is listed under its own name
  symlinkSync(outside, join(root, "link"))
  const f = await keys(await mount(root, "link/inside.md"))
  expect(f).toContain("▾ link")
  expect(f).toContain("● inside")
})

test("the cursor bar shows only while the panel has focus; tab lands on the open note", async () => {
  const s = await mount(vault(), STOCK)
  await keys(s)
  expect(onBg(s)).toEqual([])
  await keys(s, "tab")
  expect(onBg(s)[0]).toContain("Soup Base Stock")
})

test("l expands a folder and keeps focus; - folds back to the open note's path", async () => {
  const s = await mount(vault(), STOCK)
  expect(await keys(s, "tab", "g", "l")).toContain("day one")
  expect(onBg(s)[0]).toContain("Journal")
  const f = await keys(s, "-")
  expect(f).not.toContain("day one")
  expect(f).toContain("● Soup Base Stock")
})

test("l on a note opens it and keeps the panel focused; ⏎ opens it and focuses the document", async () => {
  const s = await mount(vault(), STOCK)
  expect(await keys(s, "tab", "j", "l")).toContain("garnish")
  expect(onBg(s)[0]).toContain("Soup Garnish")
  expect(await keys(s, "k", "enter")).toContain("simmer")
  expect(onBg(s)).toEqual([])
})

test("a long list gets a scroll thumb", async () => {
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`n${String(i).padStart(2, "0")}.md`, "# n"]))
  expect(await keys(await mount(tmp(files), "n00.md"))).toContain("▐")
})

test("emoji names count as two columns and are cut with …", async () => {
  const name = "🍣 Sushi and a very long name that cannot fit.md"
  const row = (await keys(await mount(tmp({ [name]: "# s" }), name))).split("\n").find((l) => l.includes("● 🍣"))!
  expect(row).toContain("…")
})

test("a non-Markdown file opened directly has no ● row; the Files cursor starts at the top", async () => {
  const s = await mount(tmp({ "notes.txt": "plain words", "b.md": "# b" }), "notes.txt")
  expect(await keys(s, "tab")).not.toContain("●")
  expect(onBg(s)[0]).toMatch(/\bb\b/)
})

test("a folder without Markdown: the welcome page says so; the panel stays hidden and tab doesn't focus it", async () => {
  const f = await keys(await mount(tmp({ "x.txt": "" })), "tab")
  expect(f).toContain("No Markdown files found")
  expect(f).not.toContain("no Markdown files here")
  expect(f).not.toContain("tab document")
})

test("the Outline marks the reading heading with ▸ and dims the headings above it", async () => {
  const s = await mount(tmp({ "a.md": sections(6) }), "a.md")
  const f = await keys(s, "2", "tab", "]", "]", "]")
  expect(f).toContain("▸ Section 4")
  const read = spansOf(s).find((sp) => sp.text.includes("Section 1"))!
  expect(hex(read.fg)).toBe(mix(B.text, B.background, 0.35)) // brothy text, mixed 35% toward the background
})

test("l peeks: the document jumps and the panel keeps focus", async () => {
  const s = await mount(tmp({ "a.md": sections(6) }), "a.md")
  const f = await keys(s, "2", "j", "l")
  expect(f.split("\n")[0]).toContain("Section 2")
  expect(onBg(s)[0]).toContain("Section 2")
})

test("/ in the Outline filters headings; ⏎ jumps, focuses the document and clears the filter", async () => {
  const s = await mount(tmp({ "a.md": sections(6) }), "a.md")
  const f = await keys(s, "2", "/", "type:5")
  expect(f).toMatch(/\/ 5▏\s+1/)
  expect(onBg(s)[0]).toContain("Section 5")
  const g = await keys(s, "enter")
  expect(g.split("\n")[0]).toContain("Section 5")
  expect(onBg(s)).toEqual([])
  expect(g).not.toContain("/ 5")
})

test("in Source the Outline lists the Source headings and jumps to Source lines", async () => {
  const s = await mount(tmp({ "a.md": "# Title\n\n" + "para\n\n".repeat(30) + "## Sub\n\n" + "para\n\n".repeat(30) + "end\n" }), "a.md")
  const f = await keys(s, "s", "2", "j", "enter")
  expect(f.split("\n")[0]).toContain("Sub")
  expect(f).toContain("## Sub")
})

test("Info shows properties with tag chips, resolved and unresolved links, and stats", async () => {
  const s = await mount(tmp({ "a.md": infoNote, "b.md": "# bee", "c.md": "# sea" }), "a.md")
  const f = await keys(s, "3")
  for (const x of ["title", "Calm", "#focus", "#reading", "Links", "→ b", "→ nowhere?", "1 heading · 1/2 tasks"]) expect(f).toContain(x)
  expect(f).toMatch(/\d+ words · \d+ min read/)
  expect(hex(spansOf(s).find((sp) => sp.text.includes("#focus"))!.fg)).toBe(B.secondary) // secondary
  // the document also shows `[[nowhere]]`, so look only at the panel's link row
  const linkRow = s.captureSpans().lines.find((l) => l.spans.map((sp) => sp.text).join("").includes("→ nowhere"))!
  expect(linkRow.spans.some((sp) => sp.text.includes("nowhere") && hex(sp.fg) === B.textMuted)).toBe(true) // textMuted
})

test("⏎ on a link opens it and focuses the document; j moves between links", async () => {
  const root = tmp({ "a.md": infoNote, "b.md": "# bee", "c.md": "# sea" })
  const s = await mount(root, "a.md")
  expect(await keys(s, "3", "enter")).toContain("bee")
  expect(onBg(s)).toEqual([])
  unmount()
  const again = await mount(root, "a.md")
  expect(await keys(again, "3", "j", "j", "enter")).toContain("sea")
})

test("⏎ on an unresolved link shows a toast and keeps Info focused", async () => {
  const s = await mount(tmp({ "a.md": infoNote, "b.md": "# bee", "c.md": "# sea" }), "a.md")
  const f = await keys(s, "3", "j", "enter")
  expect(f).toContain("no note named “nowhere”")
  expect(onBg(s)[0]).toContain("nowhere") // the selected row still holds the focus bar
})

test("Info with links: j/k at the first and last link scroll the rest of the list into view", async () => {
  const s = await mount(tmp(tallFiles), "a.md", { size: { width: 80, height: 16 } })
  const bottom = await keys(s, "3", "G", "j", "j", "j", "j")
  expect(bottom).toContain("min read") // the stat lines below the last link
  const top = await keys(s, "g", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k")
  expect(top).toContain("prop0") // the properties above the first link
})

test("Info: wheel scrolling sticks until the cursor moves", async () => {
  const s = await mount(tmp(tallFiles), "a.md", { size: { width: 80, height: 16 } })
  await keys(s, "3")
  expect(await keys(s)).toContain("prop0")
  for (let i = 0; i < 5; i++) await s.mockMouse.scroll(5, 8, "down")
  await s.renderOnce()
  const f = await keys(s)
  expect(f).not.toContain("prop0")
  expect(f).toContain("min read")
})

test("a click on an Info link row focuses the panel; an unresolved one only toasts", async () => {
  const s = await mount(tmp({ ...tallFiles, "a.md": tallInfo.replace("[[c]]", "[[nowhere]]") }), "a.md", { size: { width: 100, height: 30 } })
  await keys(s, "3", "tab") // Info visible, focus on the document
  const lines = s.captureCharFrame().split("\n")
  const y = lines.findIndex((l) => l.includes("→ nowhere"))
  await s.mockMouse.click(lines[y]!.indexOf("→ nowhere"), y)
  await s.renderOnce()
  const f = s.captureCharFrame()
  expect(f).toContain("no note named “nowhere”")
  expect(onBg(s)[0]).toContain("nowhere")
})

test("Info without a note says no note open", async () => {
  expect(await keys(await mount(tmp({ "x.txt": "" })), "3")).toContain("no note open")
})

test("a symlink that leaves the folder is marked ↗ in Files", async () => {
  const outside = tmp({ "far.md": "# far\n" })
  const root = tmp({ "a.md": "# a\n" })
  symlinkSync(join(outside, "far.md"), join(root, "far.md"))
  symlinkSync(join(root, "a.md"), join(root, "near.md"))
  const rows = (await keys(await mount(root, "a.md"))).split("\n")
  expect(rows.find((r) => r.includes("far"))).toMatch(/far ↗/)
  expect(rows.find((r) => r.includes("near"))).not.toContain("↗")
})
