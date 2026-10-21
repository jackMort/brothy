import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { quietAct } from "./quiet-act"
import { OpenPicker, Overlay, PickerInput, Switcher, ZenSettings, fitHits, scrim } from "../src/overlay"
import type { OpenRow } from "../src/projects"
import { switchRows } from "../src/vault"
import { contrast, themes } from "../src/theme"
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
