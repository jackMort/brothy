// App: reading in zen: Typewriter, Spotlight, Pages, the teleprompter and the ghost chrome.
import { expect, test } from "bun:test"
import { mix } from "../src/theme"
import { type Setup, B, HINT_ROW, keys, numbered, parts, READING_ROW, sections, sleep, spansOf, waitFrame, useAppHarness } from "./helpers/app"
import { hex } from "./helpers/theme"

const { tmp, mount, zenConfig, savedConfig } = useAppHarness()

/** 1-based zen top line of an `items` fixture with Typewriter off: the first body row shows `item N`. */
const zenAt = (frame: string) => Number(/\bitem (\d+)/.exec(frame.split("\n")[2]!)?.[1]) + 1
/** Lowest `item N` on screen. */
const firstItem = (frame: string) => Math.min(...[...frame.matchAll(/\bitem (\d+)/g)].map((m) => Number(m[1])))

/** A tight list: one rendered line per item. */
const items = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i}`).join("\n") + "\n"

/** fg of the first document span (below the zen top line) containing `text`. */
const docFg = (s: Setup, text: string) =>
  hex(
    s
      .captureSpans()
      .lines.slice(2)
      .flatMap((l) => l.spans)
      .find((sp) => sp.text.includes(text))!.fg,
  )

test("typewriter keeps the reading line on the middle row", async () => {
  const s = await mount(tmp({ "a.md": items(200) }), "a.md")
  let rows = (await keys(s, "z")).split("\n")
  expect(rows[READING_ROW]).toContain("▸")
  expect(rows[READING_ROW]).toMatch(/item 0\b/)
  for (let i = 2; i < READING_ROW; i++) expect(rows[i]!.trim()).toBe("")
  rows = (await keys(s, "j", "j", "j")).split("\n")
  expect(rows[READING_ROW]).toMatch(/▸.*item 3\b/)
  rows = (await keys(s, "G")).split("\n")
  expect(rows[READING_ROW]).toMatch(/item 199\b/)
  for (let i = READING_ROW + 1; i < 28; i++) expect(rows[i]!.trim()).toBe("")
})

test("find in typewriter puts the match on the reading line", async () => {
  const s = await mount(tmp({ "a.md": numbered(200, [150]) }), "a.md")
  const rows = (await keys(s, "z", "/", "type:needle", "enter")).split("\n")
  expect(rows[READING_ROW]).toContain("row 150 needle")
})

test("without typewriter zen scrolls from the top and has no marker", async () => {
  zenConfig({ typewriter: false })
  const s = await mount(tmp({ "a.md": items(200) }), "a.md")
  const f = await keys(s, "z")
  expect(f.split("\n")[2]).toMatch(/item 0\b/)
  expect(f).not.toContain("▸")
})

test("spotlight dims every section but the current one", async () => {
  const s = await mount(
    tmp({ "a.md": "## One\n\nalpha\n\n## Two\n\nbravo\n\n```\nsnippet\n```\n\n## Three\n\ncharlie\n" }),
    "a.md",
  )
  await keys(s, "z")
  const bright = docFg(s, "alpha")
  expect(docFg(s, "bravo")).toBe(mix(bright!, B.background, 0.6)) // brothy background
  await keys(s, "]")
  expect(docFg(s, "bravo")).toBe(bright)
  expect(docFg(s, "alpha")).not.toBe(bright)
  // code-block background (the theme's backgroundElement) is bright in its section, dimmed outside it
  const codeBg = () => hex(spansOf(s).find((sp) => sp.text.includes("snippet"))!.bg)
  const codeBright = codeBg()
  await keys(s, "]")
  expect(codeBg()).not.toBe(codeBright)
  expect(codeBg()).toBe(mix(codeBright!, B.background, 0.6))
})

test("spotlight off leaves every section bright", async () => {
  zenConfig({ spotlight: false })
  const s = await mount(tmp({ "a.md": "## One\n\nalpha\n\n## Two\n\nbravo\n" }), "a.md")
  await keys(s, "z")
  expect(docFg(s, "bravo")).toBe(docFg(s, "alpha"))
})

test("pages: one section per screen, centered, ] and [ flip", async () => {
  zenConfig({ flow: "pages" })
  const s = await mount(tmp({ "a.md": parts(4) }), "a.md")
  let f = await keys(s, "z")
  expect(f).toContain("page 1 of 4")
  expect(f).toContain("body 1")
  expect(f).not.toContain("Part 2")
  expect(f.split("\n").findIndex((l) => l.includes("## Part 1"))).toBeGreaterThan(8) // vertically centered
  f = await keys(s, "]")
  expect(f).toContain("page 2 of 4")
  expect(f).toContain("body 2")
  expect(f).not.toContain("body 1")
  expect(await keys(s, "[")).toContain("page 1 of 4")
  expect(await keys(s, "space")).toContain("page 2 of 4")
  expect(await keys(s, "b")).toContain("page 1 of 4")
  expect(await keys(s, "G")).toContain("page 4 of 4")
  expect(await keys(s, "g")).toContain("page 1 of 4")
})

test("pages: G lands on the start of the last page, not its last line", async () => {
  zenConfig({ flow: "pages" })
  const tall = Array.from({ length: 80 }, (_, i) => `row ${i + 1}\n`).join("\n")
  const s = await mount(tmp({ "a.md": `## One\n\nbody 1\n\n## Last\n\n${tall}` }), "a.md")
  await keys(s, "z")
  const f = await keys(s, "G")
  expect(f).toContain("page 2 of 2")
  expect(f).toContain("## Last")
  expect(f).not.toContain("row 80")
  expect(await keys(s, "g")).toContain("page 1 of 2")
})

test("pages: n after ] stays on or after the current page", async () => {
  zenConfig({ flow: "pages" })
  const s = await mount(tmp({ "a.md": parts(4) }), "a.md")
  await keys(s, "z", "/", "type:body", "enter")
  const f = await keys(s, "]", "n")
  expect(f).toMatch(/page [234] of 4/)
  expect(f).not.toContain("page 1 of 4")
})

test("pages: a tall section scrolls first, then space flips", async () => {
  zenConfig({ flow: "pages" })
  const s = await mount(tmp({ "a.md": "## Long\n\n" + items(60) + "\n## Next\n\nend of doc\n" }), "a.md")
  expect(await keys(s, "z")).toContain("page 1 of 2")
  const f = await keys(s, "space")
  expect(f).toContain("page 1 of 2")
  expect(f).toMatch(/item 4\d\b/)
  expect(await keys(s, "j", "k")).toContain("page 1 of 2")
  const g = await keys(s, "space", "space")
  expect(g).toContain("page 2 of 2")
  expect(g).toContain("end of doc")
})

test("pages: the preamble before the first heading is its own page", async () => {
  zenConfig({ flow: "pages" })
  const s = await mount(tmp({ "a.md": "intro text\n\n## A\n\nalpha\n" }), "a.md")
  expect(await keys(s, "z")).toContain("page 1 of 2")
  expect(await keys(s, "]")).toContain("alpha")
  const f = await keys(s, "[")
  expect(f).toContain("page 1 of 2")
  expect(f).toContain("intro text")
})

test("pages: an empty document is one page", async () => {
  zenConfig({ flow: "pages" })
  const s = await mount(tmp({ "a.md": "" }), "a.md")
  expect(await keys(s, "z", "]", "space")).toContain("page 1 of 1")
})

test("pages: find lands on the page holding the match", async () => {
  zenConfig({ flow: "pages" })
  const s = await mount(tmp({ "a.md": "## A\n\nalpha\n\n## B\n\nthe needle\n" }), "a.md")
  const f = await keys(s, "z", "/", "type:needle", "enter")
  expect(f).toContain("page 2 of 2")
  expect(f).toContain("the needle")
})

test("pages: the mouse wheel scrolls within the page, never past it", async () => {
  zenConfig({ flow: "pages" })
  const s = await mount(tmp({ "a.md": "## Long\n\n" + items(60) + "\n## Next\n\nend of doc\n" }), "a.md")
  const before = firstItem(await keys(s, "z"))
  await s.mockMouse.scroll(50, 15, "down")
  await sleep(50)
  await s.renderOnce()
  expect(firstItem(s.captureCharFrame())).toBeGreaterThan(before) // the wheel does move the page
  for (let i = 0; i < 40; i++) await s.mockMouse.scroll(50, 15, "down")
  await sleep(50)
  await s.renderOnce()
  const f = s.captureCharFrame()
  expect(f).toContain("page 1 of 2")
  expect(f).not.toContain("end of doc")
})

test("space starts the teleprompter; a scroll key pauses it", async () => {
  zenConfig({ prompter: true, typewriter: false, ghost: false, wpm: 400 })
  const s = await mount(tmp({ "a.md": items(300) }), "a.md")
  expect(await keys(s, "z", "space")).toContain("▶ 400 wpm")
  await waitFrame(s, (f) => zenAt(f) >= 3) // 400 wpm over 2 words a line ≈ 3.3 lines a second
  const paused = await keys(s, "j")
  expect(paused).not.toContain("▶ 400 wpm")
  await sleep(700)
  expect(zenAt(await keys(s))).toBe(zenAt(paused))
})

test("a wpm change while rolling takes effect at once, from the popup too", async () => {
  zenConfig({ prompter: true, typewriter: false, ghost: false, wpm: 120 }) // ≈ 1 line a second
  const s = await mount(tmp({ "a.md": items(300) }), "a.md")
  await keys(s, "z", "space", ...Array(14).fill("+")) // → 400 wpm ≈ 3.3 lines a second
  await waitFrame(s, (f) => zenAt(f) >= 3) // within 2 s; at 120 wpm that would take 3
})

test("space at the end of the document does not start the teleprompter", async () => {
  zenConfig({ prompter: true, typewriter: false, ghost: false })
  const s = await mount(tmp({ "a.md": items(30) }), "a.md")
  await keys(s, "z", "G")
  expect(await keys(s, "space")).not.toContain("▶")
})

test("the teleprompter pauses at the end", async () => {
  zenConfig({ prompter: true, typewriter: false, ghost: false, wpm: 400 })
  const s = await mount(tmp({ "a.md": items(30) }), "a.md")
  await keys(s, "z", "space")
  await waitFrame(s, (f) => !f.includes("▶"), 5000)
  const f = await keys(s)
  expect(zenAt(f)).toBe(5) // 30 lines, 26 rows: the last top is line 5
})

test("+ and - change the speed in 20 wpm steps within 120–400, saved at once", async () => {
  zenConfig({ ghost: false })
  const s = await mount(tmp({ "a.md": items(50) }), "a.md")
  expect(await keys(s, "z", "+")).toContain("240 wpm")
  expect(savedConfig().zen.wpm).toBe(240)
  expect(await keys(s, ...Array(10).fill("-"))).toContain("120 wpm")
  expect(savedConfig().zen.wpm).toBe(120)
})

test("without the teleprompter option space pages down", async () => {
  zenConfig({ typewriter: false, ghost: false })
  const s = await mount(tmp({ "a.md": items(300) }), "a.md")
  const f = await keys(s, "z", "space")
  expect(f).not.toContain("▶")
  expect(zenAt(f)).toBe(25)
})

test("ghost chrome shows on a keypress, then fades out; scrolling brings back the top line, not the hints", async () => {
  const s = await mount(tmp({ "a.md": sections(3) }), "a.md")
  const rows = (await keys(s, "z")).split("\n")
  expect(rows[0]).toContain("Section 1")
  expect(rows[HINT_ROW]).toContain("z leave")
  await waitFrame(s, (f) => [0, HINT_ROW].every((r) => f.split("\n")[r]!.trim() === ""), 5000)
  const gone = s.captureCharFrame().split("\n")
  expect(gone[0]!.trim()).toBe("")
  expect(gone[HINT_ROW]!.trim()).toBe("")
  const later = (await keys(s, "j")).split("\n")
  expect(later[0]).toContain("Section 1")
  expect(later[HINT_ROW]!.trim()).toBe("")
})

test("without ghost chrome the top line stays (dimmed); hints still fade", async () => {
  zenConfig({ ghost: false })
  const s = await mount(tmp({ "a.md": sections(3) }), "a.md")
  expect((await keys(s, "z")).split("\n")[HINT_ROW]).toContain("z leave")
  await waitFrame(s, (f) => !f.split("\n")[HINT_ROW]!.includes("leave"), 5000)
  const rows = s.captureCharFrame().split("\n")
  expect(rows[0]).toContain("Section 1")
  expect(rows[HINT_ROW]).not.toContain("leave")
})

test("a popup opened in zen shows its own keys in the hint row, not zen's", async () => {
  const s = await mount(tmp({ "a.md": sections(3) }), "a.md")
  const hint = (await keys(s, "z", "Z")).split("\n")[HINT_ROW]!
  expect(hint).toContain("move")
  expect(hint).not.toContain("scroll")
  expect(hint).not.toContain("leave")
})
