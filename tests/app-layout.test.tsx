// App: Source, the top line, the panel views, the drawer, the measure and what the sidebar saves.
import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mix, themeByName } from "../src/theme"
import { B, hex, keys, numbered, onBg, openHelp, panelShown, parts, sections, sleep, spansOf, topLine, useAppHarness } from "./helpers/app"

const { cfgDir, tmp, mount, unmount, zenConfig, savedConfig } = useAppHarness()

test("clicking a find result jumps to it", async () => {
  const s = await mount(tmp({ "a.md": numbered(200, [50, 150]) }), "a.md")
  const f = await keys(s, "/", "type:needle")
  const lines = f.split("\n")
  const y = lines.findIndex((l) => l.includes("row 150 needle"))
  await s.mockMouse.click(lines[y]!.indexOf("row 150"), y)
  expect(topLine(await keys(s))).toBeGreaterThan(130)
})

test("s shows the Markdown source in place of the preview, and back", async () => {
  const s = await mount(tmp({ "a.md": "# Title\n\nsome **bold** text\n" }), "a.md")
  const src = await keys(s, "s")
  expect(src.split("\n")[0]).toMatch(/\bsource\s*$/)
  expect(src).toContain("**bold**")
  const prev = await keys(s, "s")
  expect(prev.split("\n")[0]).not.toMatch(/\bsource\s*$/)
  expect(prev).not.toContain("**bold**")
})

test("the Source over zen acts as what it shows: w works, z enters zen at once, esc keeps zen to return to", async () => {
  const s = await mount(tmp({ "a.md": "# Title\n\nsome **bold** text\n" }), "a.md")
  expect(await keys(s, "z", "s", "w")).toContain("full width")
  const zen = await keys(s, "z")
  expect(panelShown(zen)).toBe(false)
  expect(zen).not.toContain("**bold**")
  expect(panelShown(await keys(s, "s", "esc", "s"))).toBe(false)
})

test("find works in the source view", async () => {
  const s = await mount(tmp({ "a.md": numbered(200, [150]) }), "a.md")
  expect(topLine(await keys(s, "s", "/", "type:needle", "enter"))).toBeGreaterThan(130)
})

test("the top line names the folder, the title and the section; the position is on the progress line", async () => {
  const s = await mount(tmp({ "notes/a.md": sections(6) }), "notes/a.md")
  const rows = (await keys(s, "]", "]")).split("\n")
  expect(rows[0]).toMatch(/^󰘗 notes\s+a › Section 3/) // folder over the panel, title at the text edge
  expect(rows[29]).toMatch(/─ \d+% · \d+ min left\s*$/)
})

test("the top line uses the front-matter title and drops an H1 that repeats it", async () => {
  const s = await mount(tmp({ "calm.md": "---\ntitle: Calm Tech\n---\n# Calm Tech\n\n## One\n\n" + "text\n\n".repeat(40) }), "calm.md")
  expect((await keys(s, "]")).split("\n")[0]).toMatch(/^󰘗 \S+\s+Calm Tech › One/) // vault name over the panel
})

test("80×24 has no gap row: the body starts on row 1", async () => {
  const s = await mount(tmp({ "a.md": "first line\n" }), "a.md", { size: { width: 80, height: 24 } })
  expect((await keys(s)).split("\n")[1]).toContain("first line")
})

test("pages show page i of n on the progress line", async () => {
  zenConfig({ flow: "pages" })
  const s = await mount(tmp({ "a.md": parts(4) }), "a.md")
  expect((await keys(s, "z", "]")).split("\n")[29]).toMatch(/page 2 of 4/)
})

test("1 2 3 pick the panel view and focus it; tab swaps panel and document", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  expect(panelShown(await keys(s))).toBe(true)
  expect(onBg(s)).toEqual([]) // startup focus is the document
  await keys(s, "2")
  expect(onBg(s)[0]).toContain("Section 1")
  expect(await keys(s, "3")).toMatch(/\bwords · \d+ min read/)
  expect(await keys(s, "tab")).toContain("tab panel")
  expect(onBg(s)).toEqual([])
  expect(await keys(s, "tab")).toMatch(/\bwords · \d+ min read/) // back on the same view
})

test("clicking a strip label selects that view and focuses the panel", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  const rows = (await keys(s)).split("\n")
  const y = rows.findIndex((l) => /Files\s+²Outline/.test(l))
  await s.mockMouse.click(rows[y]!.indexOf("Outline") + 1, y)
  await keys(s)
  expect(onBg(s)[0]).toContain("Section 1")
})
test("^b hides the panel and the document takes the room", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md")
  expect(panelShown(await keys(s))).toBe(true)
  const f = await keys(s, "C-b")
  expect(panelShown(f)).toBe(false)
  expect(panelShown(await keys(s, "C-b"))).toBe(true)
})
test("below 100 columns the panel is a drawer: tab opens it focused, ⏎ on a note closes it, esc too", async () => {
  const s = await mount(tmp({ "a.md": "# alpha", "b.md": "# bravo" }), "a.md", { size: { width: 80, height: 24 } })
  expect(panelShown(await keys(s))).toBe(false)
  expect(panelShown(await keys(s, "tab"))).toBe(true)
  const g = await keys(s, "j", "enter")
  expect(panelShown(g)).toBe(false)
  expect(g).toContain("bravo")
  expect(panelShown(await keys(s, "C-b"))).toBe(true)
  expect(panelShown(await keys(s, "esc"))).toBe(false)
})
test("the document wraps at an 80-column measure, centered", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(40) }), "a.md", { size: { width: 200, height: 30 } })
  // the text alone: the minimap's 4 columns at the right edge cut off
  const rows = (await keys(s)).split("\n").filter((l) => l.includes("lorem")).map((l) => [...l].slice(0, 196).join(""))
  expect(rows.length).toBeGreaterThan(3)
  const start = (r: string) => r.search(/lorem|ipsum|dolor/)
  for (const r of rows) expect(r.trimEnd().length - start(r)).toBeLessThanOrEqual(80)
  // centered in the area right of the sidebar
  const left = start(rows[0]!)
  const right = 200 - rows[0]!.trimEnd().length
  expect(left).toBeGreaterThan(right)
})

test("help popup lists the new bindings from the keymap", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 100, height: 50 } })
  const f = await openHelp(s)
  expect(f).toContain("Files · Outline · Info")
  expect(f).toContain("toggle Source / Preview")
  expect(f).toContain("hide / show the panel")
})
// ------------------------------------------------------------- persistence, scan limit, highlighting

test("the panel view and ^b are saved; the next start restores them", async () => {
  const root = tmp({ "a.md": "# A\n\ntext\n" })
  const s = await mount(root, "a.md")
  await keys(s, "3", "tab")
  expect(savedConfig().sidebar).toEqual({ view: "info" }) // only the field changed
  expect(savedConfig().folds).toBeUndefined()
  unmount()
  const again = await mount(root, "a.md")
  expect(await keys(again)).toMatch(/min read/) // Info shown, unfocused
  await keys(again, "C-b")
  expect(savedConfig().sidebar).toEqual({ view: "info", hidden: true })
  unmount()
  expect(panelShown(await keys(await mount(root, "a.md")))).toBe(false)
})
test("legacy folds pick the view; all folded means hidden", async () => {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), '{"folds":{"files":false,"outline":false,"info":true}}')
  expect(await keys(await mount(tmp({ "a.md": "# A\n" }), "a.md"))).toMatch(/min read/)
  unmount()
  writeFileSync(join(cfgDir, "brothy", "config.json"), '{"folds":{"files":false,"outline":false,"info":false}}')
  expect(panelShown(await keys(await mount(tmp({ "a.md": "# A\n" }), "a.md")))).toBe(false)
})

test("a broken sidebar entry in the config falls back to the defaults", async () => {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), '{"sidebar":{"view":"nope","hidden":3}}')
  const f = await keys(await mount(tmp({ "a.md": "# A\n" }), "a.md"))
  expect(panelShown(f)).toBe(true)
  expect(f).not.toMatch(/min read/)
})
test("a truncated scan says so in Files", async () => {
  const d = tmp({ "a.md": "# A\n" })
  for (let i = 0; i < 20_050; i++) writeFileSync(join(d, `f${String(i).padStart(5, "0")}.txt`), "")
  const s = await mount(d, "a.md", { size: { width: 100, height: 30 } })
  const f = await keys(s)
  expect(f.replace(/\s+/g, " ")).toContain("scan stopped at 20k entries — some notes missing")
  expect(spansOf(s).some((sp) => sp.text.includes("scan") && hex(sp.fg) === B.warning)).toBe(true) // brothy warning
})

test("a complete scan shows no truncation note", async () => {
  const s = await mount(tmp({ "a.md": "# A\n" }), "a.md")
  expect(await keys(s)).not.toContain("truncated")
})

test("panel tabs: superscript numbers in textMuted; the rule under the active tab is accent only while the panel has focus", async () => {
  const t = themeByName("brothy")
  const s = await mount(tmp({ "a.md": "# A\n" }), "a.md", { size: { width: 120, height: 30 } })
  expect(await keys(s)).toContain("¹Files   ²Outline   ³Info")
  for (const d of ["¹", "²", "³"]) expect(hex(spansOf(s).find((sp) => sp.text.includes(d))!.fg)).toBe(t.textMuted)
  const rule = () => spansOf(s).find((sp) => /^━+$/.test(sp.text))!
  expect(rule().text).toBe("━━━━━") // under Files only, not its digit
  expect(hex(rule().fg)).toBe(t.textMuted)
  await keys(s, "tab")
  expect(hex(rule().fg)).toBe(t.accent)
  expect(hex(spansOf(s).find((sp) => sp.text.endsWith("Files"))!.fg)).toBe(t.primary)
})

test("code blocks are highlighted once the parser answers, without moving the document", async () => {
  const s = await mount(tmp({ "a.md": "# T\n\n```ts\nconst a = 1 // note\n```\n\nafter\n" }), "a.md")
  const before = await keys(s)
  const SECONDARY = B.secondary // brothy keyword color
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(25)) {
    await s.renderOnce()
    if (spansOf(s).some((sp) => sp.text.includes("const") && hex(sp.fg) === SECONDARY)) break
  }
  expect(spansOf(s).some((sp) => sp.text.includes("const") && hex(sp.fg) === SECONDARY)).toBe(true)
  const after = await keys(s)
  expect(after.split("\n").length).toBe(before.split("\n").length)
  expect(after.replace(/\s+$/gm, "")).toBe(before.replace(/\s+$/gm, ""))
})

test("the drawer dims the document (scrim); the top row stays bright", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(60) }), "a.md", { size: { width: 80, height: 24 } })
  await keys(s)
  const loremFg = () => hex(spansOf(s).find((sp) => sp.text.includes("lorem"))!.fg)
  const row0 = () => s.captureSpans().lines[0]!.spans.map((sp) => hex(sp.fg))
  const bright = loremFg()!
  const top = row0()
  await keys(s, "tab")
  expect(loremFg()).toBe(mix(bright, B.background, 0.62))
  expect(row0()).toEqual(top)
})

test("the drawer is raised and has a ▏ edge; a click on the scrim closes it", async () => {
  const s = await mount(tmp({ "a.md": "# alpha" }), "a.md", { size: { width: 80, height: 24 } })
  const f = await keys(s, "tab")
  expect(f.split("\n")[5]![36]).toBe("▏") // DW = round(80 × 0.45) = 36
  expect(s.captureSpans().lines[5]!.spans.some((sp) => hex(sp.bg) === B.backgroundElement)).toBe(true) // backgroundElement
  await s.mockMouse.click(70, 10)
  expect(panelShown(await keys(s))).toBe(false)
})

test("60×14 still opens the drawer with the compact strip", async () => {
  const s = await mount(tmp({ "a.md": "# alpha" }), "a.md", { size: { width: 60, height: 14 } })
  expect(await keys(s, "tab")).toContain("¹Files  ²Outline  ³Info")
})

test("crossing 100 columns: a focused panel becomes an open drawer and comes back inline, focused", async () => {
  const s = await mount(tmp({ "a.md": "# alpha", "b.md": "# bravo" }), "a.md", { size: { width: 120, height: 32 } })
  await keys(s, "tab")
  s.resize(80, 24)
  const f = await keys(s)
  expect(panelShown(f)).toBe(true)
  expect(f.split("\n")[5]![36]).toBe("▏")
  s.resize(120, 32)
  await keys(s)
  expect(onBg(s).length).toBe(1) // still focused: the cursor bar is drawn
})

test("crossing 100 columns with the document focused leaves the drawer closed", async () => {
  const s = await mount(tmp({ "a.md": "# alpha" }), "a.md", { size: { width: 120, height: 32 } })
  expect(panelShown(await keys(s))).toBe(true)
  s.resize(80, 24)
  expect(panelShown(await keys(s))).toBe(false)
})
