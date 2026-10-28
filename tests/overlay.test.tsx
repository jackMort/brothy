import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { quietAct } from "./quiet-act"
import { HelpSheet, OpenPicker, Overlay, PickerInput, Switcher, ThemeBoard, ThemePicker, ZenSettings, fitHits, modeSwitch, scrim } from "../src/overlay"
import { helpLayout } from "../src/help"
import { WORDMARK } from "../src/status"
import type { OpenRow } from "../src/projects"
import { switchRows, type SwitchRow } from "../src/vault"
import { contrast, themeByName, themes } from "../src/theme"
import { A } from "../src/spans"
import { filterFamilies, paneLines, sampleView, themeSplit } from "../src/themepick"
import { ZEN_DEFAULTS, zenRows } from "../src/zen"

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

const hex = (c: { r: number; g: number; b: number; a: number }) =>
  c.a === 0 ? null : "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")

test("ZenSettings lists every row with its value and fills the cursor row", async () => {
  const t = themes[0]!
  setup = quietAct(await testRender(<ZenSettings t={t} W={80} H={24} rows={zenRows(ZEN_DEFAULTS)} cursor={1} />, { width: 80, height: 24 }))
  await setup.renderOnce()
  const f = setup.captureCharFrame()
  for (const s of ["Zen settings", "⏎ save", "esc", "Flow", "◀ scroll ▶", "Spotlight", "Typewriter", "Ghost chrome", "Teleprompter", "off · ◀ 220 wpm ▶", "Measure", "◀ 72 ▶"])
    expect(f).toContain(s)
  const row = setup.captureSpans().lines.find((l) => l.spans.some((sp) => sp.text.includes("Spotlight")))!
  expect(row.spans.some((sp) => hex(sp.bg) === t.primary)).toBe(true)
  const flow = setup.captureSpans().lines.find((l) => l.spans.some((sp) => sp.text.includes("Flow")))!
  expect(flow.spans.some((sp) => hex(sp.bg) === t.primary)).toBe(false)
})

test("disabled rows are drawn muted", async () => {
  const t = themes[0]!
  setup = quietAct(await testRender(<ZenSettings t={t} W={80} H={24} rows={zenRows({ ...ZEN_DEFAULTS, flow: "pages" })} cursor={0} />, {
    width: 80,
    height: 24,
  }))
  await setup.renderOnce()
  const line = setup.captureSpans().lines.find((l) => l.spans.some((sp) => sp.text.includes("Typewriter")))!
  const value = line.spans.find((sp) => sp.text.includes("on"))!
  expect(hex(value.fg)).toBe(t.textMuted)
})

test("scrim is a dark wash over dark themes and a light wash over light themes", () => {
  for (const t of themes) {
    const { r, g, b, a } = scrim(t)
    expect(a, t.name).toBeGreaterThan(100)
    expect(a, t.name).toBeLessThan(220)
    if (t.mode === "dark") expect([r, g, b]).toEqual([0, 0, 0])
    else expect([r, g, b]).toEqual([255, 255, 255])
  }
})

test("Overlay paints its backdrop with the theme's scrim", async () => {
  const backdrop = async (t: (typeof themes)[number]) => {
    setup = quietAct(await testRender(<Overlay t={t} W={60} H={20} width={20} title="X"><text>body</text></Overlay>, { width: 60, height: 20 }))
    await setup.renderOnce()
    const c = setup.captureSpans().lines[0]!.spans[0]!.bg
    setup.renderer.destroy()
    setup = undefined
    return hex(c)!
  }
  const dark = await backdrop(themes.find((t) => t.name === "brothy")!)
  const light = await backdrop(themes.find((t) => t.name === "brothy-light")!)
  expect(contrast(light, "#ffffff")).toBeLessThan(contrast(dark, "#ffffff"))
  expect(light).not.toBe(dark)
})

const rowText = (s: Setup, needle: string) =>
  s.captureSpans().lines.find((l) => l.spans.map((sp) => sp.text).join("").includes(needle))!

test("Switcher: section headers with counts, rows per kind, folder on the right, only the hit row filled", async () => {
  const t = themes[0]!
  const rows = switchRows([
    { title: "Notes", count: "1", hits: [{ kind: "note", path: "/v/s.md", name: "Streams", folder: "dev", hits: [], alias: { text: "Apache Kafka", hits: [7, 8] } }] },
    { title: "Headings", count: "1", hits: [{ kind: "heading", path: "/v/s.md", name: "Streams", folder: "dev", heading: 0, text: "Kafka setup", hits: [0, 1] }] },
    { title: "Text", count: "50+", hits: [{ kind: "text", path: "/v/s.md", name: "Streams", folder: "dev", heading: 0, line: 3, context: "run kafka now", hits: [4, 5] }] },
  ])
  setup = quietAct(await testRender(<Switcher t={t} W={80} H={24} q="ka" rows={rows} hl={3} top={0} height={8} note="indexing 3/9" />, { width: 80, height: 24 }))
  await setup.renderOnce()
  const f = setup.captureCharFrame()
  for (const s of ["Go to", "indexing 3/9", "Notes", "Headings", "50+", "Streams  ← Apache Kafka", "Streams › Kafka setup", "Streams  run kafka now", "dev"]) expect(f).toContain(s)
  expect(rowText(setup, "Headings").spans.some((sp) => hex(sp.bg) === t.primary)).toBe(false)
  expect(rowText(setup, "Kafka setup").spans.some((sp) => hex(sp.bg) === t.primary)).toBe(true)
  const ka = rowText(setup, "run kafka now").spans.find((sp) => sp.text === "ka")!
  expect(hex(ka.fg)).toBe(t.primary)
})

test("Switcher: empty states", async () => {
  const t = themes[0]!
  setup = quietAct(await testRender(<Switcher t={t} W={80} H={24} q="zz" rows={[]} hl={-1} top={0} height={8} />, { width: 80, height: 24 }))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("No results found")
})

test("Switcher: long note names and deep folders never push the match out of the row", async () => {
  const t = themes[0]!
  const name = "2026-07-31-soup-kitchen-inventory-design-and-rollout"
  const folder = "Kitchenware/pantry/docs/soup/12-stock-pots/deeper/still"
  const rows = switchRows([
    { title: "Headings", count: "1", hits: [{ kind: "heading", path: "/v/x.md", name, folder, heading: 0, text: "Access model", hits: [0, 1] }] },
    { title: "Text", count: "1", hits: [{ kind: "text", path: "/v/x.md", name, folder, heading: 0, line: 3, context: "…ePot(p.pot_id)` in `simmerBroths now", hits: [22, 23, 24] }] },
  ])
  setup = quietAct(await testRender(<Switcher t={t} W={80} H={24} q="acc" rows={rows} hl={1} top={0} height={8} />, { width: 80, height: 24 }))
  await setup.renderOnce()
  const f = setup.captureCharFrame()
  expect(f).toContain("Access model")
  expect(f).toContain("simmerBroths")
  expect(f).toContain("still") // the folder keeps its tail
})

test("Switcher at 60 columns: a match late in a long heading or note name stays on screen, cuts marked …", async () => {
  const t = themes[0]!
  const heading = "State version management and the warning banner"
  const name = "2026-05-18-lentil-soup-configuration-callout-panel"
  const rows = switchRows([
    { title: "Notes", count: "1", hits: [{ kind: "note", path: "/v/n.md", name, folder: "Kitchenware/lentil-soup/specs", hits: [...Array(7).keys()].map((i) => 37 + i) }] },
    { title: "Headings", count: "1", hits: [{ kind: "heading", path: "/v/h.md", name: "2026-10-02-saucier-state", folder: "Kitchenware/saucier", heading: 0, text: heading, hits: [...Array(7).keys()].map((i) => 33 + i) }] },
  ])
  setup = quietAct(await testRender(<Switcher t={t} W={60} H={14} q="x" rows={rows} hl={1} top={0} height={6} />, { width: 60, height: 14 }))
  await setup.renderOnce()
  for (const word of ["callout", "warning"]) {
    const row = rowText(setup, word)
    expect(row.spans.filter((sp) => hex(sp.fg) === t.primary || hex(sp.bg) === t.primary).map((sp) => sp.text).join("")).toContain(word)
    expect(row.spans.map((sp) => sp.text).join("")).toContain("…")
  }
})

test("fitHits: the end is cut first; a late match gets a window; wide characters count double", () => {
  expect(fitHits("short", [0], 10)).toEqual({ text: "short", hits: [0] })
  expect(fitHits("abcdefghij", [1, 2], 6)).toEqual({ text: "abcde…", hits: [1, 2] })
  const late = fitHits("abcdefghijklmnopqrst", [15, 16], 8)
  expect(late.text.startsWith("…")).toBe(true)
  expect(late.hits.map((h) => [...late.text][h]).join("")).toBe("pq")
  expect(Bun.stringWidth(late.text)).toBeLessThanOrEqual(8)
  const cjk = fitHits("日本語のテキストと検索", [9, 10], 9)
  expect(cjk.hits.map((h) => [...cjk.text][h]).join("")).toBe("検索")
  expect(Bun.stringWidth(cjk.text)).toBeLessThanOrEqual(9)
})

test("OpenPicker: Recent rows with the ~ path and last note, missing ones muted, then the Path section", async () => {
  const t = themes[0]!
  const home = "/home/me"
  const e = (root: string, lastNote: string | null) => ({ root, lastNote, top: 0, at: 0 })
  const rows: OpenRow[] = [
    { kind: "header", title: "Recent", count: "2" },
    { kind: "recent", entry: e("/home/me/work/brothy", "/home/me/work/brothy/README.md"), name: "brothy", hits: [0, 1], score: 0, missing: false },
    { kind: "recent", entry: e("/home/me/old", null), name: "old", hits: [], score: 0, missing: true },
    { kind: "header", title: "Path", count: "1" },
    { kind: "path", path: "/home/me", name: "~/", dir: true, hits: [], completion: "~/", self: true },
    { kind: "path", path: "/home/me/Docs", name: "Docs", dir: true, hits: [0], completion: "~/Docs/" },
  ]
  setup = quietAct(await testRender(<OpenPicker t={t} W={80} H={24} q="~/" rows={rows} hl={1} top={0} height={8} home={home} />, { width: 80, height: 24 }))
  await setup.renderOnce()
  const f = setup.captureCharFrame()
  for (const s of ["Open", "Recent", "Path", "brothy", "~/work/brothy", "README", "old", "missing", "Docs/", "this folder"]) expect(f).toContain(s)
  expect(rowText(setup, "~/work/brothy").spans.some((sp) => hex(sp.bg) === t.primary)).toBe(true)
  const old = rowText(setup, "missing").spans.find((sp) => sp.text.includes("old"))!
  expect(hex(old.fg)).toBe(t.textMuted)
  const docs = rowText(setup, "Docs/").spans.find((sp) => sp.text === "D")!
  expect(hex(docs.fg)).toBe(t.primary)
})

test("OpenPicker: no recents says how to start", async () => {
  const t = themes[0]!
  setup = quietAct(await testRender(<OpenPicker t={t} W={80} H={24} q="" rows={[]} hl={-1} top={0} height={8} />, { width: 80, height: 24 }))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("No recent projects")
})

test("PickerInput shows the tail of a long query with the cursor", async () => {
  const t = themes[0]!
  const q = "a".repeat(80) + "END"
  setup = quietAct(await testRender(<PickerInput t={t} value={q} placeholder="x" note="3 matches" width={40} />, { width: 40, height: 2 }))
  await setup.renderOnce()
  const f = setup.captureCharFrame()
  expect(f).toContain("END▏")
  expect(f).toContain("…")
  expect(f).toContain("3 matches")
})

test("Switcher in Ask mode: title, answers with hits on the right, action rows, muted notes never filled", async () => {
  const t = themes[0]!
  const rows: SwitchRow[] = [
    { kind: "header", title: "Answers", count: "2" },
    { kind: "answer", path: "/v/g.md", name: "getting-started", heading: 2, text: "Open a single file", key: "open a single file", ord: 0, id: "/v/g.md#open a single file#0", query: "single file", hits: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], right: "3/5" },
    { kind: "answer", path: "/v/r.md", name: "README", heading: -1, text: "", key: "", ord: 0, id: "/v/r.md##0", query: "path", hits: [], right: "1/5" },
    { kind: "askAction", act: "rerank", text: "↻ rerank with excerpts", note: " · ~1.3k tokens" },
    { kind: "askNote", text: "searched: open file · path" },
  ]
  setup = quietAct(await testRender(<Switcher t={t} W={80} H={24} title="Ask" q="?how" rows={rows} hl={3} top={0} height={8} note="claude-haiku-5-5" />, { width: 80, height: 24 }))
  await setup.renderOnce()
  const f = setup.captureCharFrame()
  for (const s of ["Ask", "claude-haiku-5-5", "Answers", "getting-started › Open a single file", "3/5", "README", "1/5", "↻ rerank with excerpts · ~1.3k tokens", "searched: open file · path"]) expect(f).toContain(s)
  expect(f).not.toContain("Go to")
  expect(rowText(setup, "rerank with excerpts").spans.some((sp) => hex(sp.bg) === t.primary)).toBe(true)
  expect(rowText(setup, "searched:").spans.some((sp) => hex(sp.bg) === t.primary)).toBe(false)
  expect(rowText(setup, "Open a single file").spans.some((sp) => sp.text.includes("single") && hex(sp.fg) === t.primary)).toBe(true)
})

test("Switcher in Ask mode: an error row leads with ✗ in the error color", async () => {
  const t = themes[0]!
  const rows: SwitchRow[] = [{ kind: "askAction", act: "ask", text: "AI: rate limited · ⏎ asks again", note: "", error: true }]
  setup = quietAct(await testRender(<Switcher t={t} W={80} H={24} title="Ask" q="?how" rows={rows} hl={0} top={0} height={8} note="6 notes" />, { width: 80, height: 24 }))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("✗ AI: rate limited · ⏎ asks again")
  setup.renderer.destroy()
  setup = quietAct(await testRender(<Switcher t={t} W={80} H={24} title="Ask" q="?how" rows={rows} hl={-1} top={0} height={8} />, { width: 80, height: 24 }))
  await setup.renderOnce()
  expect(hex(rowText(setup, "rate limited").spans.find((sp) => sp.text.startsWith("✗"))!.fg)).toBe(t.error)
})

test("HelpSheet: primary wordmark, role chips on backgroundElement and today's key rows, two columns side by side at 120", async () => {
  const t = themes[0]!
  const groups = [
    { title: "Global", entries: [{ keys: "q", desc: "quit" }, { keys: "t", desc: "pick theme" }] },
    { title: "Document", entries: [{ keys: "j k ↑ ↓", desc: "scroll a line" }] },
    { title: "AI", entries: [{ keys: "a", desc: "summarize the note (Info tab) and a description far too long to fit its column" }] },
  ]
  const layout = helpLayout(groups, 120, 34)
  setup = quietAct(await testRender(<HelpSheet t={t} W={120} H={34} layout={layout} top={0} title="Keybindings" />, { width: 120, height: 34 }))
  await setup.renderOnce()
  const f = setup.captureCharFrame()
  const lines = setup.captureSpans().lines
  const rowOf = (s: string) => lines.find((l) => l.spans.map((sp) => sp.text).join("").includes(s))!
  const wm = rowOf(WORDMARK[0]!.trim().slice(0, 4))
  expect(wm.spans.filter((sp) => sp.text.trim()).map((sp) => hex(sp.fg))).toEqual([t.primary])
  const chipRow = rowOf("Global")
  expect(chipRow.spans.map((sp) => sp.text).join("")).toContain("Document") // side by side
  for (const [title, role] of [["Global", t.primary], ["Document", t.secondary]] as const) {
    const sp = chipRow.spans.find((x) => x.text.includes(title))!
    expect(hex(sp.fg)).toBe(role)
    expect(hex(sp.bg)).toBe(t.backgroundElement)
  }
  const ai = rowOf(" AI ").spans.find((x) => x.text.includes("AI"))!
  expect(hex(ai.fg)).toBe(t.accent)
  const text = f.split("\n")
  const q = text.find((r) => r.includes("quit"))!
  expect(q).toMatch(/ q {15}quit/)
  expect(hex(rowOf("quit").spans.find((x) => x.text.includes("quit"))!.fg)).toBe(t.textMuted)
  expect(text.find((r) => r.includes("summarize"))).toContain("…")
  // keys and chips share a column edge; the chip's padding cell sits left of it
  expect(q.indexOf("q")).toBe(text.find((r) => r.includes("Global"))!.indexOf("Global"))
})

test("Switcher with a peek at 120 columns: list, │ divider and pane side by side; no pane below 100", async () => {
  const t = themes[0]!
  const rows = switchRows([{ title: "Notes", count: "1", hits: [{ kind: "note", path: "/v/s.md", name: "Streams", folder: "dev", hits: [] }] }])
  const peek = [
    [{ text: "dev/s.md", fg: t.textMuted }, { text: " ".repeat(41 - 8 - 5) }, { text: "2 min", fg: t.textMuted }],
    [],
    [{ text: "Kafka in five minutes.", fg: t.text }],
  ]
  setup = quietAct(await testRender(<Switcher t={t} W={120} H={34} q="str" rows={rows} hl={1} top={0} height={16} peek={peek} />, { width: 120, height: 34 }))
  await setup.renderOnce()
  const f = setup.captureCharFrame().split("\n")
  const row = f.find((r) => r.includes("Streams"))!
  expect([...row].indexOf("S")).toBe(11) // list text where v3 has it: popup at 6, padding 5
  expect([...row][65]).toBe("│")
  const head = f.find((r) => r.includes("dev/s.md"))!
  expect([...head].indexOf("d", 66)).toBe(68)
  expect([...head].slice(104, 109).join("")).toBe("2 min")
  expect(f.filter((r) => [...r][65] === "│")).toHaveLength(16)
  const div = setup.captureSpans().lines.flatMap((l) => l.spans).find((sp) => sp.text.includes("│"))!
  expect(hex(div.fg)).toBe(t.border)
  setup.renderer.destroy()
  setup = quietAct(await testRender(<Switcher t={t} W={90} H={30} q="str" rows={rows} hl={1} top={0} height={10} peek={peek} />, { width: 90, height: 30 }))
  await setup.renderOnce()
  const g = setup.captureCharFrame()
  expect(g).not.toContain("Kafka in five minutes.")
  expect(g).not.toContain("│")
})

test("ThemeBoard: a header, then the name and a specimen per mode; the cursor row tinted, its cell framed in primary, the theme in use in muted bars", async () => {
  const t = themes[0]!
  const rows = filterFamilies("")
  const nord = rows.findIndex((r) => r.family.name === "nord")
  const pick = { i: -1, m: "" }
  const rowClicks: number[] = []
  setup = quietAct(
    await testRender(
      <ThemeBoard t={t} rows={rows} hl={nord} top={0} height={22} innerW={41} mode="light" shown="light" orig="brothy" onPick={(i, m) => Object.assign(pick, { i, m })} onActivate={(i) => rowClicks.push(i)} />,
      { width: 41, height: 23 },
    ),
  )
  await setup.renderOnce()
  const f = setup.captureCharFrame().split("\n")
  expect(f[0]).toBe(" ".repeat(4 + 12) + "   dark   " + " " + "  light   " + "    ")
  expect(f[1]).toBe("    brothy      ▕ Aa ●●● ▏   Aa ●●●      ") // the theme in use: thin bars
  expect(f[1 + nord]).toBe("    nord          Aa ●●●   ▐ Aa ●●● ▌    ") // the cursor on nord-light
  expect(f[21]).toBe("    synthwave84   Aa ●●●     light       ")
  const lines = setup.captureSpans().lines
  const sel = lines[1 + nord]!.spans
  expect(sel.find((sp) => sp.text.includes("nord"))!.attributes & A.BOLD).toBe(A.BOLD)
  expect(hex(sel.find((sp) => sp.text.includes("nord"))!.bg)).toBe(t.backgroundElement) // chrome: the app's theme
  const light = themeByName("nord-light")
  expect(hex(sel.find((sp) => sp.text === "Aa" && hex(sp.bg) === light.background)!.fg)).toBe(light.text) // cells: the candidate's roles
  expect(hex(sel.find((sp) => sp.text === "▐")!.fg)).toBe(t.primary)
  expect(hex(lines[1]!.spans.find((sp) => sp.text === "▕")!.fg)).toBe(t.textMuted)
  expect(lines[2]!.spans.every((sp) => hex(sp.bg) !== t.backgroundElement)).toBe(true) // other rows untinted
  const struck = lines[21]!.spans.find((sp) => sp.text === "light")!
  expect(hex(struck.fg)).toBe(t.textMuted)
  expect(struck.attributes & A.STRIKE).toBe(A.STRIKE)
  expect(hex(lines[0]!.spans.find((sp) => sp.text.includes("light"))!.fg)).toBe(t.primary) // the shown mode
  // a click on a specimen picks that row and mode; a missing mode does nothing
  await setup.mockMouse.click(f[3]!.indexOf("Aa"), 3)
  expect(pick).toEqual({ i: 2, m: "dark" })
  await setup.mockMouse.click(f[21]!.indexOf("light"), 21) // synthwave84's struck light: nothing at all
  expect(pick).toEqual({ i: 2, m: "dark" })
  expect(rowClicks).toEqual([])
  await setup.mockMouse.click(f[21]!.indexOf("synthwave84"), 21) // the name applies the row
  expect(rowClicks).toEqual([20])
  setup.renderer.destroy()
  setup = quietAct(await testRender(<ThemeBoard t={t} rows={[]} hl={-1} top={0} height={5} innerW={41} mode="dark" shown="dark" orig="brothy" />, { width: 41, height: 3 }))
  await setup.renderOnce()
  const g = setup.captureCharFrame()
  expect(g).toContain("No themes match")
  expect(g).not.toContain("dark") // no header without rows
})

test("modeSwitch: the active side is a primary chip on backgroundElement, the other muted", () => {
  const t = themes[0]!
  const segs = modeSwitch(t, "light")
  expect(segs.map((seg) => seg.map((s) => s.text).join(""))).toEqual([" dark ", " light "]) // SWITCH_MODES order, one per chip
  expect(segs[1]!.find((s) => s.text === "light")).toMatchObject({ fg: t.primary, bg: t.backgroundElement, attr: 1 })
  expect(segs[0]!.map((s) => s.fg)).toEqual([t.textMuted])
  expect(segs[0]![0]!.attr).toBeUndefined()
  // a dark-only family: dark is the chip, light muted and struck through
  const only = modeSwitch(t, "dark", "dark")
  expect(only[0]!.find((s) => s.text === "dark")).toMatchObject({ fg: t.primary })
  expect(only[1]).toEqual([{ text: " light ", fg: t.textMuted, attr: A.STRIKE }])
})

test("ThemePicker at 120 columns: query with the mode switch, 41-wide board, │, the pane on the candidate's background; no pane below 100", async () => {
  const t = themes[0]!
  const x = themeByName("rosepine-light")
  const geo = themeSplit(120, 34, 16)
  const rows = filterFamilies("")
  const pane = { theme: x, lines: paneLines(x, sampleView(x, geo.peekW), geo.peekW, geo.rows) }
  setup = quietAct(await testRender(<ThemePicker t={t} W={120} H={34} q="" rows={rows} hl={6} top={0} mode="light" orig="brothy" geo={geo} pane={pane} />, { width: 120, height: 34 }))
  await setup.renderOnce()
  const f = setup.captureCharFrame().split("\n")
  expect(f[2]).toMatch(/Themes\s+22 families  esc/)
  expect(f[4]).toMatch(/▏Theme…\s+dark   light/)
  const row = f.find((r) => /^\s+rosepine\s/.test(r))!
  expect([...row].indexOf("r")).toBe(11) // popup at 6, padding 5, as in the switcher
  expect([...row][48]).toBe("│") // 6 + 1 + 41
  expect(f.filter((r) => [...r][48] === "│")).toHaveLength(24)
  expect(f[6]).toMatch(/^\s+dark\s+light\s+│/) // the header row
  expect(f.find((r) => r.includes("rosepine-light"))!.indexOf("rosepine-light")).toBe(51)
  expect(f.some((r) => r.includes("brothy"))).toBe(true)
  const lines = setup.captureSpans().lines
  const sel = lines.find((l) => l.spans.some((sp) => sp.text.includes("rosepine") && !sp.text.includes("-")))!
  expect(sel.spans.some((sp) => hex(sp.bg) === t.backgroundElement)).toBe(true) // the chrome is the app's theme
  expect(sel.spans.some((sp) => sp.text === "▐" && hex(sp.fg) === t.primary)).toBe(true)
  const head = lines.find((l) => l.spans.some((sp) => sp.text.includes("Simmering notes")))!
  expect(head.spans.some((sp) => hex(sp.bg) === x.background)).toBe(true)
  setup.renderer.destroy()
  setup = quietAct(await testRender(<ThemePicker t={t} W={80} H={24} q="" rows={rows} hl={6} top={0} mode="light" orig="brothy" geo={themeSplit(80, 24, 16)} />, { width: 80, height: 24 }))
  await setup.renderOnce()
  const g = setup.captureCharFrame()
  expect(g).not.toContain("│")
  expect(g).toContain("flexoki")
})
