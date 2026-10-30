// App: the Proof sheet, `D`'s diff popup behind ⏎ on the Changed label.
import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { B, filler, keys, OLLAMA, onBg, sleep, useAppHarness, waitFor, waitFrame } from "./helpers"

const { tmp, mount, aiConfig, mountAI } = useAppHarness()

const WALK =
  "# Walk\n\n## One\n\n" +
  filler(12) +
  "\n\nthe old line\n\n## Two\n\ngone soon\n\n## Three\n\nthree\n\n" +
  filler(12).replaceAll("filler", "more") +
  "\n"
const WALK_EDIT =
  WALK.replace("the old line", "the new line here")
    .replace("## Two\n\ngone soon\n\n", "")
    .replace("three\n", "three!\n") + "\n## Four\n\nfour\n"
const SIZE = { width: 120, height: 32 }
/** The popup at 120 columns: 108 wide, 6 in. */
const POPUP_X = 6

/** The sheet's rows, its title row and below, cut to the popup's columns, trailing blanks dropped. */
const sheet = (f: string) => {
  const rows = f.split("\n")
  const top = rows.findIndex((r) => r.includes("What changed"))
  return top < 0 ? null : rows.slice(top, top + 24).map((r) => r.slice(POPUP_X, POPUP_X + 108).trimEnd())
}
const rowWith = (f: string, text: string) => sheet(f)?.find((r) => r.includes(text))

/** WALK reloaded as WALK_EDIT with the panel on Info: four changes, no ai block. */
async function reloaded(ai = false) {
  if (ai) aiConfig(OLLAMA)
  const d = tmp({ "a.md": WALK })
  const run = ai ? await mountAI(d, "a.md", { size: SIZE }) : { s: await mount(d, "a.md", { size: SIZE }), ai: null }
  writeFileSync(join(d, "a.md"), WALK_EDIT)
  await waitFrame(run.s, (f) => f.includes("sections changed"), 4000)
  await keys(run.s, "3")
  return { d, ...run }
}

test("the Changed label is the first Info stop; its footer says ⏎ proof, and ⏎ opens the sheet", async () => {
  const { s } = await reloaded()
  const f = s.captureCharFrame()
  expect(f.split("\n")[30]).toMatch(/↑↓ changes {3}⏎ proof/)
  const open = await keys(s, "enter")
  expect(sheet(open)![0]).toMatch(/What changed\s+since \d\d:\d\d · 4 sections\s+esc$/)
  expect(open.split("\n")[30]).toMatch(/↑↓ section {3}⏎ go to {3}esc close/) // AI off: no D
})

test("with AI off the sheet shows each section's real lines: − removed, + added, context muted", async () => {
  const { s } = await reloaded()
  const f = await keys(s, "enter")
  expect(rowWith(f, "¹ One")).toMatch(/▌¹ One\s+\+1 −1$/)
  expect(rowWith(f, "− the old line")).toBeDefined()
  expect(rowWith(f, "+ the new line here")).toBeDefined()
  expect(rowWith(f, "² Two")).toMatch(/²\s+Two\s+−3$/)
  expect(rowWith(f, "− gone soon")).toBeDefined()
  expect(rowWith(f, "⁴ Four")).toMatch(/Four\s+new$/)
  expect(rowWith(f, "+ four")).toBeDefined()
  const spans = s.captureSpans().lines.flatMap((l) => l.spans)
  const at = (text: string) => spans.find((sp) => sp.text.trim() === text)
  expect(at("−")).toBeDefined()
})

test("↑↓ j k and tab move the block bar; the list keeps the block in view; esc closes", async () => {
  const { s } = await reloaded()
  await keys(s, "enter")
  expect(rowWith(s.captureCharFrame(), "▌")).toContain("¹ One")
  let f = await keys(s, "down")
  expect(rowWith(f, "▌")).toContain("² Two")
  f = await keys(s, "j", "tab")
  expect(rowWith(f, "▌")).toContain("⁴ Four")
  f = await keys(s, "down") // the last block: no wrap
  expect(rowWith(f, "▌")).toContain("⁴ Four")
  s.mockInput.pressTab({ shift: true })
  f = await keys(s, "k")
  expect(rowWith(f, "▌")).toContain("² Two")
  f = await keys(s, "up", "up")
  expect(rowWith(f, "▌")).toContain("¹ One")
  f = await keys(s, "esc")
  expect(sheet(f)).toBeNull()
  expect(f).toContain("Changed since")
})

test("every other key is swallowed while the sheet is open", async () => {
  const { s } = await reloaded()
  await keys(s, "enter")
  const f = await keys(s, "s", "z", "t", "?", "q")
  expect(sheet(f)).not.toBeNull()
  expect(f).not.toContain("Source")
})

test("⏎ closes the sheet and lands on the block's section: the footnote, the heading's mark", async () => {
  const { s } = await reloaded()
  await keys(s, "enter", "down", "down") // ³ Three
  const f = await keys(s, "enter")
  expect(sheet(f)).toBeNull()
  expect(f).toMatch(/─{16} {2,}³ of 4 · \] next/)
  expect(f.split("\n")[30]).toMatch(/\[ \] changes {3}3 all in Info/)
  expect(f).toMatch(/Three³/)
})

test("⏎ on a removed section toasts and keeps the sheet open", async () => {
  const { s } = await reloaded()
  const f = await keys(s, "enter", "down", "enter")
  expect(f).toContain("section removed")
  expect(rowWith(f, "▌")).toContain("² Two")
  expect(sheet(f)).not.toBeNull()
})

test("a click on a block goes to it; the wheel moves the bar", async () => {
  const { s } = await reloaded()
  let f = await keys(s, "enter")
  await s.mockMouse.scroll(60, 12, "down")
  await sleep(30)
  await s.renderOnce()
  f = s.captureCharFrame()
  expect(rowWith(f, "▌")).toContain("² Two")
  const y = f.split("\n").findIndex((r) => r.includes("³ Three"))
  await s.mockMouse.click(30, y)
  await sleep(30)
  await s.renderOnce()
  f = s.captureCharFrame()
  expect(sheet(f)).toBeNull()
  expect(f).toMatch(/³ of 4/)
})

test("D inside: the waiting row on top, the summary streaming in, notes under their blocks; the sheet stays", async () => {
  const { s, ai } = await reloaded(true)
  let f = await keys(s, "enter")
  expect(f.split("\n")[30]).toMatch(/D explain/)
  f = await keys(s, "D")
  await waitFor(s, () => ai!.calls.length === 1)
  f = await keys(s)
  expect(rowWith(f, "▍ asking llama3.2")).toBeDefined()
  expect(sheet(f)![2]).toContain("▍ asking llama3.2") // the first row of the list
  expect(f.split("\n")[30]).toMatch(/D cancel/)
  ai!.send(0, "Everything moved on.\n§1: one line reworded\n§3: three shouts\n")
  f = await waitFrame(s, (x) => x.includes("three shouts"))
  expect(rowWith(f, "Δ Everything moved on.")).toBeDefined()
  expect(rowWith(f, "▍ asking")).toBeUndefined()
  const rows = sheet(f)!
  const one = rows.findIndex((r) => r.includes("¹ One"))
  expect(rows[one + 1]).toMatch(/^\s+one line reworded$/)
  ai!.end(0)
  f = await waitFrame(s, (x) => /since \d\d:\d\d · 4 sections/.test(x) && !x.includes("D cancel"))
  expect(sheet(f)).not.toBeNull()
  expect(f.split("\n")[30]!.slice(0, 70)).not.toMatch(/D (explain|cancel|retry)/) // explained: D has nothing to do
  expect(f).not.toMatch(/─{16} {2,}¹ of/) // D inside the sheet landed nowhere
  expect(rowWith(f, "¹ One")).toContain("¹ One")
  await keys(s, "esc")
  expect(await keys(s)).toMatch(/Changed since \d\d:\d\d · llama3.2/)
})

test("D inside the sheet cancels a running request; a failure shows ✗ on top and D retry", async () => {
  const { s, ai } = await reloaded(true)
  await keys(s, "enter", "D")
  await waitFor(s, () => ai!.calls.length === 1)
  let f = await keys(s, "D")
  expect(f).toContain("explanation cancelled")
  expect(sheet(f)).not.toBeNull()
  expect(rowWith(f, "▍ asking")).toBeUndefined()
  await keys(s, "D")
  await waitFor(s, () => ai!.calls.length === 2)
  ai!.fail(1, "model not found")
  f = await waitFrame(s, (x) => (sheet(x) ?? []).some((r) => r.includes("✗")))
  expect(sheet(f)![2]).toMatch(/✗ .*model not found/)
  expect(f.split("\n")[30]).toMatch(/D retry/)
})

test("80×24: the sheet fills the screen, rows fit it, long lines are cut with …", async () => {
  const long = "word ".repeat(40)
  const d = tmp({ "a.md": `# T\n\n## A\n\n${long}1\n\n${filler(30)}\n` })
  const s = await mount(d, "a.md", { size: { width: 80, height: 24 } })
  writeFileSync(join(d, "a.md"), `# T\n\n## A\n\n${long}2\n\n${filler(30)}\n\n## New\n\n${filler(30)}\n`)
  await waitFrame(s, (f) => f.includes("sections changed"), 4000)
  await keys(s, "3", "enter")
  const f = await keys(s, "j")
  const rows = f.split("\n").slice(0, 24)
  const top = rows.findIndex((r) => r.includes("What changed"))
  expect(top).toBeLessThanOrEqual(2) // the popup fills the 22 rows above the footer
  expect(rows.slice(top).filter((r) => r.length > 80)).toEqual([])
  expect(rows.some((r) => r.includes("… more lines") || r.includes("+ filler"))).toBe(true)
  expect(rows.filter((r) => /…/.test(r)).length).toBeGreaterThan(0)
})

test("a reload that leaves the note as it was closes the sheet", async () => {
  const { s, d } = await reloaded()
  await keys(s, "enter")
  writeFileSync(join(d, "a.md"), WALK)
  await waitFrame(s, (f) => sheet(f) === null && f.includes("Walk"), 4000)
  const f = await keys(s, "j") // keys reach the document again
  expect(f).not.toContain("What changed")
})

test("T keeps the sheet painted; the panel behind it is dimmed by the scrim", async () => {
  const { s } = await reloaded()
  await keys(s, "enter")
  await keys(s, "esc")
  await keys(s, "T", "enter")
  expect(onBg(s, B.backgroundPanel).some((r) => r.includes("What changed"))).toBe(true)
})

test("a sheet closed by leaving the note stays closed", async () => {
  const { s } = await reloaded()
  await keys(s, "enter", "esc")
  await sleep(10)
  expect(sheet(await keys(s, "tab"))).toBeNull()
})
