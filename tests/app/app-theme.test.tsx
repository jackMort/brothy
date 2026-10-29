// App: the theme picker and applying a theme.
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { themeByName } from "../../src/theme/theme"
import { type Setup, keys, onBg, openHelp, spansOf, W120, waitFor, useAppHarness } from "./helpers"
import { hex } from "../helpers/theme"

const { tmp, mount, configFile } = useAppHarness()

/** The background of the specimen the board's cursor frames (`▐ Aa ●●● ▌`): the candidate's. */
const cursorBg = (s: Setup) => {
  const row = s.captureSpans().lines.find((l) => l.spans.some((sp) => sp.text === "▐"))!.spans
  return hex(row.slice(row.findIndex((sp) => sp.text === "▐")).find((sp) => sp.text === "Aa")!.bg)
}

test("a theme from config: a family name opens its dark theme; an unknown name says so once and falls back to brothy", async () => {
  const d = tmp({ "a.md": "# a" })
  const one = await mount(d, "a.md", { size: W120, theme: "one" })
  expect(await openHelp(one)).toMatch(/brothy v\d+\.\d+\.\d+ · one-dark/)
  one.renderer.destroy()
  const nope = await mount(d, "a.md", { size: W120, theme: "nope" })
  expect(await keys(nope)).toContain(`unknown theme "nope" in config`)
  expect(await openHelp(nope)).toMatch(/brothy v\d+\.\d+\.\d+ · brothy\b/)
})

test("clicking a theme row applies it; hover moves the highlight", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md")
  const f = await keys(s, "t")
  const lines = f.split("\n")
  const y = lines.findIndex((l) => /\bgruvbox\b/.test(l))
  expect(y).toBeGreaterThan(0)
  const x = lines[y]!.search(/gruvbox/)
  const bgAt = () => s.captureSpans().lines[y]!.spans.find((sp) => /gruvbox/.test(sp.text))!.bg
  const plain = bgAt()
  await s.mockMouse.moveTo(x, y)
  await keys(s)
  expect(bgAt()).not.toEqual(plain)
  await s.mockMouse.click(x, y)
  const after = await keys(s)
  expect(after).not.toContain("Themes")
  // Info carries the theme name (the toast says it too, so match the Info line)
  expect(await openHelp(s)).toMatch(/brothy v\d+\.\d+\.\d+ · gruvbox/)
})

test("theme picker: hovering a row near the edge moves the highlight, not the list; a key centres it again", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 120, height: 24 } })
  await keys(s, "t")
  const before = await keys(s, ...Array<string>(8).fill("down")) // the list has scrolled to centre the highlight
  /** the family name on each screen row ("" off the board) */
  const names = (f: string) => f.split("\n").map((l) => /([a-z][a-z0-9]*)\s+[▐▕]?\s*Aa ●●●/.exec(l)?.[1] ?? "")
  const rows = before.split("\n")
  const y = names(before).findLastIndex(Boolean) // the last family on screen
  const name = names(before)[y]!
  expect(names(before)).not.toContain("brothy")
  await s.mockMouse.moveTo(rows[y]!.indexOf(name), y)
  const after = await keys(s)
  expect(names(after)).toEqual(names(before)) // nothing moved under the pointer
  expect(after.split("\n")[y]).toContain("▐") // the hovered row has the cursor
  expect(names(await keys(s, "down"))).not.toEqual(names(before)) // a key centres the highlight again
})

test("theme picker: keys move the highlight away from a pointer resting on the board", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 120, height: 30 } })
  const f = await keys(s, "t")
  const names = (f: string) => f.split("\n").map((l) => /([a-z][a-z0-9]*)\s+[▐▕]?\s*Aa ●●●/.exec(l)?.[1] ?? "")
  /** the family on the cursor's row */
  const cursor = (f: string) => names(f)[f.split("\n").findIndex((l) => l.includes("▐"))]
  const y = names(f).findIndex(Boolean) + 3
  const at = (k: number) => names(f)[k]!
  await s.mockMouse.moveTo(f.split("\n")[y]!.indexOf(at(y)), y)
  expect(cursor(await keys(s))).toBe(at(y))
  // the row under the pointer is redrawn when the highlight leaves it, but the pointer never moved
  expect(cursor(await keys(s, "down"))).toBe(at(y + 1))
  expect(cursor(await keys(s, "down", "down"))).toBe(at(y + 3))
  expect(cursor(await keys(s, "up", "up", "up", "up"))).toBe(at(y - 1))
  // moving the pointer still highlights the row it lands on
  await s.mockMouse.moveTo(f.split("\n")[y + 2]!.indexOf(at(y + 2)), y + 2)
  expect(cursor(await keys(s))).toBe(at(y + 2))
})

test("theme picker: keys and the wheel scroll the board under a resting pointer without the highlight snapping back", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 120, height: 24 } })
  const f = await keys(s, "t")
  const names = (f: string) => f.split("\n").map((l) => /([a-z][a-z0-9]*)\s+[▐▕]?\s*Aa ●●●/.exec(l)?.[1] ?? "")
  const cursor = (f: string) => names(f)[f.split("\n").findIndex((l) => l.includes("▐"))]!
  const y = names(f).findLastIndex(Boolean) // the last family on screen: the board scrolls under it
  const x = f.split("\n")[y]!.indexOf(names(f)[y]!)
  await s.mockMouse.moveTo(x, y)
  const seen = [cursor(await keys(s))]
  for (let i = 0; i < 6; i++) seen.push(cursor(await keys(s, "down")))
  for (let i = 0; i < 3; i++) {
    await s.mockMouse.scroll(x, y, "down")
    seen.push(cursor(await keys(s)))
  }
  expect(new Set(seen).size).toBe(seen.length) // every step went on to a new family
})

test("theme picker: a header, one row per family with both specimens, typing filters (j k g G included), ← → tab S-tab move the cursor across", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 80, height: 24 } })
  const f = await keys(s, "t")
  expect(f).toContain("Themes")
  expect(f).toContain("22 families")
  expect(f).toMatch(/▏Theme…\s+dark\s+light/)
  expect(f).toMatch(/\n\s+dark {7}light\s*\n/) // the header, alone on its row
  expect(f).toMatch(/brothy {7}▐ Aa ●●● ▌ {4}Aa ●●●/) // the cursor on brothy (dark), the theme in use (the cursor wins)
  expect(f).toMatch(/\bone\b/)
  expect(f).not.toMatch(/-light|one-dark/) // a family once, no mode suffix
  expect(cursorBg(s)).toBe(themeByName("brothy").background)
  const g = await keys(s, "tab")
  expect(g).toMatch(/brothy {7}▕ Aa ●●● ▏ {2}▐ Aa ●●● ▌/) // the cursor on brothy-light; brothy, in use, keeps its bars
  expect(cursorBg(s)).toBe(themeByName("brothy-light").background)
  s.mockInput.pressTab({ shift: true }) // S-tab flips back
  await keys(s)
  expect(cursorBg(s)).toBe(themeByName("brothy").background)
  await keys(s, "left") // ← is dark already
  expect(cursorBg(s)).toBe(themeByName("brothy").background)
  await keys(s, "right")
  expect(cursorBg(s)).toBe(themeByName("brothy-light").background)
  await keys(s, "down")
  expect(cursorBg(s)).toBe(themeByName("catppuccin-light").background) // ↑↓ keep the column
  const e = await keys(s, "type:gjk")
  expect(e).toContain("gjk▏")
  expect(e).toContain("0 of 22")
  expect(e).toContain("No themes match")
  expect(e).not.toMatch(/\n\s+dark {7}light\s*\n/) // no header without rows
  expect(await keys(s, "enter")).toContain("Themes") // nothing to apply
  const h = await keys(s, "backspace", "backspace", "backspace", "type:ka")
  expect(h).toMatch(/\bkanagawa\b/)
  expect(h).not.toMatch(/\bnord\b/)
  expect(onBg(s, themeByName("brothy").backgroundElement).join("\n")).toContain("kanagawa") // the first row is the cursor row
})

test("theme picker: a click on a specimen applies that family in that mode and saves; on the name it applies the row as it is", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 80, height: 24 } })
  const rowOf = async (name: string) => {
    const f = (await keys(s)).split("\n")
    const y = f.findIndex((r) => new RegExp(`\\b${name}\\b`).test(r) && r.includes("Aa"))
    return { y, r: f[y]! }
  }
  await keys(s, "t")
  let { y, r } = await rowOf("nord")
  await s.mockMouse.click(r.lastIndexOf("Aa"), y) // nord's light specimen
  expect(await keys(s)).not.toContain("Themes")
  expect(JSON.parse(readFileSync(configFile(), "utf8")).theme).toBe("nord-light")
  await keys(s, "t", "type:drac") // the pointer still rests on a row, and hover picks it: filter first
  ;({ y, r } = await rowOf("dracula"))
  await s.mockMouse.click(r.indexOf("Aa"), y) // dracula's dark one
  expect(JSON.parse(readFileSync(configFile(), "utf8")).theme).toBe("dracula")
  // a dark-only family's struck light does nothing; its name applies the row
  await keys(s, "t", "type:vesp")
  ;({ y, r } = await rowOf("vesper"))
  await s.mockMouse.click(r.indexOf("light"), y)
  expect(await keys(s)).toContain("Themes")
  await s.mockMouse.click(r.indexOf("vesper"), y)
  expect(await keys(s)).not.toContain("Themes")
  expect(JSON.parse(readFileSync(configFile(), "utf8")).theme).toBe("vesper")
})

test("theme picker: a click on the dark or light chip sets that mode, as ← → do; the picker stays open", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 80, height: 24 } })
  const swatch = () => cursorBg(s)
  const chip = async (m: "dark" | "light") => {
    const f = (await keys(s)).split("\n")
    const y = f.findIndex((r) => r.includes("nord▏"))
    await s.mockMouse.click(f[y]!.lastIndexOf(m), y)
    return keys(s)
  }
  await keys(s, "t", "type:nord")
  expect(swatch()).toBe(themeByName("nord").background)
  expect(await chip("light")).toContain("Themes")
  expect(swatch()).toBe(themeByName("nord-light").background)
  await chip("light") // the active side stays
  expect(swatch()).toBe(themeByName("nord-light").background)
  await chip("dark")
  expect(swatch()).toBe(themeByName("nord").background)
  // the gap between the chips does nothing, and nothing is applied until ⏎
  const f = (await keys(s)).split("\n")
  const y = f.findIndex((r) => r.includes("nord▏"))
  await s.mockMouse.click(f[y]!.lastIndexOf("light") - 2, y)
  expect(await keys(s)).toContain("Themes")
  expect(swatch()).toBe(themeByName("nord").background)
  await chip("light")
  await keys(s, "enter")
  expect(JSON.parse(readFileSync(configFile(), "utf8")).theme).toBe("nord-light")
})

test("theme picker keeps the app's theme while you move; ⏎ applies and saves, esc changes nothing", async () => {
  const b = themeByName("brothy")
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 80, height: 24 } })
  await keys(s, "t", "down", "down", "tab") // dracula-light
  const hintRow = s.captureSpans().lines[22]!.spans
  expect(hintRow.every((sp) => hex(sp.bg) === b.background)).toBe(true)
  expect(spansOf(s).some((sp) => hex(sp.bg) === b.backgroundPanel && sp.text.includes("Themes"))).toBe(true)
  expect(await keys(s)).not.toContain("Simmering notes") // no pane below 100 columns
  const cells = spansOf(s).filter((sp) => hex(sp.bg) === themeByName("dracula-light").background)
  expect(cells.length).toBeGreaterThan(0)
  expect(cells.every((sp) => /^[ Aa●]+$/.test(sp.text))).toBe(true) // only the specimens paint the candidate
  expect(await keys(s, "esc")).not.toContain("Themes")
  expect(await openHelp(s)).toMatch(/brothy v\d+\.\d+\.\d+ · brothy/)
  expect(existsSync(configFile())).toBe(false)
  await keys(s, "esc", "t", "down", "down", "tab")
  expect((await keys(s, "enter")).split("\n")[22]).toContain("✓ theme · dracula-light")
  expect(JSON.parse(readFileSync(configFile(), "utf8")).theme).toBe("dracula-light")
  // reopened: on the applied family and mode; esc with a query closes at once
  expect(await keys(s, "t")).toMatch(/dracula {8}Aa ●●● {4}▐ Aa ●●● ▌/)
  expect(await keys(s, "down")).toMatch(/dracula {8}Aa ●●● {4}▕ Aa ●●● ▏/) // the theme in use keeps thin bars
  expect(await keys(s, "type:no", "esc")).not.toContain("Themes")
  expect(JSON.parse(readFileSync(configFile(), "utf8")).theme).toBe("dracula-light")
})

test("theme picker pane from 100 columns: the candidate's sample on its own background, the chrome in the app's theme", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 120, height: 34 } })
  const f = await keys(s, "t", "type:gruv", "tab")
  const light = themeByName("gruvbox-light")
  await waitFor(s, () => s.captureCharFrame().includes("let stock"))
  const rows = s.captureCharFrame().split("\n")
  expect(f).toContain("1 of 22")
  expect(rows.some((r) => /dark\s+light\s+│\s+gruvbox-light\s+text \d+\.\d:1/.test(r))).toBe(true) // the header row
  expect(rows.some((r) => /gruvbox\s+Aa ●●●\s+▐ Aa ●●● ▌\s+│/.test(r))).toBe(true)
  expect(rows.some((r) => r.includes("text muted primary second accent error warn success info"))).toBe(true) // short labels at 58 columns
  expect(rows.some((r) => r.includes("Stock wants patience"))).toBe(true) // the sample's text as written
  expect(rows.some((r) => r.includes("│ low   │ reading    │ 8 min │"))).toBe(true) // the whole sample fits 24 rows
  const paneRow = s.captureSpans().lines.find((l) => l.spans.some((sp) => sp.text.includes("Simmering notes")))!
  expect(paneRow.spans.some((sp) => hex(sp.bg) === light.background)).toBe(true)
  expect(hex(paneRow.spans.find((sp) => sp.text === "│")!.fg)).toBe(themeByName("brothy").border)
  // nothing listed: an empty pane
  const g = await keys(s, "type:zz")
  expect(g).not.toContain("Simmering notes")
  // 99 columns: no pane
  const n = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 99, height: 34 } })
  expect(await keys(n, "t")).not.toContain("Simmering notes")
})

test("theme picker scrolls inside a short terminal, keeping the highlight in view; the hint row stays", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 60, height: 14 } })
  const f = await keys(s, "t")
  expect(f).toMatch(/\bbrothy\b/)
  expect(f).not.toMatch(/\bvesper\b/)
  const g = await keys(s, "up") // wraps to the last family
  expect(g).toMatch(/\bvesper\b/)
  expect(g).not.toMatch(/\bbrothy\b/)
  expect(g.trimEnd().split("\n")).toHaveLength(14)
  expect(g.split("\n")[12]).toMatch(/esc close/)
})

test("theme picker on a dark-only family: in light mode the pane previews its dark theme, the switch shows dark, the mode keys do nothing", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 120, height: 34 } })
  const f = await keys(s, "t", "tab", "type:synth")
  expect(f).toMatch(/dark\s+light\s+│\s+synthwave84\s+text \d+\.\d:1/)
  expect(f).toMatch(/synthwave84 ▐ Aa ●●● ▌ {3}light {7}│/) // the cursor on its only theme, light struck through
  const chip = () =>
    s
      .captureSpans()
      .lines.flatMap((l) => l.spans)
      .find((sp) => sp.text === "dark" || sp.text === "light")!
  const t = themeByName("brothy")
  expect(chip()).toMatchObject({ text: "dark" })
  expect(hex(chip().fg)).toBe(t.primary) // dark is the active chip
  const struck = s
    .captureSpans()
    .lines.flatMap((l) => l.spans)
    .find((sp) => sp.text.includes(" light "))!
  expect(hex(struck.fg)).toBe(t.textMuted)
  for (const k of ["tab", "left", "right"]) expect(await keys(s, k)).toMatch(/│\s+synthwave84\s+text/)
  s.mockInput.pressTab({ shift: true })
  expect(await keys(s)).toMatch(/│\s+synthwave84\s+text/)
  // the light mode is still asked for: a pair shows its light theme again
  const erase = Array(5).fill("backspace")
  expect(await keys(s, ...erase, "type:nord")).toMatch(/│\s+nord-light\s+text/)
  const g = await keys(s, ...erase.slice(1), "type:vesp", "enter")
  expect(g).not.toContain("Themes")
  expect(JSON.parse(readFileSync(configFile(), "utf8")).theme).toBe("vesper")
})

test("picking a light theme applies it", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md")
  const f = await keys(s, "t", "type:flex", "tab", "enter")
  expect(f).not.toContain("Themes")
  expect(f).toContain("flexoki-light")
})

test("borderSubtle is only used for decorative glyphs, never for readable text", async () => {
  const sub = themeByName("brothy").borderSubtle
  const drawn = (s: Setup) =>
    spansOf(s)
      .filter((sp) => hex(sp.fg) === sub && sp.text.trim())
      .map((sp) => sp.text.trim())
  const decorative = /^[›\/▸▾─━│]+$/
  const s = await mount(
    tmp({ "a.md": "---\ntitle: A\ntags: [x, y]\nauthor: me\n---\n# a\n\n[b](dir/b.md) [gone](missing.md)\n", "dir/b.md": "# b", "dir/c.md": "# c" }),
    "a.md",
  )
  const seen = [...drawn(s)]
  for (const k of ["2", "3", "1"]) seen.push(...drawn(await keys(s, k).then(() => s)))
  await keys(s, "/")
  seen.push(...drawn(s))
  await keys(s, "esc")
  await openHelp(s)
  seen.push(...drawn(s))
  await keys(s, "j")
  seen.push(...drawn(s))
  expect(seen.length).toBeGreaterThan(0) // fold arrows at least
  expect(seen.filter((t) => !decorative.test(t))).toEqual([])
})
