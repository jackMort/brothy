// App: the display toggles (w, #, T) and the minimap.
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { themeByName } from "../../src/theme/theme"
import { type Setup, keys, loremWidth, spansOf, useAppHarness } from "./helpers"
import { hex } from "../helpers/theme"

const { cfgDir, tmp, mount, unmount, savedConfig } = useAppHarness()

/** Background alpha of the first span containing `text` (0 = unpainted). */
function bgAlpha(s: Setup, text: string): number {
  const span = s.captureSpans().lines.flatMap((l) => l.spans).find((x) => x.text.includes(text))
  expect(span).toBeDefined()
  return span!.bg.a
}

test("w toggles full width in the normal view and persists it", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(80) }), "a.md", { size: { width: 160, height: 30 } })
  const f = await keys(s, "w")
  const text = (fr: string) => fr.split("\n").filter((l) => l.includes("lorem")).map((l) => [...l].slice(0, 160 - 4).join("")) // without the minimap
  const rows = text(f)
  expect(Math.max(...rows.map((r) => r.trimEnd().length - r.search(/lorem|ipsum|dolor/)))).toBeGreaterThan(100)
  for (const r of rows) expect(r.trimEnd().length).toBeLessThanOrEqual(160 - 4) // left of the minimap's gap column (a capped row fills the measure)
  expect(savedConfig().wide).toBe(true)
  const back = await keys(s, "w")
  for (const r of text(back)) expect(r.trimEnd().length - r.search(/lorem|ipsum|dolor/)).toBeLessThanOrEqual(80)
  expect(savedConfig().wide).toBe(false)
})

test("# cycles the heading style, toasts and persists it", async () => {
  const s = await mount(tmp({ "a.md": "# Title\n\n## Sub\n\nbody" }), "a.md", { size: { width: 120, height: 30 } })
  let f = await keys(s, "#")
  expect(f).toContain("headings · bars")
  expect(f).toContain("█ Title")
  expect(savedConfig().headings).toBe("bars")
  f = await keys(s, "#")
  expect(f).toContain("headings · ladder")
  expect(f).toContain("▓▓▓ Sub")
  f = await keys(s, "#")
  expect(f).toContain("headings · rules")
  expect(f).toContain("── Sub ─")
  f = await keys(s, "#")
  expect(f).toContain("headings · classic")
  expect(f).toContain("## Sub")
  expect(savedConfig().headings).toBe("classic")
})

test("# does nothing on the welcome screen", async () => {
  const f = await keys(await mount(tmp({ "x.txt": "" })), "#")
  expect(f).toContain("No Markdown files found")
  expect(f).not.toContain("headings ·")
  expect(existsSync(join(cfgDir, "brothy", "config.json")) ? savedConfig().headings : undefined).toBeUndefined()
})

test("T toggles a transparent background, persists it, popups stay painted", async () => {
  const s = await mount(tmp({ "a.md": "# Title\n\nlorem ipsum\n\n```ts\nconst x = 1\n```\n" }), "a.md")
  expect(bgAlpha(s, "lorem")).toBeGreaterThan(0)
  expect(await keys(s, "T")).toContain("transparent background")
  expect(savedConfig().transparent).toBe(true)
  expect(bgAlpha(s, "lorem")).toBe(0)
  expect(bgAlpha(s, "Files")).toBe(0)
  await keys(s, "?")
  expect(bgAlpha(s, "Keybindings")).toBeGreaterThan(0)
  await keys(s, "esc")
  expect(await keys(s, "T")).toContain("opaque background")
  expect(savedConfig().transparent).toBe(false)
  expect(bgAlpha(s, "lorem")).toBeGreaterThan(0)
})

test("transparent is loaded from the config and applies in zen", async () => {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), JSON.stringify({ transparent: true }))
  const s = await mount(tmp({ "a.md": "lorem ipsum" }), "a.md")
  expect(bgAlpha(s, "lorem")).toBe(0)
  await keys(s, "z")
  expect(bgAlpha(s, "lorem")).toBe(0)
})

test("w keeps the current match: the next n advances instead of re-selecting it", async () => {
  const para = (i: number) => `needle ${i} ${"lorem ipsum dolor ".repeat(12)}`
  const doc = Array.from({ length: 40 }, (_, i) => para(i)).join("\n\n")
  const s = await mount(tmp({ "a.md": doc }), "a.md", { size: { width: 160, height: 30 } })
  await keys(s, "/", "type:needle", "enter")
  await keys(s, "n")
  const f = await keys(s, "n")
  expect(f).toMatch(/\b3\/40\b/)
  await keys(s, "w") // re-wraps at full width; line numbers all change
  expect(await keys(s, "n")).toMatch(/\b4\/40\b/)
})

test("w in zen does nothing: no toggle, no save, no flash", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(80) }), "a.md", { size: { width: 160, height: 30 } })
  await keys(s, "z")
  const f = await keys(s, "w")
  expect(f).not.toContain("full width")
  expect(existsSync(join(cfgDir, "brothy", "config.json")) && savedConfig().wide).toBeFalsy()
  expect(await keys(s, "esc")).not.toContain("wide") // nothing toggled underneath
})

test("wide is loaded from the config on startup", async () => {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), JSON.stringify({ wide: true }))
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(80) }), "a.md", { size: { width: 160, height: 30 } })
  expect(loremWidth(await keys(s))).toBeGreaterThan(100)
})

// ------------------------------------------------------------- minimap

const BRAILLE = /[⠁-⣿]/
/** the two braille cells at the right edge (the lane is the last column) */
const miniCol = (f: string, W: number) => f.split("\n").map((r) => [...r].slice(W - 3, W - 1).join(""))
const laneCol = (f: string, W: number) => f.split("\n").map((r) => [...r][W - 1] ?? "")
const LONG_NOTE = "# Top\n\n" + Array.from({ length: 12 }, (_, i) => `## Part ${i}\n\n${"lorem ipsum dolor sit amet ".repeat(6)}\n`).join("\n")

test("minimap: on at 120 columns, braille at the right edge, headings in primary, the text column unmoved", async () => {
  const t = themeByName("brothy")
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { size: { width: 120, height: 34 } })
  const f = await keys(s)
  expect(miniCol(f, 120).some((c) => BRAILLE.test(c))).toBe(true)
  expect(spansOf(s).some((sp) => BRAILLE.test(sp.text) && hex(sp.fg) === t.primary)).toBe(true)
  expect(spansOf(s).some((sp) => BRAILLE.test(sp.text) && hex(sp.fg) === t.textMuted && hex(sp.bg) === t.backgroundElement)).toBe(true)
  expect(spansOf(s).some((sp) => BRAILLE.test(sp.text) && hex(sp.fg) === t.borderSubtle)).toBe(true)
  const rule = f.split("\n")[1]! // the gap row's rule spans the text column: 80 wide from column 36, as without the minimap
  expect((rule.match(/─/g) ?? []).length).toBe(80)
  expect([...rule].indexOf("─")).toBe(36)
  expect(laneCol(f, 120).some((c) => BRAILLE.test(c))).toBe(false) // no find, no lane
})

test("minimap: shown in Source too, where the line-number gutter draws no dots", async () => {
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { size: { width: 120, height: 34 } })
  expect(miniCol(await keys(s, "s"), 120).some((c) => BRAILLE.test(c))).toBe(true)
  unmount()
  // text only at the far right of each line: the left cell stays empty
  const s2 = await mount(tmp({ "b.md": Array.from({ length: 40 }, () => " ".repeat(70) + "x").join("\n") }), "b.md", { size: { width: 120, height: 34 } })
  const f = await keys(s2, "s")
  expect(f.split("\n").map((r) => [...r].slice(117, 119).join("")).some((c) => c[1] && BRAILLE.test(c[1]))).toBe(true)
  expect(f.split("\n").some((r) => BRAILLE.test([...r][117] ?? ""))).toBe(false)
})

test("minimap: hidden below 110 columns and in zen", async () => {
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { size: { width: 109, height: 34 } })
  expect(miniCol(await keys(s), 109).some((c) => BRAILLE.test(c))).toBe(false)
  s.resize(120, 34)
  expect(miniCol(await keys(s), 120).some((c) => BRAILLE.test(c))).toBe(true)
  expect(miniCol(await keys(s, "z"), 120).some((c) => BRAILLE.test(c))).toBe(false)
})

test("m hides the minimap, saves minimap:false, and a remount keeps it hidden", async () => {
  const d = tmp({ "a.md": LONG_NOTE })
  const s = await mount(d, "a.md", { size: { width: 120, height: 34 } })
  const f = await keys(s, "m")
  expect(f).toContain("minimap off")
  expect(miniCol(f, 120).some((c) => BRAILLE.test(c))).toBe(false)
  expect(JSON.parse(readFileSync(join(cfgDir, "brothy", "config.json"), "utf8")).minimap).toBe(false)
  unmount()
  const s2 = await mount(d, "a.md", { size: { width: 120, height: 34 } })
  expect(miniCol(await keys(s2), 120).some((c) => BRAILLE.test(c))).toBe(false)
  expect(await keys(s2, "m")).toContain("minimap on")
})

test("m below 110 columns says the minimap needs 110 columns and leaves the setting alone", async () => {
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { size: { width: 100, height: 30 } })
  expect(await keys(s, "m")).toContain("minimap needs 110 columns")
  s.resize(120, 34)
  expect(miniCol(await keys(s), 120).some((c) => BRAILLE.test(c))).toBe(true)
})

test("minimap: during a find the lane marks the match lines in secondary", async () => {
  const t = themeByName("brothy")
  const s = await mount(tmp({ "a.md": LONG_NOTE + "\n\nneedle here\n" }), "a.md", { size: { width: 120, height: 34 } })
  const f = await keys(s, "/", "type:needle", "enter")
  expect(laneCol(f, 120).some((c) => BRAILLE.test(c))).toBe(true)
  expect(spansOf(s).some((sp) => BRAILLE.test(sp.text) && hex(sp.fg) === t.secondary)).toBe(true)
})

test("minimap: a click scrolls to that part of the note", async () => {
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { size: { width: 120, height: 34 } })
  const before = await keys(s)
  const rows = before.split("\n")
  const last = rows.map((r, y) => (BRAILLE.test([...r].slice(117, 119).join("")) ? y : -1)).filter((y) => y >= 0).at(-1)!
  await s.mockMouse.click(117, last)
  const after = await keys(s)
  expect(after).toContain("Part 11")
  expect(after).not.toBe(before)
})

test("minimap: narrowing from 120 to 105 columns hides it and keeps the reading position", async () => {
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { size: { width: 120, height: 34 } })
  await keys(s, "]", "]", "]", "]", "]", "]")
  expect(await keys(s)).toContain("Part 5")
  s.resize(105, 34)
  const f = await keys(s)
  expect(miniCol(f, 105).some((c) => BRAILLE.test(c))).toBe(false)
  expect(f).toContain("Part 5")
})

test("minimap with T: off-screen cells unpainted, the band keeps backgroundElement", async () => {
  const t = themeByName("brothy")
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { size: { width: 120, height: 34 } })
  await keys(s, "T")
  const mini = spansOf(s).filter((sp) => BRAILLE.test(sp.text))
  expect(mini.some((sp) => hex(sp.bg) === t.backgroundElement)).toBe(true)
  expect(mini.some((sp) => hex(sp.bg) === null)).toBe(true)
})
