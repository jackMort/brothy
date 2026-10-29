// App: zen mode: measure, settings, position, find and popups inside zen.
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  HINT_ROW,
  keys,
  loremWidth,
  numbered,
  onBg,
  openHelp,
  panelShown,
  READING_ROW,
  sections,
  useAppHarness,
  waitFrame,
} from "./helpers"

const { cfgDir, tmp, mount, unmount, zenConfig, savedConfig } = useAppHarness()

const OPENING =
  "**brothy** is a terminal Markdown reader with a calm, panel-based interface. Browse a folder of notes on the left, read on the right, and never leave the terminal."
const ZEN_BODY = "lorem ipsum dolor sit amet consectetur ".repeat(8)

test("z hides the status rows, panel and hints, and z brings them back", async () => {
  const s = await mount(tmp({ "a.md": sections(3) }), "a.md")
  const f = await keys(s, "z")
  expect(panelShown(f)).toBe(false)
  expect(f.split("\n")[HINT_ROW]).toContain("z leave")
  expect(f).toContain("Section 1")
  const g = await keys(s, "z")
  expect(panelShown(g)).toBe(true)
  expect(g.split("\n")[HINT_ROW]).toContain("tab panel")
})

test("zen wraps at a 72-column measure, centered in the whole width", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(40) }), "a.md", { size: { width: 200, height: 30 } })
  const f = await keys(s, "z")
  expect(loremWidth(f)).toBeLessThanOrEqual(72)
  expect(loremWidth(f)).toBeGreaterThan(60)
  const below = f.split("\n").find((l) => l.includes("lorem"))!
  const left = below.search(/[a-z]/)
  expect(Math.abs(left - (200 - left - 72))).toBeLessThanOrEqual(2)
})

test("< and > change the zen measure by 4 and save it at once", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(40) }), "a.md", { size: { width: 200, height: 30 } })
  const f = await keys(s, "z", ">", ">")
  expect(f).toContain("measure 80")
  expect(savedConfig().zen.measure).toBe(80)
  expect(loremWidth(f)).toBeGreaterThan(72)
})

test("a measure wider than the terminal is clamped", async () => {
  zenConfig({ measure: 100 })
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(40) }), "a.md", { size: { width: 64, height: 20 } })
  const f = await keys(s, "z")
  expect(loremWidth(f)).toBeLessThanOrEqual(58)
  for (const r of f.split("\n")) expect(r.trimEnd().length).toBeLessThanOrEqual(64)
})

test("> past 100 reaches full measure in zen, < steps back; saved", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(80) }), "a.md", { size: { width: 160, height: 30 } })
  let f = await keys(s, "z", ...Array(8).fill(">"))
  expect(f).toContain("measure full")
  expect(savedConfig().zen.measure).toBe("full")
  expect(loremWidth(f)).toBeGreaterThan(140)
  const first = f.split("\n").find((l) => l.includes("lorem"))!
  expect(first.search(/lorem/)).toBeGreaterThanOrEqual(2)
  expect(first.trimEnd().length).toBeLessThanOrEqual(160 - 2)
  f = await keys(s, "<")
  expect(f).toContain("measure 100")
})

test("esc in zen clears a find first, then leaves zen", async () => {
  const s = await mount(tmp({ "a.md": numbered(200, [150]) }), "a.md")
  const f = await keys(s, "z", "/", "type:needle", "enter")
  expect(panelShown(f)).toBe(false)
  expect(f.split("\n")[READING_ROW]).toContain("row 150 needle")
  expect(panelShown(await keys(s, "esc"))).toBe(false)
  expect(panelShown(await keys(s, "esc"))).toBe(true)
})

test("t in zen opens the theme picker; esc closes it and stays in zen", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  expect(await keys(s, "z", "t")).toContain("Themes")
  const f = await keys(s, "down", "esc")
  expect(f).not.toContain("Themes")
  expect(panelShown(f)).toBe(false)
})

test("s in zen shows the normal Source layout; s again returns to zen", async () => {
  const s = await mount(tmp({ "a.md": "# Title\n\nsome **bold** text\n" }), "a.md")
  const src = await keys(s, "z", "s")
  expect(src.split("\n")[0]).toMatch(/\bsource\s*$/)
  expect(panelShown(src)).toBe(true)
  const back = await keys(s, "s")
  expect(panelShown(back)).toBe(false)
  expect(back).not.toContain("**bold**")
})

test("panel keys do nothing in zen", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  expect(panelShown(await keys(s, "z", "3", "C-b", "tab", "h"))).toBe(false)
  const g = await keys(s, "z")
  expect(panelShown(g)).toBe(true)
  expect(g).not.toMatch(/min read/) // still Files
  expect(onBg(s)).toEqual([]) // and the document kept focus
})
test("zen shares the top line and the progress line", async () => {
  const s = await mount(tmp({ "a.md": "# Guide\n\nintro\n\n" + sections(3) }), "a.md")
  const rows = (await keys(s, "z", "]", "]")).split("\n")
  const top = rows[0]!
  expect(top).toMatch(/Guide › Section 2/)
  expect(rows[29]).toMatch(/\d+% · \d+ min left\s*$/)
})

test("zen keeps its reading position across a resize", async () => {
  const s = await mount(tmp({ "a.md": sections(8, "lorem ipsum dolor sit amet ".repeat(5)) }), "a.md")
  const before = await keys(s, "z", "]", "]", "]", "]", "]")
  expect(before.split("\n")[0]).toContain("Section 6")
  s.resize(70, 30)
  expect((await keys(s)).split("\n")[0]).toContain("Section 6")
})

test("zen is never restored on the next start; its settings are", async () => {
  const root = tmp({ "a.md": "lorem ipsum dolor ".repeat(40) })
  const s = await mount(root, "a.md", { size: { width: 200, height: 30 } })
  await keys(s, "z", ">", ">")
  unmount()
  const again = await mount(root, "a.md", { size: { width: 200, height: 30 } })
  expect(panelShown(await keys(again))).toBe(true)
  expect(loremWidth(await keys(again, "z"))).toBeGreaterThan(72)
})

test("zen on an unreadable file shows the error and the title on the top line", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "missing.md")
  const f = await keys(s, "z")
  expect(f).toContain("Could not open missing.md")
  expect(f.split("\n")[0]).toContain("missing")
})

test("help lists the zen bindings", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { size: { width: 100, height: 70 } })
  const f = await openHelp(s)
  expect(f).toContain("zen mode")
  expect(f).toContain("previous / next section")
})

test("leaving zen without moving restores the exact top line", async () => {
  // paragraphs of mixed word lengths: they wrap differently at the 66-column normal
  // measure and the 72-column zen measure, so a remap alone would drift the top line
  const body = Array.from({ length: 60 }, (_, i) =>
    Array.from({ length: 30 + ((i * 37) % 60) }, (_, j) => "w".repeat(1 + ((i * 7 + j * 3) % 9))).join(" "),
  ).join("\n\n")
  const s = await mount(tmp({ "a.md": body + "\n" }), "a.md")
  const docRows = (f: string) => f.split("\n").slice(2, 8).join("\n")
  for (const n of [2, 4, 7, 12, 20, 31, 45]) {
    const before = docRows(await keys(s, ...Array(n).fill("j")))
    expect(docRows(await keys(s, "z", "z"))).toBe(before)
    expect(docRows(await keys(s, "Z", "esc"))).toBe(before)
  }
})

test("Z opens zen settings with a live preview; esc reverts everything", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(200) }), "a.md", { size: { width: 200, height: 30 } })
  const f = await keys(s, "Z")
  expect(f).toContain("Zen settings")
  expect(f).toContain("◀ scroll ▶")
  expect(panelShown(f)).toBe(false) // opening the popup enters zen for the preview
  const live = await keys(s, "down", "down", "down", "down", "down", "right", "right")
  expect(live).toContain("◀ 80 ▶")
  // the popup covers rows ~10–19; row 24 is below it (a document row with or without Typewriter),
  // and the text behind the backdrop stays in the char frame: it is already wrapped at 80
  const row = live.split("\n")[24]!
  expect(row.trimEnd().length - row.search(/lorem|ipsum|dolor/)).toBeGreaterThan(72)
  const back = await keys(s, "esc")
  expect(back).not.toContain("Zen settings")
  expect(panelShown(back)).toBe(true)
  expect(existsSync(join(cfgDir, "brothy", "config.json"))).toBe(false)
})

test("⏎ in zen settings saves them; they come back on the next start", async () => {
  const root = tmp({ "a.md": sections(2) })
  const s = await mount(root, "a.md")
  await keys(s, "Z", "j", "space")
  const f = await keys(s, "enter")
  expect(f).not.toContain("Zen settings")
  expect(panelShown(f)).toBe(false) // still in zen
  expect(savedConfig().zen.spotlight).toBe(false)
  unmount()
  const again = await mount(root, "a.md")
  const g = await keys(again, "Z")
  expect(g.split("\n").find((l) => l.includes("Spotlight"))).toMatch(/Spotlight\s+off/)
})

test("Z inside zen keeps zen on after esc", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  await keys(s, "z", "Z")
  const f = await keys(s, "esc")
  expect(f).not.toContain("Zen settings")
  expect(panelShown(f)).toBe(false)
})

test("an opening paragraph reads as written, in Preview and in zen: no initial, no altered letters", async () => {
  const s = await mount(tmp({ "a.md": `# A\n\n${OPENING}\n\n## Two\n\nSecond ${ZEN_BODY}\n` }), "a.md", {
    size: { width: 100, height: 40 },
  })
  const f = await keys(s)
  expect(f).toContain("brothy is a terminal Markdown reader")
  expect(f).not.toMatch(/[ᴀ-ᴢʀʏ▘▝▀▖▌▞▛▗▚▐▜▄▙▟]/)
  const z = await keys(s, "z")
  expect(z).toContain("brothy is a terminal")
  expect(z).toContain("Second lorem ipsum")
})

test("copy: the opening paragraph's first rows copy as they are drawn", async () => {
  const s = await mount(tmp({ "a.md": `# A\n\n${OPENING}\n` }), "a.md")
  const copied: string[] = []
  s.renderer.copyToClipboardOSC52 = (text: string) => (copied.push(text), true)
  const rows = s.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes("brothy is a"))
  const x = rows[y]!.indexOf("brothy is a")
  await s.mockMouse.drag(x, y, x + 6, y)
  await waitFrame(s, (f) => f.includes("copied"))
  expect(copied).toEqual(["brothy"])
})
