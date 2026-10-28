import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { quietAct } from "./quiet-act"

// keep the theme picker from touching the real ~/.config
const prevXdg = process.env.XDG_CONFIG_HOME
const cfgDir = mkdtempSync(join(tmpdir(), "brothy-cfg-"))
process.env.XDG_CONFIG_HOME = cfgDir
const prevCache = process.env.XDG_CACHE_HOME
const cacheDir = mkdtempSync(join(tmpdir(), "brothy-cache-"))
process.env.XDG_CACHE_HOME = cacheDir
afterAll(async () => {
  await shutdownHighlighter() // the parser worker would otherwise keep the process alive
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevXdg
  rmSync(cfgDir, { recursive: true, force: true })
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = prevCache
  rmSync(cacheDir, { recursive: true, force: true })
})
const { App } = await import("../src/App")
import type { EditResult } from "../src/editor"
const { shutdownHighlighter } = await import("../src/highlight")
import { mix, themeByName } from "../src/theme"
import { GHOST_STEP, HINT_HOLD } from "../src/zen"

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
const dirs: string[] = []
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
  rmSync(join(cacheDir, "brothy"), { recursive: true, force: true })
  rmSync(join(cfgDir, "brothy"), { recursive: true, force: true }) // folds and theme persist; keep tests independent
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "brothy-app-"))
  dirs.push(d)
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, name)), { recursive: true })
    writeFileSync(join(d, name), body)
  }
  return d
}

const { noteText } = await import("../src/ai")
const { textHash } = await import("../src/summaries")
const { DELTA_PROMPT } = await import("../src/delta")
function aiConfig(ai: object) {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), JSON.stringify({ ai }))
}
const OLLAMA = { provider: "ollama", model: "llama3.2" }
function seedSummary(path: string, summary: string, hash = textHash(noteText(readFileSync(path, "utf8"))), model = "llama3.2") {
  mkdirSync(join(cacheDir, "brothy"), { recursive: true })
  writeFileSync(join(cacheDir, "brothy", "summaries.json"), JSON.stringify({ [path]: { hash, v: 1, summary, model, at: Date.now() } }))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Render until `pred` holds. App timers (OPEN_DELAY, fades, the teleprompter) run late under load: wait, don't sleep. */
async function waitFor(s: Setup, pred: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    await s.renderOnce()
    if (pred()) return
  }
  throw new Error("never matched:\n" + s.captureCharFrame())
}
/** Resolves with the frame that matched. */
const waitFrame = (s: Setup, pred: (f: string) => boolean, ms = 2000) => waitFor(s, () => pred(s.captureCharFrame()), ms).then(() => s.captureCharFrame())

async function mount(root: string, file?: string, size = { width: 100, height: 30 }, fetch?: typeof globalThis.fetch) {
  setup = quietAct(await testRender(<App root={root} initialFile={file ? join(root, file) : undefined} fetch={fetch} />, size))
  await setup.renderOnce()
  return setup
}

/**
 * OpenTUI's stdin parser holds a lone ESC for 20 ms (it may start a sequence) before it becomes a
 * key. Waiting past that first lets the next sleep give React its commit; a sleep that merely
 * ties with the flush timer can capture the frame before esc lands.
 */
const ESC_HOLD = 30

async function keys(s: Setup, ...ks: string[]) {
  for (const k of ks) {
    if (k === "tab") s.mockInput.pressTab()
    else if (k === "enter") s.mockInput.pressEnter()
    else if (k === "esc") {
      s.mockInput.pressEscape()
      await sleep(ESC_HOLD)
    }
    else if (k === "down" || k === "up" || k === "left" || k === "right") s.mockInput.pressArrow(k)
    else if (k === "space") s.mockInput.pressKey(" ")
    else if (k === "backspace") s.mockInput.pressBackspace()
    else if (k.startsWith("type:")) await s.mockInput.typeText(k.slice(5))
    else if (k.startsWith("C-")) s.mockInput.pressKey(k.slice(2), { ctrl: true })
    else s.mockInput.pressKey(k)
    await sleep(5)
    await s.renderOnce()
  }
  await sleep(20)
  await s.renderOnce()
  return s.captureCharFrame()
}

/** 1-based top line of a `numbered` fixture: the first body row shows `row N` (document line N + 2). */
const topLine = (frame: string) => Number(/\brow (\d+)/.exec(frame.split("\n")[2]!)?.[1]) + 2

/** brothy's primary: the fill of a selected sidebar row */
const PRIMARY = "#59c9be"
const hex = (c: { r: number; g: number; b: number; a: number }) =>
  c.a === 0 ? null : "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")
/** Per screen row, the text drawn on background `bg` (rows without any are dropped). */
function onBg(s: Setup, bg = PRIMARY) {
  return s
    .captureSpans()
    .lines.map((l) => l.spans.filter((sp) => hex(sp.bg) === bg).map((sp) => sp.text).join(""))
    .filter(Boolean)
}

/** Ghost line row at 100x30: top line, gap, 26 body rows, ghost line (28), progress line (29). */
const HINT_ROW = 28

/** `?` shows hints first when none are visible; press again until the popup opens. */
async function openHelp(s: Setup) {
  const f = await keys(s, "?")
  return f.includes("Keybindings") ? f : keys(s, "?")
}
const PAST_HINTS = () => new Date(Date.now() + HINT_HOLD + 4 * GHOST_STEP + 10)

/** The panel's tab strip is on screen (compact `¹Files  ²Outline` or full `¹Files   ²Outline`). */
const panelShown = (f: string) => /Files\s+²Outline/.test(f)

/** A code block of numbered lines with `needle` on the given ones. */
function numbered(n: number, needles: number[]) {
  const body = Array.from({ length: n }, (_, i) => (needles.includes(i) ? `row ${i} needle` : `row ${i}`))
  return "```\n" + body.join("\n") + "\n```\n"
}

function sections(n: number, para = "text") {
  return Array.from({ length: n }, (_, i) => `## Section ${i + 1}\n\n${(para + "\n\n").repeat(12)}`).join("")
}

test("n moves to the next match instead of sticking on the current one", async () => {
  const s = await mount(tmp({ "a.md": numbered(200, [50, 60, 70]) }), "a.md")
  const first = topLine(await keys(s, "/", "type:needle", "enter"))
  expect(topLine(await keys(s, "n"))).toBe(first + 10)
  expect(topLine(await keys(s, "n"))).toBe(first + 20)
  expect(topLine(await keys(s, "N"))).toBe(first + 10)
})

test("n after a match clamped near the top still advances", async () => {
  const s = await mount(tmp({ "a.md": numbered(200, [2, 4, 100]) }), "a.md")
  await keys(s, "/", "type:needle", "enter")
  // 2 and 4 both fit at top=0; the second n must reach 100
  await keys(s, "n")
  expect(topLine(await keys(s, "n"))).toBeGreaterThan(80)
})

test("find from the document after visiting the Outline scrolls the document", async () => {
  const s = await mount(tmp({ "a.md": numbered(200, [120]) }), "a.md")
  const f = await keys(s, "2", "tab", "/", "type:needle", "enter")
  expect(topLine(f)).toBeGreaterThan(100)
})

test("the Outline opens its cursor on the heading being read; ⏎ jumps", async () => {
  const s = await mount(tmp({ "a.md": sections(6) }), "a.md")
  await keys(s, "]", "]", "]")
  expect(onBg(s)).toEqual([]) // no cursor bar while the document has focus
  await keys(s, "2")
  expect(onBg(s)[0]).toContain("Section 4")
  await keys(s, "j", "enter")
  expect((await keys(s)).split("\n")[0]).toContain("› Section 5")
})
test("fast keypresses between renders are not dropped", async () => {
  const s = await mount(tmp({ "a.md": numbered(200, []) }), "a.md")
  for (let i = 0; i < 5; i++) s.mockInput.pressKey("j")
  await sleep(20)
  await s.renderOnce()
  expect(topLine(s.captureCharFrame())).toBe(6)
})

test("the Files cursor follows the open note after esc clears the filter", async () => {
  const files = Object.fromEntries("abcdefghij".split("").map((c) => [`${c}.md`, `# ${c}`]))
  const s = await mount(tmp(files), "a.md")
  await keys(s, "tab", "/", "type:h", "enter", "tab", "esc")
  expect(onBg(s)[0]).toMatch(/^\s+●?\s*h\s*$/)
})

const pocs = () => tmp({ "other.md": "# other", "poc notes.md": "# poc", "Proof of concept.md": "# proof", "deep/pocket.md": "# pocket" })

test("/ in Files filters inline: a query row, ranked notes with their folder, no popup", async () => {
  const s = await mount(pocs(), "other.md")
  const f = await keys(s, "tab", "/", "type:poc")
  expect(f).toMatch(/\/ poc▏\s+3/)
  expect(f).not.toContain("Filter Files")
  const rows = f.split("\n")
  const i = rows.findIndex((l) => /pocket\s+deep/.test(l))
  expect(i).toBeGreaterThan(0)
  expect(rows[i + 1]).toContain("poc notes")
  expect(rows[i + 2]).toContain("Proof of concept")
  expect(onBg(s)[0]).toContain("pocket") // the top result
})

test("⏎ opens the result and focuses the document; the filter stays applied", async () => {
  const s = await mount(pocs(), "other.md")
  const f = await keys(s, "tab", "/", "type:pocket", "enter")
  expect(f.split("\n")[0]).toContain("pocket")
  expect(onBg(s)).toEqual([])
  const g = await keys(s, "tab")
  expect(g).toMatch(/\/ pocket\s+1/)
  expect(g).not.toContain("▏")
})

test("esc clears the filter while typing; ⌫ on an empty query stops typing", async () => {
  const s = await mount(pocs(), "other.md")
  expect(await keys(s, "tab", "/", "type:poc", "esc")).not.toContain("/ poc")
  expect(await keys(s, "/", "type:p", "backspace", "backspace")).not.toContain("▏")
})

test("while typing, j k 1 ? are text, not commands", async () => {
  const f = await keys(await mount(pocs(), "other.md"), "tab", "/", "type:jk1?")
  expect(f).toContain("/ jk1?")
  expect(f).not.toContain("Keybindings")
  expect(f).toContain("no matching notes")
})

test("/ in Info switches to Files and starts the filter", async () => {
  expect(await keys(await mount(pocs(), "other.md"), "3", "/", "type:poc")).toMatch(/\/ poc▏/)
})

test("esc in the document leaves the panel filter alone", async () => {
  const s = await mount(pocs(), "other.md")
  await keys(s, "tab", "/", "type:poc", "tab", "esc", "tab")
  expect(await keys(s)).toMatch(/\/ poc\s+3/)
})

test("moving through filter results previews the note after OPEN_DELAY", async () => {
  const s = await mount(pocs(), "other.md")
  await keys(s, "tab", "/", "type:poc", "down") // top result is pocket; down moves to "poc notes"
  expect(s.captureCharFrame().split("\n")[0]).not.toContain("poc notes")
  await waitFrame(s, (f) => f.split("\n")[0]!.includes("poc notes")) // opened after OPEN_DELAY
})

test("a pending filter preview is cancelled by esc, typing and leaving the panel", async () => {
  for (const after of [["esc"], ["type:x"], ["tab"]]) {
    const s = await mount(pocs(), "other.md")
    await keys(s, "tab", "/", "type:poc", "down", ...after) // down arms the preview of "poc notes"
    await sleep(150)
    await s.renderOnce()
    expect(s.captureCharFrame().split("\n")[0]).not.toContain("poc notes")
    s.renderer.destroy()
    setup = undefined
  }
})

test("a click in the document ends filter typing; the filter text stays", async () => {
  const s = await mount(pocs(), "other.md", { width: 120, height: 30 })
  await keys(s, "tab", "/", "type:poc")
  await s.mockMouse.click(100, 10) // inside the document
  await s.renderOnce()
  await keys(s, "tab") // panel again
  const f = await keys(s, "j") // moves the cursor instead of typing
  expect(f).toMatch(/\/ poc\s+3/)
  expect(f).not.toContain("▏")
  expect(f).not.toContain("/ pocj")
})

test("sidebar cursor stays on its file after r rescans a changed tree", async () => {
  const root = tmp({ "b.md": "# b", "c.md": "# c" })
  const s = await mount(root, "c.md")
  await keys(s, "tab")
  writeFileSync(join(root, "a.md"), "# a")
  await keys(s, "r")
  expect(onBg(s)[0]).toMatch(/^\s+●?\s*c\s*$/)
})

test("sidebar j opens the file only after the cursor settles", async () => {
  const s = await mount(tmp({ "a.md": "# alpha doc", "b.md": "# bravo doc", "c.md": "# charlie doc" }), "a.md")
  await keys(s, "tab")
  s.mockInput.pressKey("j")
  await sleep(5) // well inside OPEN_DELAY
  await s.renderOnce()
  await s.renderOnce()
  expect(s.captureCharFrame()).toContain("alpha doc")
  await waitFrame(s, (f) => f.includes("bravo doc"))
})

test("files over 5 MB are refused with a message", async () => {
  const s = await mount(tmp({ "big.md": "x".repeat(6 * 1024 * 1024) }), "big.md")
  expect(await keys(s)).toMatch(/too large/i)
})

test("read errors are shown as an error, not as a fake document", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "missing.md")
  const f = await keys(s, "2")
  expect(f).toContain("Could not open missing.md")
  expect(f).toContain("no headings")
  expect(f).toMatch(/ENOENT|no such file/i)
})
test("outline cursor is clamped after reload shrinks the heading list", async () => {
  const root = tmp({ "a.md": sections(6) })
  const s = await mount(root, "a.md")
  await keys(s, "2", "G")
  writeFileSync(join(root, "a.md"), sections(2))
  await keys(s, "r")
  expect(onBg(s)[0]).toContain("Section 2")
})

test("outline with no headings never selects row -1", async () => {
  const s = await mount(tmp({ "a.md": "plain\n" }), "a.md")
  await keys(s, "2", "j")
  writeFileSync(join(dirs[0]!, "a.md"), sections(2))
  await keys(s, "r")
  expect(onBg(s)[0]).toContain("Section 1")
})

test("switching files shows the new content in the same frame", async () => {
  const s = await mount(tmp({ "alpha.md": "alpha body text", "bravo.md": "bravo body text" }), "alpha.md")
  await keys(s, "tab")
  s.mockInput.pressKey("j")
  s.mockInput.pressEnter()
  // the first frame naming bravo must already show its content
  await waitFrame(s, (f) => f.split("\n")[0]!.includes("bravo"))
  expect(s.captureCharFrame()).toContain("bravo body text")
})

test("live reload survives an atomic (rename) save", async () => {
  const root = tmp({ "a.md": "# first version" })
  const s = await mount(root, "a.md")
  for (const v of ["second", "third"]) {
    writeFileSync(join(root, ".a.md.tmp"), `# ${v} version`)
    renameSync(join(root, ".a.md.tmp"), join(root, "a.md"))
    await waitFrame(s, (f) => f.includes(`${v} version`))
  }
})

test("resize keeps the reading position", async () => {
  const s = await mount(tmp({ "a.md": sections(8, "lorem ipsum dolor sit amet ".repeat(5)) }), "a.md")
  await keys(s, "]", "]", "]", "]", "]")
  const before = await keys(s)
  expect(before).toMatch(/Section 6/)
  s.resize(70, 30)
  const after = await keys(s)
  expect(after.split("\n").slice(0, 12).join("\n")).toContain("Section 6")
})

test("clicking the popup backdrop closes it", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md")
  expect(await openHelp(s)).toContain("Keybindings")
  await s.mockMouse.click(0, 0)
  expect(await keys(s)).not.toContain("Keybindings")
})

test("a theme from config: a family name opens its dark theme; an unknown name says so once and falls back to brothy", async () => {
  const d = tmp({ "a.md": "# a" })
  setup = quietAct(await testRender(<App root={d} initialFile={join(d, "a.md")} themeName="one" />, W120))
  await setup.renderOnce()
  expect(await openHelp(setup)).toMatch(/brothy v\d+\.\d+\.\d+ · one-dark/)
  setup.renderer.destroy()
  setup = quietAct(await testRender(<App root={d} initialFile={join(d, "a.md")} themeName="nope" />, W120))
  await setup.renderOnce()
  expect(await keys(setup)).toContain(`unknown theme "nope" in config`)
  expect(await openHelp(setup)).toMatch(/brothy v\d+\.\d+\.\d+ · brothy\b/)
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 120, height: 24 })
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 120, height: 30 })
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 120, height: 24 })
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

/** The background of the specimen the board's cursor frames (`▐ Aa ●●● ▌`): the candidate's. */
const cursorBg = (s: Setup) => {
  const row = s.captureSpans().lines.find((l) => l.spans.some((sp) => sp.text === "▐"))!.spans
  return hex(row.slice(row.findIndex((sp) => sp.text === "▐")).find((sp) => sp.text === "Aa")!.bg)
}

test("theme picker: a header, one row per family with both specimens, typing filters (j k g G included), ← → tab S-tab move the cursor across", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 80, height: 24 })
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 80, height: 24 })
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 80, height: 24 })
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 80, height: 24 })
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 120, height: 34 })
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
  const n = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 99, height: 34 })
  expect(await keys(n, "t")).not.toContain("Simmering notes")
})

test("theme picker scrolls inside a short terminal, keeping the highlight in view; the hint row stays", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 60, height: 14 })
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 120, height: 34 })
  const f = await keys(s, "t", "tab", "type:synth")
  expect(f).toMatch(/dark\s+light\s+│\s+synthwave84\s+text \d+\.\d:1/)
  expect(f).toMatch(/synthwave84 ▐ Aa ●●● ▌ {3}light {7}│/) // the cursor on its only theme, light struck through
  const chip = () => s.captureSpans().lines.flatMap((l) => l.spans).find((sp) => sp.text === "dark" || sp.text === "light")!
  const t = themeByName("brothy")
  expect(chip()).toMatchObject({ text: "dark" })
  expect(hex(chip().fg)).toBe(t.primary) // dark is the active chip
  const struck = s.captureSpans().lines.flatMap((l) => l.spans).find((sp) => sp.text.includes(" light "))!
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
  const drawn = (s: Setup) => spansOf(s).filter((sp) => hex(sp.fg) === sub && sp.text.trim()).map((sp) => sp.text.trim())
  const decorative = /^[›\/▸▾─━│]+$/
  const s = await mount(tmp({ "a.md": "---\ntitle: A\ntags: [x, y]\nauthor: me\n---\n# a\n\n[b](dir/b.md) [gone](missing.md)\n", "dir/b.md": "# b", "dir/c.md": "# c" }), "a.md")
  const seen = [...drawn(s)]
  for (const k of ["2", "3", "1"]) seen.push(...drawn(await (keys(s, k).then(() => s))))
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
  const s = await mount(tmp({ "a.md": "first line\n" }), "a.md", { width: 80, height: 24 })
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
  const s = await mount(tmp({ "a.md": "# alpha", "b.md": "# bravo" }), "a.md", { width: 80, height: 24 })
  expect(panelShown(await keys(s))).toBe(false)
  expect(panelShown(await keys(s, "tab"))).toBe(true)
  const g = await keys(s, "j", "enter")
  expect(panelShown(g)).toBe(false)
  expect(g).toContain("bravo")
  expect(panelShown(await keys(s, "C-b"))).toBe(true)
  expect(panelShown(await keys(s, "esc"))).toBe(false)
})
test("the document wraps at an 80-column measure, centered", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(40) }), "a.md", { width: 200, height: 30 })
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 100, height: 50 })
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
  setup?.renderer.destroy()
  const again = await mount(root, "a.md")
  expect(await keys(again)).toMatch(/min read/) // Info shown, unfocused
  await keys(again, "C-b")
  expect(savedConfig().sidebar).toEqual({ view: "info", hidden: true })
  setup?.renderer.destroy()
  expect(panelShown(await keys(await mount(root, "a.md")))).toBe(false)
})
test("legacy folds pick the view; all folded means hidden", async () => {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), '{"folds":{"files":false,"outline":false,"info":true}}')
  expect(await keys(await mount(tmp({ "a.md": "# A\n" }), "a.md"))).toMatch(/min read/)
  setup?.renderer.destroy()
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
  const s = await mount(d, "a.md", { width: 100, height: 30 })
  const f = await keys(s)
  expect(f.replace(/\s+/g, " ")).toContain("scan stopped at 20k entries — some notes missing")
  expect(spansOf(s).some((sp) => sp.text.includes("scan") && hex(sp.fg) === "#f0a96b")).toBe(true) // brothy warning
})

test("a complete scan shows no truncation note", async () => {
  const s = await mount(tmp({ "a.md": "# A\n" }), "a.md")
  expect(await keys(s)).not.toContain("truncated")
})

/** Rows of the frame as colored spans, flattened. */
const spansOf = (s: Setup) => s.captureSpans().lines.flatMap((l) => l.spans)

test("panel tabs: superscript numbers in textMuted; the rule under the active tab is accent only while the panel has focus", async () => {
  const t = themeByName("brothy")
  const s = await mount(tmp({ "a.md": "# A\n" }), "a.md", { width: 120, height: 30 })
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
  const SECONDARY = "#f2c65a" // brothy keyword color
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(25)) {
    await s.renderOnce()
    if (spansOf(s).some((sp) => sp.text.includes("const") && hex(sp.fg) === SECONDARY)) break
  }
  expect(spansOf(s).some((sp) => sp.text.includes("const") && hex(sp.fg) === SECONDARY)).toBe(true)
  const after = await keys(s)
  expect(after.split("\n").length).toBe(before.split("\n").length)
  expect(after.replace(/\s+$/gm, "")).toBe(before.replace(/\s+$/gm, ""))
})

// ------------------------------------------------------------- zen mode

/** 1-based zen top line of an `items` fixture with Typewriter off: the first body row shows `item N`. */
const zenAt = (frame: string) => Number(/\bitem (\d+)/.exec(frame.split("\n")[2]!)?.[1]) + 1
/** Lowest `item N` on screen. */
const firstItem = (frame: string) => Math.min(...[...frame.matchAll(/\bitem (\d+)/g)].map((m) => Number(m[1])))

/** Write a `zen` section into the test config before mounting. */
function zenConfig(zen: Record<string, unknown>) {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), JSON.stringify({ zen }))
}
const savedConfig = () => JSON.parse(readFileSync(join(cfgDir, "brothy", "config.json"), "utf8"))
/** Widest text run in the rows that contain `lorem`. */
const loremWidth = (frame: string) =>
  Math.max(
    ...frame
      .split("\n")
      .filter((l) => l.includes("lorem"))
      .map((r) => r.trimEnd().length - r.search(/lorem|ipsum|dolor/)),
  )

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
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(40) }), "a.md", { width: 200, height: 30 })
  const f = await keys(s, "z")
  expect(loremWidth(f)).toBeLessThanOrEqual(72)
  expect(loremWidth(f)).toBeGreaterThan(60)
  const below = f.split("\n").find((l) => l.includes("lorem"))!
  const left = below.search(/[a-z]/)
  expect(Math.abs(left - (200 - left - 72))).toBeLessThanOrEqual(2)
})

test("< and > change the zen measure by 4 and save it at once", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(40) }), "a.md", { width: 200, height: 30 })
  const f = await keys(s, "z", ">", ">")
  expect(f).toContain("measure 80")
  expect(savedConfig().zen.measure).toBe(80)
  expect(loremWidth(f)).toBeGreaterThan(72)
})

test("a measure wider than the terminal is clamped", async () => {
  zenConfig({ measure: 100 })
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(40) }), "a.md", { width: 64, height: 20 })
  const f = await keys(s, "z")
  expect(loremWidth(f)).toBeLessThanOrEqual(58)
  for (const r of f.split("\n")) expect(r.trimEnd().length).toBeLessThanOrEqual(64)
})

test("> past 100 reaches full measure in zen, < steps back; saved", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(80) }), "a.md", { width: 160, height: 30 })
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

test("w toggles full width in the normal view and persists it", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(80) }), "a.md", { width: 160, height: 30 })
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
  const s = await mount(tmp({ "a.md": "# Title\n\n## Sub\n\nbody" }), "a.md", { width: 120, height: 30 })
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

/** Background alpha of the first span containing `text` (0 = unpainted). */
function bgAlpha(s: Setup, text: string): number {
  const span = s.captureSpans().lines.flatMap((l) => l.spans).find((x) => x.text.includes(text))
  expect(span).toBeDefined()
  return span!.bg.a
}

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
  const s = await mount(tmp({ "a.md": doc }), "a.md", { width: 160, height: 30 })
  await keys(s, "/", "type:needle", "enter")
  await keys(s, "n")
  const f = await keys(s, "n")
  expect(f).toMatch(/\b3\/40\b/)
  await keys(s, "w") // re-wraps at full width; line numbers all change
  expect(await keys(s, "n")).toMatch(/\b4\/40\b/)
})

test("w in zen does nothing: no toggle, no save, no flash", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(80) }), "a.md", { width: 160, height: 30 })
  await keys(s, "z")
  const f = await keys(s, "w")
  expect(f).not.toContain("full width")
  expect(existsSync(join(cfgDir, "brothy", "config.json")) && savedConfig().wide).toBeFalsy()
  expect(await keys(s, "esc")).not.toContain("wide") // nothing toggled underneath
})

test("wide is loaded from the config on startup", async () => {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), JSON.stringify({ wide: true }))
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(80) }), "a.md", { width: 160, height: 30 })
  expect(loremWidth(await keys(s))).toBeGreaterThan(100)
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
  const s = await mount(root, "a.md", { width: 200, height: 30 })
  await keys(s, "z", ">", ">")
  setup?.renderer.destroy()
  const again = await mount(root, "a.md", { width: 200, height: 30 })
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
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 100, height: 70 })
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
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(200) }), "a.md", { width: 200, height: 30 })
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
  setup?.renderer.destroy()
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

/** A tight list: one rendered line per item. */
const items = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i}`).join("\n") + "\n"
/** Screen row of the typewriter reading line at 100x30: 2 chrome rows + floor(26 / 2). */
const READING_ROW = 15

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

/** fg of the first document span (below the zen top line) containing `text`. */
const docFg = (s: Setup, text: string) =>
  hex(
    s
      .captureSpans()
      .lines.slice(2)
      .flatMap((l) => l.spans)
      .find((sp) => sp.text.includes(text))!.fg,
  )

test("spotlight dims every section but the current one", async () => {
  const s = await mount(
    tmp({ "a.md": "## One\n\nalpha\n\n## Two\n\nbravo\n\n```\nsnippet\n```\n\n## Three\n\ncharlie\n" }),
    "a.md",
  )
  await keys(s, "z")
  const bright = docFg(s, "alpha")
  expect(docFg(s, "bravo")).toBe(mix(bright!, "#181714", 0.6)) // brothy background
  await keys(s, "]")
  expect(docFg(s, "bravo")).toBe(bright)
  expect(docFg(s, "alpha")).not.toBe(bright)
  // code-block background (the theme's backgroundElement) is bright in its section, dimmed outside it
  const codeBg = () => hex(spansOf(s).find((sp) => sp.text.includes("snippet"))!.bg)
  const codeBright = codeBg()
  await keys(s, "]")
  expect(codeBg()).not.toBe(codeBright)
  expect(codeBg()).toBe(mix(codeBright!, "#181714", 0.6))
})

test("spotlight off leaves every section bright", async () => {
  zenConfig({ spotlight: false })
  const s = await mount(tmp({ "a.md": "## One\n\nalpha\n\n## Two\n\nbravo\n" }), "a.md")
  await keys(s, "z")
  expect(docFg(s, "bravo")).toBe(docFg(s, "alpha"))
})

const parts = (n: number) => Array.from({ length: n }, (_, i) => `## Part ${i + 1}\n\nbody ${i + 1}\n`).join("\n")

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

test("the drawer dims the document (scrim); the top row stays bright", async () => {
  const s = await mount(tmp({ "a.md": "lorem ipsum dolor ".repeat(60) }), "a.md", { width: 80, height: 24 })
  await keys(s)
  const loremFg = () => hex(spansOf(s).find((sp) => sp.text.includes("lorem"))!.fg)
  const row0 = () => s.captureSpans().lines[0]!.spans.map((sp) => hex(sp.fg))
  const bright = loremFg()!
  const top = row0()
  await keys(s, "tab")
  expect(loremFg()).toBe(mix(bright, "#181714", 0.62))
  expect(row0()).toEqual(top)
})

test("the drawer is raised and has a ▏ edge; a click on the scrim closes it", async () => {
  const s = await mount(tmp({ "a.md": "# alpha" }), "a.md", { width: 80, height: 24 })
  const f = await keys(s, "tab")
  expect(f.split("\n")[5]![36]).toBe("▏") // DW = round(80 × 0.45) = 36
  expect(s.captureSpans().lines[5]!.spans.some((sp) => hex(sp.bg) === "#24211d")).toBe(true) // backgroundElement
  await s.mockMouse.click(70, 10)
  expect(panelShown(await keys(s))).toBe(false)
})

test("60×14 still opens the drawer with the compact strip", async () => {
  const s = await mount(tmp({ "a.md": "# alpha" }), "a.md", { width: 60, height: 14 })
  expect(await keys(s, "tab")).toContain("¹Files  ²Outline  ³Info")
})

test("crossing 100 columns: a focused panel becomes an open drawer and comes back inline, focused", async () => {
  const s = await mount(tmp({ "a.md": "# alpha", "b.md": "# bravo" }), "a.md", { width: 120, height: 32 })
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
  const s = await mount(tmp({ "a.md": "# alpha" }), "a.md", { width: 120, height: 32 })
  expect(panelShown(await keys(s))).toBe(true)
  s.resize(80, 24)
  expect(panelShown(await keys(s))).toBe(false)
})

const vault = () =>
  tmp({
    "Readme.md": "# readme",
    "Journal/day one.md": "# one",
    "Journal/day two.md": "# two",
    "Journal/day three.md": "# three",
    "Work/Projects/Soup Base Stock.md": "# simmer",
    "Work/Projects/Soup Garnish.md": "# garnish",
  })
const STOCK = "Work/Projects/Soup Base Stock.md"

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
  expect(hex(read.fg)).toBe(mix("#f3efe7", "#181714", 0.35)) // brothy text, mixed 35% toward the background
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

const infoNote = "---\ntitle: Calm\ntags:\n  - focus\n  - reading\n---\nSee [[b]] and [[nowhere]] and [[c]].\n\n# H\n\n- [x] one\n- [ ] two\n"

test("Info shows properties with tag chips, resolved and unresolved links, and stats", async () => {
  const s = await mount(tmp({ "a.md": infoNote, "b.md": "# bee", "c.md": "# sea" }), "a.md")
  const f = await keys(s, "3")
  for (const x of ["title", "Calm", "#focus", "#reading", "Links", "→ b", "→ nowhere?", "1 heading · 1/2 tasks"]) expect(f).toContain(x)
  expect(f).toMatch(/\d+ words · \d+ min read/)
  expect(hex(spansOf(s).find((sp) => sp.text.includes("#focus"))!.fg)).toBe("#f2c65a") // secondary
  // the document also shows `[[nowhere]]`, so look only at the panel's link row
  const linkRow = s.captureSpans().lines.find((l) => l.spans.map((sp) => sp.text).join("").includes("→ nowhere"))!
  expect(linkRow.spans.some((sp) => sp.text.includes("nowhere") && hex(sp.fg) === "#aaa39a")).toBe(true) // textMuted
})

test("⏎ on a link opens it and focuses the document; j moves between links", async () => {
  const root = tmp({ "a.md": infoNote, "b.md": "# bee", "c.md": "# sea" })
  const s = await mount(root, "a.md")
  expect(await keys(s, "3", "enter")).toContain("bee")
  expect(onBg(s)).toEqual([])
  setup?.renderer.destroy()
  const again = await mount(root, "a.md")
  expect(await keys(again, "3", "j", "j", "enter")).toContain("sea")
})

test("⏎ on an unresolved link shows a toast and keeps Info focused", async () => {
  const s = await mount(tmp({ "a.md": infoNote, "b.md": "# bee", "c.md": "# sea" }), "a.md")
  const f = await keys(s, "3", "j", "enter")
  expect(f).toContain("no note named “nowhere”")
  expect(onBg(s)[0]).toContain("nowhere") // the selected row still holds the focus bar
})

const tallInfo = "---\n" + Array.from({ length: 8 }, (_, i) => `prop${i}: value${i}`).join("\n") + "\n---\nSee [[b]] and [[c]].\n\n# H\n\nword\n"
const tallFiles = { "a.md": tallInfo, "b.md": "# bee", "c.md": "# sea" }

test("Info with links: j/k at the first and last link scroll the rest of the list into view", async () => {
  const s = await mount(tmp(tallFiles), "a.md", { width: 80, height: 16 })
  const bottom = await keys(s, "3", "G", "j", "j", "j", "j")
  expect(bottom).toContain("min read") // the stat lines below the last link
  const top = await keys(s, "g", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k")
  expect(top).toContain("prop0") // the properties above the first link
})

test("Info: wheel scrolling sticks until the cursor moves", async () => {
  const s = await mount(tmp(tallFiles), "a.md", { width: 80, height: 16 })
  await keys(s, "3")
  expect(await keys(s)).toContain("prop0")
  for (let i = 0; i < 5; i++) await s.mockMouse.scroll(5, 8, "down")
  await s.renderOnce()
  const f = await keys(s)
  expect(f).not.toContain("prop0")
  expect(f).toContain("min read")
})

test("a click on an Info link row focuses the panel; an unresolved one only toasts", async () => {
  const s = await mount(tmp({ ...tallFiles, "a.md": tallInfo.replace("[[c]]", "[[nowhere]]") }), "a.md", { width: 100, height: 30 })
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

test("hints appear after tab and are gone after HINT_HOLD and the fade", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  expect((await keys(s, "tab")).split("\n")[HINT_ROW]).toContain("tab document")
  setSystemTime(PAST_HINTS())
  try {
    expect((await keys(s, "k")).split("\n")[HINT_ROW]!.trim()).toBe("") // k at the top: a no-op that renders
  } finally {
    setSystemTime()
  }
})

test("? ? at 120 columns: five chip groups in two columns, Global and Panel left; j scrolls both", async () => {
  const s = await mount(tmp({ "a.md": "# A\n" }), "a.md", { width: 120, height: 30 })
  const f = await openHelp(s)
  const rows = f.split("\n")
  const chipRow = rows.find((r) => r.includes(" Global "))!
  expect(chipRow).toContain(" Document ")
  expect(chipRow.indexOf("Global")).toBeLessThan(chipRow.indexOf("Document"))
  expect(f).toMatch(/j\/k scroll \d+\/\d+/)
  const top = rows.findIndex((r) => r.includes("1 2 3"))
  const after = (await keys(s, "j")).split("\n")
  expect(after[top]).not.toContain("1 2 3")
  expect(after[top - 1]).toContain("1 2 3")
  expect(after.join("\n")).toContain("Keybindings")
  expect(after.some((r) => /  AI  /.test(r))).toBe(true)
  expect(after.join("\n")).toContain("ask: a ? query finds the section")
  const end = (await keys(s, "G")).split("\n")
  const panel = end.findIndex((r) => r.includes(" Panel "))
  expect(panel).toBeGreaterThan(0)
  expect(end[panel]!.indexOf("Panel")).toBe(chipRow.indexOf("Global")) // left column
})

test("? ? below 100 columns: one 70-column sheet with the five chips in order", async () => {
  const s = await mount(tmp({ "a.md": "# A\n" }), "a.md", { width: 90, height: 120 })
  const rows = (await openHelp(s)).split("\n")
  const at = (g: string) => rows.findIndex((r) => r.trim() === g)
  const order = ["Global", "Document", "Zen", "Panel", "AI"].map(at)
  expect(order.every((y) => y > 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(rows[at("Global")]).not.toContain("Document")
})

test("? shows the hints first; a second ? opens the Keybindings popup", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md")
  setSystemTime(PAST_HINTS()) // let the startup hints go
  try {
    const f = await keys(s, "?")
    expect(f).not.toContain("Keybindings")
    expect(f.split("\n")[HINT_ROW]).toContain("? keys")
    expect(await keys(s, "?")).toContain("Keybindings")
  } finally {
    setSystemTime()
  }
})

test("n without a query is an error toast in the error color; ok toasts don't replace it; esc dismisses it", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md")
  expect((await keys(s, "n")).split("\n")[HINT_ROW]).toContain("✗ nothing to find · / to search")
  expect(spansOf(s).some((sp) => sp.text.includes("✗") && hex(sp.fg) === "#ef7b63")).toBe(true)
  expect((await keys(s, "t", "enter")).split("\n")[HINT_ROW]).toContain("✗")
  expect((await keys(s, "esc")).split("\n")[HINT_ROW]).not.toContain("✗")
})

test("the search item stays on the top line after find closes", async () => {
  const s = await mount(tmp({ "a.md": numbered(200, [50, 60, 70]) }), "a.md")
  expect((await keys(s, "/", "type:needle", "enter")).split("\n")[0]).toMatch(/\/needle 1\/3\s*$/)
  expect((await keys(s, "n")).split("\n")[0]).toMatch(/\/needle 2\/3\s*$/)
})

test("a read error is also a toast", async () => {
  expect((await keys(await mount(tmp({ "a.md": "# a" }), "missing.md"))).split("\n")[HINT_ROW]).toMatch(/✗ .*(ENOENT|no such file)/i)
})

/** C0 (but newline), DEL and C1: nothing a hostile note or file name holds may reach the terminal raw. */
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/
const clean = (s: Setup) => {
  expect(s.captureCharFrame()).not.toMatch(CONTROL)
  for (const l of s.captureSpans().lines) for (const sp of l.spans) expect(sp.text).not.toMatch(CONTROL)
}

test("escape sequences in front matter, names and links never reach the screen", async () => {
  const root = tmp({
    "dir\x1b[41mBG/evil\x1b]0;PWNED\x07.md": "# evil\n",
    "a.md": '---\ntitle: "T\x1b[5mBLINK"\naliases: [\x1b[7mREV]\n---\nsee [aa](%1b]0;LNKPWN%07.md)\n',
  })
  const s = await mount(root, "a.md")
  await keys(s, "tab", "k", "l") // open the folder in Files
  expect(s.captureCharFrame()).toContain("T\ufffd[5mBLINK")
  expect(s.captureCharFrame()).toContain("evil\ufffd]0;PWNED")
  clean(s)
  await keys(s, "3") // Info: title and aliases
  expect(s.captureCharFrame()).toContain("\ufffd[7mREV")
  clean(s)
  await keys(s, "tab", "f", "a") // the %1b link: decoded, unresolved, toasted
  expect(s.captureCharFrame()).toContain("no note named “\ufffd]0;LNKPWN\ufffd.md”")
  clean(s)
  await keys(s, "C-p", "type:REV") // the alias in the switcher
  expect(s.captureCharFrame()).toContain("\ufffd[7mREV")
  clean(s)
})

test("a toast never carries a control character", async () => {
  // a long root, like macOS's /var/folders/…/T/: the toast must still show the name, not a path cut short
  const deep = "d".repeat(60)
  const s = await mount(join(tmp({ [`${deep}/a.md`]: "# a" }), deep), "gone\x1b]0;X\x07.md")
  expect(s.captureCharFrame().split("\n")[HINT_ROW]).toMatch(/✗ .*gone\ufffd]0;X\ufffd\.md/)
  clean(s)
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

// ------------------------------------------------------------- header (row 0)

/** 100x30: panel SW 27, text starts at column 1 + 27 + 1 + 2 = 31 and is 66 wide. */
const TEXT_L = 31
const TEXT_R = 97

/** Row 0 with the (astral, two UTF-16 units) logo swapped for one unit, so string indexes equal columns. */
const head = (f: string) => f.split("\n")[0]!.replace("󰘗", "L")

/** fg of the first span on row 0 containing `text`. */
const row0Fg = (s: Setup, text: string) => hex(s.captureSpans().lines[0]!.spans.find((sp) => sp.text.includes(text))!.fg)

test("󰘗 sits at column 0 of row 0", async () => {
  const f = await keys(await mount(tmp({ "a.md": "# a" }), "a.md"))
  expect(Array.from(f.split("\n")[0]!)[0]).toBe("󰘗")
})

test("󰘗 is muted while watching, primary after a live reload, muted again after a second; absent when the file is gone", async () => {
  const root = tmp({ "a.md": "# one" })
  const s = await mount(root, "a.md")
  expect(row0Fg(s, "󰘗")).toBe("#aaa39a")
  writeFileSync(join(root, "a.md"), "# two")
  await waitFrame(s, (f) => f.includes("two"))
  expect(row0Fg(s, "󰘗")).toBe(PRIMARY)
  await waitFor(s, () => row0Fg(s, "󰘗") === "#aaa39a")
  rmSync(join(root, "a.md"))
  await waitFrame(s, (f) => Array.from(f.split("\n")[0]!)[0] !== "󰘗")
})

test("a deep folder is shrunk first / … / last over the panel; a short one is shown in full", async () => {
  const deep = "alpha/bravo/charlie/delta/echo"
  const s = await mount(tmp({ [deep + "/n.md"]: "# n", "x/y/m.md": "# m" }), deep + "/n.md", { width: 120, height: 32 })
  expect((await keys(s)).split("\n")[0]).toMatch(/^󰘗 alpha \/ … \/ echo\s/)
  const t = await mount(tmp({ "x/y/m.md": "# m" }), "x/y/m.md", { width: 120, height: 32 })
  expect((await keys(t)).split("\n")[0]).toMatch(/^󰘗 x \/ y\s/)
})

test("title and section start at the text's left edge; the search item ends at its right edge", async () => {
  const s = await mount(tmp({ "a.md": "# a\n\n" + "## Sec\n\nneedle\n\n".repeat(30) }), "a.md")
  const row = head(await keys(s, "/", "type:needle", "enter", "n", "n", "n"))
  expect(row.indexOf("a › Sec")).toBe(TEXT_L)
  expect(row.slice(0, TEXT_R).trimEnd()).toMatch(/\/needle 4\/30$/)
  expect(row.slice(TEXT_R).trim()).toBe("")
})

test("Source's flag ends at the text's right edge, not the terminal's", async () => {
  const row = head(await keys(await mount(tmp({ "a.md": "# a" }), "a.md"), "s"))
  expect(row.slice(0, TEXT_R).trimEnd()).toMatch(/source$/)
  expect(row.slice(TEXT_R).trim()).toBe("")
})

test("the title is dimmed while the note's own heading is on screen, and bold again after scrolling past it", async () => {
  const s = await mount(tmp({ "calm.md": "---\ntitle: Calm\n---\n# Calm\n\n" + "text\n\n".repeat(80) }), "calm.md")
  await keys(s)
  expect(row0Fg(s, "Calm")).toBe("#aaa39a")
  await keys(s, "space", "space", "space")
  expect(row0Fg(s, "Calm")).toBe("#f3efe7")
})

test("the gap row carries a faint rule over the text column only", async () => {
  const f = (await keys(await mount(tmp({ "a.md": "# a" }), "a.md"))).split("\n")[1]!
  expect(f.indexOf("─")).toBe(TEXT_L)
  expect(f.trim()).toBe("─".repeat(66))
})

test("no panel (^b): everything inline, the folder leads the title", async () => {
  const s = await mount(tmp({ "notes/a.md": "# a\n\n" + "## Sec\n\ntext\n\n".repeat(20) }), "notes/a.md")
  const row = head(await keys(s, "C-b", "]"))
  expect(row).toMatch(/^L +notes \/ a › Sec/)
  expect(row.indexOf("notes")).toBe(10) // the text edge: 1 + (98 - 80) / 2
})

test("drawer width (80×24): 󰘗 and the folder lead the title; 60×14 fits without overflow", async () => {
  const short = { "notes/a.md": "# t\n\n## A long section heading\n\n" + "text\n\n".repeat(40) }
  const wide = head(await keys(await mount(tmp(short), "notes/a.md", { width: 80, height: 24 }), "]"))
  expect(wide).toMatch(/^L +notes \/ a › t › A long section heading/)
  setup?.renderer.destroy()
  const body = { "notes/a-fairly-long-note-title-for-a-narrow-screen-so-it-must-be-cut.md": "# t\n\n## A long section heading\n\n" + "text\n\n".repeat(40) }
  const key = Object.keys(body)[0]!
  const f = head(await keys(await mount(tmp(body), key, { width: 60, height: 14 }), "]"))
  expect(f.length).toBeLessThanOrEqual(60)
  expect(f[0]).toBe("L")
  expect(f).toContain("…")
})

test("zen: 󰘗 rides the top line and fades with it", async () => {
  const s = await mount(tmp({ "a.md": sections(3) }), "a.md")
  expect(Array.from((await keys(s, "z")).split("\n")[0]!)[0]).toBe("󰘗")
  await waitFrame(s, (f) => f.split("\n")[0]!.trim() === "", 5000)
})

const linkNote = "# A\n\nsee [[b]] and [[c|Sea]] and [[nope]] and [[b#Part two]]\n"
const longB = "# Bee\n\n" + Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n\n") + "\n\n## Part two\n\nend\n"
const linkVault = () => tmp({ "a.md": linkNote, "b.md": longB, "c.md": "# Sea note\n" })

test("f labels the links on screen; typing a label opens the note", async () => {
  const s = await mount(linkVault(), "a.md")
  expect(await keys(s, "f")).toContain("see a and sea and dope and j › Part two")
  expect(onBg(s, "#f0a96b").join("")).toBe("asdj") // brothy warning fill under the four labels
  expect(await keys(s, "a")).toContain("Bee")
})

test("a heading link opens the note at that heading", async () => {
  const f = await keys(await mount(linkVault(), "a.md"), "f", "j")
  expect(f).toContain("Part two")
  expect(f).toContain("end")
  expect(f).not.toContain("see b")
  expect(f).not.toMatch(/\brow 1\b/)
})

test("an unresolved link only says so", async () => {
  const f = await keys(await mount(linkVault(), "a.md"), "f", "d")
  expect(f).toContain("no note named “nope”")
  expect(f).toContain("see b and Sea")
})

test("missing heading: the note opens at its remembered position with a toast", async () => {
  const root = tmp({ "a.md": "see [[b#Nowhere]]\n", "b.md": longB + "\nback to [[a]]\n" })
  const s = await mount(root, "a.md")
  const first = await keys(s, "f", "a")
  expect(first).toContain("Bee")
  expect(first).toContain("no heading “Nowhere”")
  await keys(s, "G") // b's bottom is now its remembered position
  expect(await keys(s, "f", "a")).toContain("see b › Nowhere") // back in a (only [[a]] is on screen)
  const again = await keys(s, "f", "a")
  expect(again).toContain("back to a")
  expect(again).not.toMatch(/\brow 1\b/)
  expect(again).toContain("no heading “Nowhere”")
})

test("esc or a non-label key cancels; f without links flashes", async () => {
  expect(await keys(await mount(linkVault(), "a.md"), "f", "esc")).toContain("see b and Sea")
  expect(await keys(await mount(linkVault(), "a.md"), "f", "x")).toContain("see b and Sea")
  expect(await keys(await mount(linkVault(), "c.md"), "f")).toContain("no links on screen")
})

test("Source and zen do not label", async () => {
  expect(await keys(await mount(linkVault(), "a.md"), "s", "f")).toContain("links: preview only")
  const z = await keys(await mount(linkVault(), "a.md"), "z", "f")
  expect(z).toContain("see b and Sea")
})

test("labels drop when the view moves", async () => {
  const root = tmp({ "a.md": "see [[b]]\n\n" + Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n"), "b.md": "# Bee\n" })
  const s = await mount(root, "a.md")
  await keys(s, "f")
  await s.mockMouse.scroll(70, 10, "down") // inside the document column
  const f = await keys(s, "a")
  expect(f).not.toContain("Bee")
})

test("labels gone stale (live reload) end label mode: the footer drops them and the next key acts", async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n")
  const root = tmp({ "a.md": "see [[b]]\n\n" + lines, "b.md": "# Bee\n" })
  const s = await mount(root, "a.md")
  expect(await keys(s, "f")).toContain("a–z follow")
  writeFileSync(join(root, "a.md"), "# changed\n\nsee [[b]]\n\n" + lines)
  await waitFrame(s, (f) => f.includes("changed") && !f.includes("a–z follow"))
  expect(await keys(s, "G")).toContain("line 79")
})

test("unresolved wikilinks are drawn muted in the document", async () => {
  const s = await mount(linkVault(), "a.md")
  const nope = s.captureSpans().lines.flatMap((l) => l.spans).find((sp) => sp.text.includes("nope"))!
  expect(hex(nope.fg)).toBe("#aaa39a") // brothy textMuted
})

test("the doc footer offers f links, and drops it first when narrow", async () => {
  const s = await mount(linkVault(), "a.md")
  const wide = (await keys(s)).split("\n")[HINT_ROW]!
  expect(wide).toContain("f links")
  expect(wide).toContain("? keys")
  const n = await mount(linkVault(), "a.md", { width: 70, height: 30 })
  const narrow = (await keys(n)).split("\n")[HINT_ROW]!
  expect(narrow).not.toContain("f links")
  expect(narrow).toContain("? keys")
})

test("Source, where f only says preview only, does not offer f links", async () => {
  const src = (await keys(await mount(linkVault(), "a.md"), "s")).split("\n")[HINT_ROW]!
  expect(src).toContain("? keys")
  expect(src).not.toContain("f links")
})

test("a single note inside a vault resolves links against the vault root", async () => {
  const v = tmp({ "Journal/a.md": "see [[Elsewhere/b]] and [[c]]\n", "Elsewhere/b.md": "# Bee\n", "c.md": "# Sea note\n" })
  mkdirSync(join(v, ".obsidian"))
  const s = await mount(join(v, "Journal"), "a.md")
  const b = s.captureSpans().lines.flatMap((l) => l.spans).find((sp) => sp.text === "b")!
  expect(hex(b.fg)).toBe("#89b4fa") // brothy info: resolved, not muted
  expect(await keys(s, "f", "s")).toContain("Sea note")
})

test("a note reached outside the opened folder names its vault folder in the top line, not ..", async () => {
  const v = tmp({ "Journal/a.md": "see [[Elsewhere/b]] and [[c]]\n", "Elsewhere/b.md": "# Bee\n", "c.md": "# Sea note\n" })
  mkdirSync(join(v, ".obsidian"))
  const s = await mount(join(v, "Journal"), "a.md")
  const top = (await keys(s, "f", "a")).split("\n")[0]!
  expect(top).toContain("Elsewhere")
  expect(top).not.toContain("..")
})

test("outside a vault, a single note's links resolve only within its folder", async () => {
  const v = tmp({ "Journal/a.md": "see [[c]]\n", "c.md": "# Sea note\n" })
  expect(await keys(await mount(join(v, "Journal"), "a.md"), "f", "a")).toContain("no note named “c”")
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

const filler = (n: number) => Array.from({ length: n }, (_, i) => `filler ${i}`).join("\n\n")

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

// ------------------------------------------------------------- history (H / L)

const histA = "# A\n\n" + Array.from({ length: 60 }, (_, i) => (i % 8 === 4 ? `row ${i} see [[b]]` : `row ${i}`)).join("\n\n") + "\n"
const histVault = () => tmp({ "a.md": histA, "b.md": longB, "c.md": "# Sea note\n", "d.md": "# Dee note\n" })
/** The document rows of a frame (no status, ghost or progress lines). */
const bodyRows = (f: string) => f.split("\n").slice(2, HINT_ROW).join("\n")

test("H goes back to the note a link left, at its top then; L goes forward again", async () => {
  const s = await mount(histVault(), "a.md")
  const inA = await keys(s, "d", "d")
  expect(inA).toContain("see b")
  expect(await keys(s, "f", "a")).toContain("Bee")
  const inB = await keys(s, "j", "j", "j")
  const back = await keys(s, "H")
  expect(bodyRows(back)).toBe(bodyRows(inA))
  expect(back.split("\n")[HINT_ROW]).toContain("back · a")
  const fwd = await keys(s, "L")
  expect(bodyRows(fwd)).toBe(bodyRows(inB))
  expect(fwd.split("\n")[HINT_ROW]).toContain("forward · b")
})

test("H and L at either end only say so", async () => {
  const s = await mount(histVault(), "a.md")
  expect((await keys(s, "H")).split("\n")[HINT_ROW]).toContain("no earlier note")
  expect((await keys(s, "L")).split("\n")[HINT_ROW]).toContain("no later note")
})

test("Files previews do not pile up: H skips the notes only previewed", async () => {
  const s = await mount(histVault(), "a.md")
  await keys(s, "tab")
  for (const title of ["Bee", "Sea note", "Dee note"]) {
    await keys(s, "j")
    await waitFrame(s, (f) => f.includes(title)) // previewed after OPEN_DELAY
  }
  expect(await keys(s, "tab")).toContain("Dee note")
  const back = await keys(s, "H")
  expect(back).toContain("row 0")
  expect(back).not.toContain("Sea note")
  expect((await keys(s, "L")).split("\n")[HINT_ROW]).toContain("forward · d")
})

test("a previewed note revisited with L under document focus stays in history", async () => {
  const s = await mount(histVault(), "a.md")
  await keys(s, "tab", "j")
  await waitFrame(s, (f) => f.includes("Bee")) // after OPEN_DELAY: b is only previewed
  await keys(s, "H", "tab") // back to a, then the document
  expect((await keys(s, "L")).split("\n")[HINT_ROW]).toContain("forward · b")
  await keys(s, "C-p", "type:dee")
  // the index is built on first use: enter before the hit is listed opens nothing
  await waitFrame(s, (f) => f.includes("Go to") && f.includes("Dee note"))
  await keys(s, "enter")
  // H must come after the switcher closed and the forward toast cleared
  await waitFrame(s, (f) => !f.includes("Go to") && f.includes("Dee note") && !f.split("\n")[HINT_ROW]!.includes("forward · b"), 6000)
  expect((await keys(s, "H")).split("\n")[HINT_ROW]).toContain("back · b")
}, 10_000) // the forward toast holds and fades for ~2.4 s

test("a note deleted since is dropped with a toast", async () => {
  const root = histVault()
  const s = await mount(root, "a.md")
  await keys(s, "d", "d", "f", "a")
  rmSync(join(root, "a.md"))
  const f = await keys(s, "H")
  expect(f).toContain("Bee")
  expect(f.split("\n")[HINT_ROW]).toContain("“a” is gone")
  expect((await keys(s, "H")).split("\n")[HINT_ROW]).toContain("no earlier note")
})

test("H works in zen and keeps zen on", async () => {
  const s = await mount(histVault(), "a.md")
  await keys(s, "f", "a", "z")
  const f = await keys(s, "H")
  expect(f).toContain("row 0")
  expect(panelShown(f)).toBe(false)
})

test("the doc footer offers H L history; help lists both keys", async () => {
  const s = await mount(histVault(), "a.md")
  expect((await keys(s)).split("\n")[HINT_ROW]).toContain("H L history")
  const help = await openHelp(s)
  expect(help).toContain("back to the previous note")
})

test("each history entry keeps its own top, not the note's latest one", async () => {
  const bLinks = "# Bee\n\nback to [[a]]\n\n" + Array.from({ length: 40 }, (_, i) => `bee ${i}`).join("\n\n") + "\n"
  const s = await mount(tmp({ "a.md": histA, "b.md": bLinks }), "a.md")
  const first = await keys(s, "d", "d")
  await keys(s, "f", "a", "g", "f", "a") // a → b → a
  expect(await keys(s, "G")).toContain("row 59")
  await keys(s, "H") // b
  expect(bodyRows(await keys(s, "H"))).toBe(bodyRows(first))
})

// ------------------------------------------------------------- open projects (o)

const projectsFile = () => join(cfgDir, "brothy", "projects.json")
function writeProjects(projects: { root: string; lastNote?: string | null; top?: number; at?: number }[]) {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(projectsFile(), JSON.stringify({ projects }))
}
const readProjects = (): { root: string; lastNote: string | null; top: number }[] => JSON.parse(readFileSync(projectsFile(), "utf8")).projects
const nameOf = (p: string) => p.split("/").pop()!

test("the start is recorded as a recent project; a single note records its folder", async () => {
  const a = tmp({ "a.md": "# Alpha\n", "b.md": "# Bee\n" })
  await mount(a, "b.md")
  expect(readProjects()[0]).toMatchObject({ root: a, lastNote: join(a, "b.md"), top: 0 })
})

test("o lists recent projects; ⏎ switches the tree, header and note, and records both", async () => {
  const a = tmp({ "a.md": "# Alpha note\n" })
  const b = tmp({ "README.md": "# Bravo readme\n", "sub/deep.md": "# Deep\n" })
  writeProjects([{ root: b, lastNote: null, top: 0, at: 1 }])
  const s = await mount(a)
  const f = await keys(s, "o")
  expect(f).toContain("Open")
  expect(f).toContain("Recent")
  expect(f).toContain(nameOf(b))
  const after = await keys(s, "enter")
  expect(after).toContain("Bravo readme")
  expect(after).not.toContain("Alpha note")
  expect(after.split("\n")[0]).toContain(nameOf(b))
  expect(after).toContain("sub") // b's folder in Files
  expect(readProjects().map((p) => p.root)).toEqual([b, a])
})

test("reopening a recent project restores its last note at its top", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const b = tmp({ "README.md": "# Bravo\n", "long.md": numbered(200, []) })
  writeProjects([{ root: b, lastNote: join(b, "long.md"), top: 40, at: 1 }])
  const s = await mount(a)
  expect(topLine(await keys(s, "o", "enter"))).toBe(41)
  // leaving b again records where it was left
  await keys(s, "j", "j", "o", "enter")
  expect(readProjects()[1]).toMatchObject({ root: b, lastNote: join(b, "long.md"), top: 42 })
})

test("switching clears history and the old note's watcher", async () => {
  const a = tmp({ "a.md": "# Alpha\n\n[[b]]\n", "b.md": "# Bee\n" })
  const b = tmp({ "c.md": "# Charlie\n" })
  writeProjects([{ root: b, at: 1 }])
  const s = await mount(a, "a.md")
  expect(await keys(s, "f", "a")).toContain("Bee")
  const f = await keys(s, "o", "enter")
  expect(f).toContain("Charlie")
  expect((await keys(s, "H")).split("\n")[HINT_ROW]).toContain("no earlier note")
  writeFileSync(join(a, "b.md"), "# Bee changed\n")
  await sleep(300)
  await s.renderOnce()
  expect(s.captureCharFrame()).not.toContain("reloaded")
})

test("a missing recent is muted, and ⏎ drops it with a toast", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const gone = join(a, "no-such-dir")
  writeProjects([{ root: gone, at: 1 }])
  const s = await mount(a)
  expect(await keys(s, "o")).toContain("missing")
  const f = await keys(s, "enter")
  expect(f).toContain("is gone")
  expect(f).toContain("No recent projects")
  expect(readProjects().map((p) => p.root)).not.toContain(gone)
})

test("a path query lists entries; tab completes; ⏎ on the folder itself opens it", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const b = tmp({ "notes/x.md": "# Xray\n", "skip.txt": "", "top.md": "# Top\n" })
  const s = await mount(a)
  let f = await keys(s, "o", `type:${b}/no`)
  expect(f).toContain("Path")
  expect(f).toContain("notes/")
  expect(f).not.toContain("skip.txt")
  f = await keys(s, "tab")
  expect(f).toContain(`${nameOf(b)}/notes/`)
  expect(f).toContain("this folder")
  f = await keys(s, "enter")
  expect(f).toContain("Xray")
  expect(f.split("\n")[0]).toContain("notes")
})

test("⏎ on a Markdown path opens it as a single note", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const b = tmp({ "one.md": "# One\n", "two.md": "# Two\n" })
  const s = await mount(a)
  const f = await keys(s, "o", `type:${b}/two`, "enter")
  expect(f).toContain("Two")
  expect(readProjects()[0]).toMatchObject({ root: b, lastNote: join(b, "two.md") })
})

test("esc closes the picker; help lists o", async () => {
  const s = await mount(tmp({ "a.md": "# Alpha\n" }))
  expect(await keys(s, "o")).toContain("Open")
  expect(await keys(s, "esc")).not.toContain("No recent projects")
  expect(await openHelp(s)).toContain("open a recent project")
})

test("a note opened by path inside a vault is recorded under the vault; reopening keeps that root", async () => {
  const a = tmp({ "a.md": "# Alpha\n" })
  const v = tmp({ ".obsidian/app.json": "{}", "sub/n.md": "# Nested\n", "top.md": "# Top\n" })
  const s = await mount(a)
  expect(await keys(s, "o", `type:${v}/sub/n`, "enter")).toContain("Nested")
  expect(readProjects()[0]).toMatchObject({ root: v, lastNote: join(v, "sub", "n.md") })
  // back to a, then reopen the vault from Recent: the vault is the workspace, the note restored
  await keys(s, "o", `type:${nameOf(a)}`, "enter")
  const f = await keys(s, "o", `type:${nameOf(v)}`, "enter")
  expect(f).toContain("Nested")
  expect(f).toContain("top") // the vault's Files tree
  expect(readProjects()[0]).toMatchObject({ root: v })
  expect(readProjects().filter((p) => p.root === v)).toHaveLength(1)
})

test("popups leave the footer hint row and progress line visible", async () => {
  const root = tmp({ "a.md": "# Alpha\n\nbody\n", "b.md": "# Beta\n" })
  for (const [width, height] of [[100, 30], [100, 20], [60, 14]] as const) {
    for (const k of [["t"], ["?"], ["C-p"], ["o"], ["/"]]) {
      const s = await mount(root, "a.md", { width, height })
      const f = await keys(s, ...k)
      const rows = f.split("\n")
      expect(rows[height - 2]!.trim(), `${k} at ${width}x${height}`).toMatch(/esc|open/) // the hint row, not popup rows
      s.renderer.destroy()
    }
  }
})

test("help title never wraps: the theme name goes first at 60x14", async () => {
  const s = await mount(tmp({ "a.md": "# Alpha\n" }), "a.md", { width: 60, height: 14 })
  await keys(s, "t", "type:catp", "tab", "enter") // catppuccin-light, the longest name
  const f = await openHelp(s)
  const rows = f.split("\n")
  expect(rows.filter((r) => r.includes("Keybindings")).length).toBe(1)
  expect(rows.findIndex((r) => r.includes("Keybindings"))).toBeGreaterThan(0)
  expect(rows[12]!).toContain("esc") // footer hint row stays
})

test("find rows show a match near the line end", async () => {
  const long = "word ".repeat(12) + "zebra"
  const s = await mount(tmp({ "a.md": `# T\n\n\`\`\`\n${long}\n\`\`\`\n` }), "a.md", { width: 80, height: 24 })
  const f = await keys(s, "/", "type:zebra")
  expect(f.split("\n").filter((r) => r.includes("zebra") && r.includes("…")).length).toBeGreaterThan(0)
})

test("too-small screen keeps the requirement and never wraps mid-word", async () => {
  for (const [width, height] of [[10, 3], [20, 5], [40, 10]] as const) {
    const s = await mount(tmp({ "a.md": "# Alpha\n" }), "a.md", { width, height })
    const text = s.captureCharFrame().split("\n").map((r) => r.trim()).filter(Boolean).join(" ")
    expect(text).toContain("60×14")
    expect(text).not.toMatch(/\bneed\b.*\bne\b/)
    s.renderer.destroy()
  }
})

/** Run `fn` with `process.exit` stubbed out; returns the codes it was called with. */
async function trapExit(fn: () => Promise<unknown>) {
  const exit = process.exit
  const codes: (number | undefined)[] = []
  process.exit = ((code?: number) => void codes.push(code)) as typeof process.exit
  try {
    await fn()
  } finally {
    process.exit = exit
  }
  return codes
}

test("C-c quits from any popup or mode the way q does: the position is recorded", async () => {
  for (const open of [[], ["?"], ["/"], ["t"], ["C-p"], ["o"], ["Z"], ["f"], ["tab", "/"]]) {
    const root = tmp({ "a.md": "see [[b]]\n\n" + numbered(200, []), "b.md": "# Bee\n" })
    const s = await mount(root, "a.md")
    await keys(s, "j", "j", ...open)
    expect(await trapExit(() => keys(s, "C-c"))).toEqual([0])
    expect(readProjects()[0]).toMatchObject({ root, lastNote: join(root, "a.md"), top: 2 })
  }
})

test("the renderer's end (a signal, the terminal closing) records the position; q records it once", async () => {
  const root = tmp({ "a.md": numbered(200, []) })
  let s = await mount(root, "a.md")
  await keys(s, "j", "j", "j")
  s.renderer.destroy() // what OpenTUI's exitSignals handler does
  expect(readProjects()[0]).toMatchObject({ root, top: 3 })
  // q records, then ends the renderer: that destroy must not write again
  s = await mount(root, "a.md")
  await keys(s, "j")
  let top: number | undefined
  s.renderer.prependListener("destroy", () => {
    top = readProjects()[0]?.top
    rmSync(projectsFile())
  })
  expect(await trapExit(() => keys(s, "q"))).toEqual([0])
  expect(top).toBe(1)
  expect(existsSync(projectsFile())).toBe(false)
})

// ------------------------------------------------------------- config and recents across instances

const configFile = () => join(cfgDir, "brothy", "config.json")
function writeConfig(cfg: unknown) {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(configFile(), typeof cfg === "string" ? cfg : JSON.stringify(cfg))
}
/** Sections whose paragraphs wrap differently at each measure. */
const wrapped = () => sections(12, "lorem ipsum dolor sit amet ".repeat(9).trim())
const firstDocRow = (f: string) => f.split("\n")[2]!

test("a recent project reopens at its section after a width change (w)", async () => {
  const a = tmp({ "a.md": wrapped() })
  const b = tmp({ "b.md": "# Bee\n" })
  writeProjects([{ root: b, lastNote: null, at: 1 }])
  const s = await mount(a, "a.md")
  expect(firstDocRow(await keys(s, "w", "]", "]", "]", "]", "]"))).toContain("Section 6")
  await keys(s, "o", "enter", "w") // to b, then back to the 80-column measure
  expect(readProjects().find((p) => p.root === a)).toHaveProperty("geo")
  expect(firstDocRow(await keys(s, "o", `type:${nameOf(a)}`, "enter"))).toContain("Section 6")
})

test("leaving a project from zen records the Preview position, moved in zen or not", async () => {
  writeConfig({ zen: { measure: "full", typewriter: false } })
  for (const moves of [["]", "]", "]", "]", "]", "z"], ["z", "]", "]", "]", "]", "]"]]) {
    const a = tmp({ "a.md": wrapped() })
    const b = tmp({ "b.md": "# Bee\n" })
    writeProjects([{ root: b, lastNote: null, at: 1 }])
    const s = await mount(a, "a.md")
    await keys(s, ...moves, "o", "enter", "z") // to b from zen, then out of zen
    expect(firstDocRow(await keys(s, "o", `type:${nameOf(a)}`, "enter")), moves.join(" ")).toContain("Section 6")
    s.renderer.destroy()
  }
})

test("a config.json that doesn't parse: saving toasts an error instead of claiming it", async () => {
  writeConfig("{ not json")
  const root = tmp({ "a.md": sections(2) })
  for (const k of [["w"], ["T"], ["C-b"], ["2"], ["t", "down", "enter"], ["z", "<"], ["z", "+"], ["Z", "j", "space", "enter"]]) {
    const s = await mount(root, "a.md")
    const f = await keys(s, ...k)
    expect(f.split("\n")[HINT_ROW], k.join(" ")).toContain("config.json not saved · it doesn't parse or can't be written")
    expect(f, k.join(" ")).not.toMatch(/full width|background|zen settings saved|theme ·|measure \d|wpm/)
    s.renderer.destroy()
  }
  expect(readFileSync(configFile(), "utf8")).toBe("{ not json")
})

test("saving writes only the changed field: another instance's sidebar and zen settings survive", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  writeConfig({ sidebar: { view: "files", hidden: true }, zen: { wpm: 300 } }) // another instance
  await keys(s, "2") // Outline: the view only
  expect(savedConfig().sidebar).toEqual({ view: "outline", hidden: true })
  await keys(s, "Z", "j", "space", "enter") // Spotlight off: that key only
  expect(savedConfig().zen).toEqual({ wpm: 300, spotlight: false })
  writeConfig({ ...savedConfig(), sidebar: { view: "info", hidden: true } })
  await keys(s, "<") // zen measure: that key only
  expect(Object.keys(savedConfig().zen).sort()).toEqual(["measure", "spotlight", "wpm"])
  expect(savedConfig().zen.wpm).toBe(300)
  expect(savedConfig().sidebar).toEqual({ view: "info", hidden: true })
})

test("dragging over the document copies the selection over OSC 52 and toasts", async () => {
  const s = await mount(tmp({ "a.md": "# Title\n\nhello copy world\n" }), "a.md")
  const copied: string[] = []
  s.renderer.copyToClipboardOSC52 = (text: string) => (copied.push(text), true)
  const rows = s.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes("hello copy world"))
  const x = rows[y]!.indexOf("hello")
  await s.mockMouse.drag(x, y, x + 10, y)
  await waitFrame(s, (f) => f.includes("copied"))
  expect(copied).toEqual(["hello copy"])
})

test("a without an ai block toasts AI off and opens Info", async () => {
  const d = tmp({ "a.md": "# A\n\nText.\n" })
  const s = await mount(d, "a.md", { width: 120, height: 30 })
  const f = await keys(s, "a")
  expect(f).toContain(`AI off · set "ai" in config.json`)
  expect(f).toContain("words")
  expect(f).not.toContain("TL;DR")
})

test("a on a note with only front matter and comments: nothing to summarize", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "---\ntitle: x\n---\n%%hidden%%\n" })
  const s = await mount(d, "a.md", { width: 120, height: 30 })
  expect(await keys(s, "a")).toContain("nothing to summarize")
})

test("Info shows a TL;DR block from the cache: none, fresh, outdated", async () => {
  aiConfig({ provider: "openrouter", model: "anthropic/claude-haiku-5-5" })
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  let s = await mount(d, "a.md", { width: 120, height: 30 })
  let f = await keys(s, "3")
  expect(f).toContain("TL;DR")
  expect(f).toContain("a to summarize")
  s.renderer.destroy()

  seedSummary(join(d, "a.md"), "About apples.", undefined, "anthropic/claude-haiku-5-5")
  s = await mount(d, "a.md", { width: 120, height: 30 })
  f = await keys(s, "3")
  expect(f).toContain("TL;DR · claude-haiku-5-5")
  expect(f).toContain("About apples.")
  s.renderer.destroy()

  seedSummary(join(d, "a.md"), "About apples.", "stale")
  s = await mount(d, "a.md", { width: 120, height: 30 })
  expect(await keys(s, "3")).toContain("TL;DR · outdated · a")
})

test("no TL;DR block when AI is off, even with a cached summary", async () => {
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "About apples.")
  const s = await mount(d, "a.md", { width: 120, height: 30 })
  expect(await keys(s, "3")).not.toContain("TL;DR")
})

test("the a summarize footer hint shows only when an ai block is configured", async () => {
  const d = tmp({ "a.md": "# A\n\nText.\n" })
  let s = await mount(d, "a.md", { width: 140, height: 30 })
  expect(await keys(s, "3")).not.toContain("summarize")
  s.renderer.destroy()
  aiConfig(OLLAMA)
  s = await mount(d, "a.md", { width: 140, height: 30 })
  expect(await keys(s, "3")).toContain("a summarize")
})

test("r re-reads the ai block: the a hint appears after adding and goes after removal", async () => {
  const d = tmp({ "a.md": "# A\n\nText.\n" })
  const s = await mount(d, "a.md", { width: 140, height: 30 })
  expect(await keys(s, "3")).not.toContain("a summarize")
  aiConfig(OLLAMA)
  expect(await keys(s, "r")).toContain("a summarize")
  writeFileSync(join(cfgDir, "brothy", "config.json"), "{}")
  expect(await keys(s, "r")).not.toContain("a summarize")
})

test("a in zen without an ai block: AI off", async () => {
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  const s = await mount(d, "a.md", { width: 120, height: 30 })
  expect(await keys(s, "z", "a")).toContain(`AI off · set "ai" in config.json`)
})

test("typing a into the Files filter filters, it doesn't summarize", async () => {
  const d = tmp({ "a.md": "# A\n", "b.md": "# B\n" })
  const s = await mount(d, "a.md", { width: 120, height: 30 })
  const f = await keys(s, "1", "/", "type:a")
  expect(f).not.toContain("AI off")
})

test("help lists a in the AI group, not under Global", async () => {
  const d = tmp({ "a.md": "# A\n" })
  const s = await mount(d, "a.md", { width: 120, height: 40 })
  const lines = (await openHelp(s)).split("\n")
  const at = lines.findIndex((l) => l.includes("summarize the note (Info tab)"))
  const ai = lines.findIndex((l) => /  AI  /.test(l))
  expect(ai).toBeGreaterThan(0)
  expect(at).toBe(ai + 1)
  expect(lines[at]!.slice(lines[ai]!.indexOf("AI"))).toStartWith("a ") // the key under the chip, whatever the left column holds
})

/** A fetch whose streams the test feeds: send(i, text), fail(i, message), end(i). */
function aiStub() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const calls: { url: string; body: { messages: { content: string }[] }; signal?: AbortSignal | null }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), signal: init.signal })
    const body = new ReadableStream<Uint8Array>({ start: (c) => void streams.push(c) })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }) as unknown as typeof fetch
  const enc = new TextEncoder()
  const data = (i: number, obj: unknown) => streams[i]!.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
  return {
    f,
    calls,
    send: (i: number, content: string) => data(i, { choices: [{ delta: { content } }] }),
    fail: (i: number, message: string) => data(i, { error: { message } }),
    end: (i: number) => {
      streams[i]!.enqueue(enc.encode("data: [DONE]\n\n"))
      streams[i]!.close()
    },
  }
}
const cacheFile = () => join(cacheDir, "brothy", "summaries.json")
const cached = () => (existsSync(cacheFile()) ? (JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, { summary: string }>) : {})
/** Open a note through the Files filter; the first esc clears the query the last open left there. */
const openNote = (s: Setup, name: string) => keys(s, "1", "/", "esc", "/", `type:${name}`, "enter")
const W120 = { width: 120, height: 30 }

test("a streams the summary into Info, then caches it; a second run shows it without a request", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "---\ntitle: A\n---\n# A\n\nSome text about apples.\n%%private%%\n" })
  const ai = aiStub()
  let s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  expect(ai.calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions")
  expect(ai.calls[0]!.body.messages[1]!.content).toBe("# A\n\nSome text about apples.")
  ai.send(0, "Apples are ")
  await waitFrame(s, (f) => f.includes("TL;DR · summarizing…") && f.includes("Apples are"))
  ai.send(0, "discussed.")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("TL;DR · llama3.2") && f.includes("Apples are discussed."))
  expect(Object.values(cached()).map((e) => e.summary)).toEqual(["Apples are discussed."])
  s.renderer.destroy()

  const again = aiStub()
  s = await mount(d, "a.md", W120, again.f)
  expect(await keys(s, "3")).toContain("Apples are discussed.")
  expect(again.calls.length).toBe(0)
})

test("regenerating hides the old summary until the first new token", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "Old summary.")
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  expect(await keys(s, "3")).toContain("Old summary.")
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  const f = await keys(s)
  expect(f).toContain("TL;DR · summarizing…")
  expect(f).not.toContain("Old summary.")
  ai.send(0, "Fresh one.")
  ai.end(0)
  await waitFrame(s, (fr) => fr.includes("TL;DR · llama3.2") && fr.includes("Fresh one."))
})

test("editing the note marks its summary outdated", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "About apples.")
  const s = await mount(d, "a.md", W120)
  expect(await keys(s, "3")).toContain("TL;DR · llama3.2")
  writeFileSync(join(d, "a.md"), "# A\n\nPears now.\n")
  await waitFrame(s, (f) => f.includes("TL;DR · outdated · a"), 4000)
})

test("a live reload mid-stream completes as outdated", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "About apples.")
  writeFileSync(join(d, "a.md"), "# A\n\nPears now.\n")
  await waitFrame(s, (f) => f.includes("Pears now."), 4000)
  ai.end(0)
  await waitFrame(s, (f) => f.includes("TL;DR · outdated · a") && f.includes("About apples."))
})

test("switching notes mid-stream caches the summary for the original note", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n", "b.md": "# B\n\nBananas.\n" })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  await openNote(s, "b")
  await waitFrame(s, (f) => f.includes("Bananas."))
  ai.send(0, "About apples.")
  ai.end(0)
  await waitFor(s, () => Object.keys(cached()).some((p) => p.endsWith("a.md")))
  expect(Object.keys(cached()).some((p) => p.endsWith("b.md"))).toBe(false)
  await openNote(s, "a")
  expect(await keys(s, "3")).toContain("About apples.")
})

test("a again mid-stream cancels: nothing cached, the previous summary shows again", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "Old summary.", "stale")
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "New partial")
  await waitFrame(s, (f) => f.includes("New partial"))
  const f = await keys(s, "a")
  expect(f).toContain("summary cancelled")
  await waitFrame(s, (fr) => fr.includes("Old summary.") && !fr.includes("New partial"))
  expect(Object.values(cached()).map((e) => e.summary)).toEqual(["Old summary."])
})

test("a 4th concurrent request is refused: AI busy", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nA.\n", "b.md": "# B\n\nB.\n", "c.md": "# C\n\nC.\n", "e.md": "# E\n\nE.\n" })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "a")
  for (const n of ["b", "c"]) {
    await openNote(s, n)
    await keys(s, "a")
  }
  await waitFor(s, () => ai.calls.length === 3)
  await openNote(s, "e")
  expect(await keys(s, "a")).toContain("AI busy · 3 requests running")
  expect(ai.calls.length).toBe(3)
})

test("a failure for a note that isn't current names it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "apples.md": "# A\n\nApples.\n", "b.md": "# B\n\nBananas.\n" })
  const ai = aiStub()
  const s = await mount(d, "apples.md", W120, ai.f)
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  await openNote(s, "b")
  ai.fail(0, "model overloaded")
  await waitFrame(s, (f) => f.includes("AI · apples: model overloaded"))
  expect(cached()).toEqual({})
})

test("a preset without its key env var toasts which one to set", async () => {
  aiConfig({ provider: "openrouter", model: "x/y" })
  const prev = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    const d = tmp({ "a.md": "# A\n\nApples.\n" })
    const ai = aiStub()
    const s = await mount(d, "a.md", W120, ai.f)
    expect(await keys(s, "a")).toContain("AI: set OPENROUTER_API_KEY")
    expect(ai.calls.length).toBe(0)
  } finally {
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev
  }
})

// ------------------------------------------------------------- ? in C-p: ask

const { ASK_PROMPT, RERANK_PROMPT } = await import("../src/ask")
/** Two notes; "Open a single file" sits below 40 filler paragraphs, so a jump there scrolls. */
const askVault = () =>
  tmp({
    "README.md": "# README\n\n## Quick start\n\nbrothy path opens it.\n",
    "getting-started.md": `# Getting started\n\nIntro.\n\n## Open a folder\n\nPass a folder path.\n\n${filler(40)}\n\n## Open a single file\n\nSee below.\n\nGive a single file path to brothy.\n`,
  })
const QUERIES = JSON.stringify({ queries: ["single file", "path", "cli"] })
/** C-p, `?<question>`, ⏎; call `i` of the stub replies `reply`. Resolves with the frame once Answers show. */
async function askIt(s: Setup, ai: ReturnType<typeof aiStub>, reply = QUERIES, i = 0, question = "how do I open one file") {
  await keys(s, "C-p", `type:?${question}`)
  await waitFrame(s, (f) => f.includes("⏎ ask"))
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === i + 1)
  ai.send(i, reply)
  ai.end(i)
  return waitFrame(s, (f) => f.includes("Answers"))
}

test("? in C-p: the title is Ask, the row says what leaves and where; too short asks for more", async () => {
  aiConfig(OLLAMA)
  const s = await mount(askVault(), "README.md", W120)
  let f = await keys(s, "C-p", "type:?ho")
  expect(f).toContain("Ask")
  expect(f).toContain("type a question")
  f = await keys(s, "type:w")
  expect(f).toContain("⏎ ask · only the question → localhost:11434")
  expect(f).not.toContain("Go to")
  await waitFrame(s, (fr) => fr.includes("2 notes")) // after the index build's "indexing n/m"
})

test("? never opens help while the switcher is open", async () => {
  const s = await mount(askVault(), "README.md", W120)
  const f = await keys(s, "C-p", "type:?")
  expect(f).toContain("Ask")
  expect(f).not.toContain("Global")
})

test("without an ai block the Ask row says AI off and ⏎ sends nothing", async () => {
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  let f = await keys(s, "C-p", "type:?how do I open one file")
  expect(f).toContain(`AI off · set "ai" in config.json`)
  f = await keys(s, "enter")
  expect(f).toContain(`AI off · set "ai" in config.json`)
  expect(ai.calls.length).toBe(0)
})

test("⏎ sends only the question; the answers are vault places with hits/all and the queries searched", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  expect(await keys(s)).toContain("asking…")
  const body = ai.calls[0]!.body
  expect(body.messages.map((m) => m.content)).toEqual([ASK_PROMPT, "how do I open one file"])
  expect(JSON.stringify(body)).not.toMatch(/brothy path|Give a single|README|getting-started/)
  ai.send(0, QUERIES)
  ai.end(0)
  const f = await waitFrame(s, (fr) => fr.includes("Answers"))
  // the list is narrower beside the peek pane: the note name keeps its quarter, cut with …
  for (const x of ["llama3.2", "getting-sta… › Open a single file", "2/3", "README › Quick start", "1/3", "↻ rerank with excerpts", "searched: single file · path · cli"]) expect(f).toContain(x)
  expect(existsSync(join(cacheDir, "brothy"))).toBe(false) // nothing on disk
})

test("editing the question aborts the request and goes back to idle; esc aborts too", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  const f = await keys(s, "backspace")
  expect(ai.calls[0]!.signal!.aborted).toBe(true)
  expect(f).toContain("⏎ ask")
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 2)
  expect(await keys(s, "esc")).not.toContain("Ask")
  expect(ai.calls[1]!.signal!.aborted).toBe(true)
})

test("a failed ask toasts and shows ✗ … · ⏎ asks again; ⏎ asks again", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.fail(0, "boom")
  await waitFrame(s, (f) => f.includes("✗ AI: boom · ⏎ asks again"))
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 2)
})

test("a reply without usable queries: AI: no usable answer", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "no json here")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("AI: no usable answer"))
})

test("an ask while 3 other AI requests run: AI busy, on the toast and the ask row; nothing is sent", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nA.\n", "b.md": "# B\n\nB.\n", "c.md": "# C\n\nC.\n" })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "a")
  for (const n of ["b", "c"]) {
    await openNote(s, n)
    await keys(s, "a")
  }
  await waitFor(s, () => ai.calls.length === 3)
  await keys(s, "C-p", "type:?how do I open one file")
  await waitFrame(s, (f) => f.includes("⏎ ask"))
  const f = await keys(s, "enter")
  expect(f).toContain("AI busy · 3 requests running · ⏎ asks again")
  await waitFrame(s, (fr) => fr.split("\n").filter((l) => l.includes("AI busy · 3 requests running")).length === 2) // toast + row
  expect(ai.calls.length).toBe(3)
})

test("asking the same question again reuses its queries without a request", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await askIt(s, ai)
  expect(await keys(s, "type:x", "backspace")).toContain("⏎ ask")
  expect(await keys(s, "enter")).toContain("Answers")
  expect(ai.calls.length).toBe(1)
})

test("excerpts are sent only from the rerank row; the model's order shows with its why, the rest under Other matches", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await askIt(s, ai)
  expect(ai.calls.length).toBe(1)
  await keys(s, "tab", "enter") // first answer → the rerank row
  await waitFor(s, () => ai.calls.length === 2)
  expect(await keys(s)).toContain("reranking…")
  const [sys, user] = ai.calls[1]!.body.messages.map((m) => m.content)
  expect(sys).toBe(RERANK_PROMPT)
  expect(user).toStartWith("Question: how do I open one file\n\nc1 · getting-started › Getting started › Open a single file\nSee below. Give a single file path to brothy.")
  ai.send(1, JSON.stringify({ answers: [{ id: "c1", why: "pass the file path" }, { id: "c7" }, { id: "c1", why: "dup" }] }))
  ai.end(1)
  const f = await waitFrame(s, (fr) => fr.includes("Other matches"))
  expect(f).toContain("pass the file path")
  expect(f).not.toContain("↻ rerank with excerpts")
  expect(f).not.toContain("dup")
})

test("a rerank with no known id: AI: no usable ranking, the local order stays", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await askIt(s, ai)
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  ai.send(1, JSON.stringify({ answers: [{ id: "c9" }] }))
  ai.end(1)
  const f = await waitFrame(s, (fr) => fr.includes("AI: no usable ranking"))
  expect(f).toContain("↻ rerank with excerpts")
  expect(f).not.toContain("Other matches")
})

test("a failed rerank toasts the error; the tier 0 answers stay", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await askIt(s, ai)
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  ai.fail(1, "boom")
  const f = await waitFrame(s, (fr) => fr.includes("AI: boom"))
  expect(f).toContain("↻ rerank with excerpts")
  expect(f).toContain("README › Quick start")
  expect(f).not.toContain("asks again")
})

test("the same rerank again is served from memory", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await askIt(s, ai)
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  ai.send(1, JSON.stringify({ answers: [{ id: "c1", why: "pass the file path" }] }))
  ai.end(1)
  await waitFrame(s, (fr) => fr.includes("Other matches"))
  await keys(s, "type:x", "backspace", "enter") // the question again: queries from memory
  await waitFrame(s, (fr) => fr.includes("↻ rerank with excerpts"))
  const f = await keys(s, "tab", "enter")
  expect(f).toContain("Other matches")
  expect(ai.calls.length).toBe(2)
})

test("⏎ on an answer opens the note at the first line holding its best query, with the find highlight", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "README.md", W120, ai.f)
  await askIt(s, ai)
  const f = await keys(s, "enter") // getting-started › Open a single file (best query: "single file")
  expect(f).not.toContain("Ask")
  expect(f).toContain("Give a single file path to brothy.")
  expect(f).toContain("/single file 2/2") // the heading is match 1
})

test("an answer whose best query is only in the heading opens at the heading, no find", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const s = await mount(askVault(), "getting-started.md", W120, ai.f)
  await askIt(s, ai, JSON.stringify({ queries: ["quick start"] }))
  const f = await keys(s, "enter")
  expect(f).toContain("Quick start")
  expect(f).toContain("brothy path opens it.")
  expect(f).not.toContain("/quick start")
})

test("a heading renamed since indexing: the note opens where it was left and toasts heading gone", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const d = askVault()
  const s = await mount(d, "README.md", W120, ai.f)
  await askIt(s, ai)
  writeFileSync(join(d, "getting-started.md"), readFileSync(join(d, "getting-started.md"), "utf8").replace("## Open a single file", "## Open one file"))
  const f = await keys(s, "enter")
  expect(f).toContain("heading gone")
  expect(f).toContain("Getting started")
  expect(f).not.toContain("/single file")
})

test("an answer whose note was deleted opens the read error, with no jump", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const d = askVault()
  const s = await mount(d, "README.md", W120, ai.f)
  await askIt(s, ai)
  rmSync(join(d, "getting-started.md"))
  const f = await keys(s, "enter")
  expect(f).not.toContain("Ask")
  expect(f).not.toContain("heading gone")
  expect(f).not.toContain("/single file")
})

// ------------------------------------------------------------- e: edit

/** Mount with the editor stubbed: returns the argv each `e` would have spawned; `result` is what the run reports. */
async function mountEdit(root: string, file?: string, result?: EditResult) {
  const spawned: string[][] = []
  setup = quietAct(
    await testRender(<App root={root} initialFile={file ? join(root, file) : undefined} edit={(argv) => (spawned.push(argv), result)} />, { width: 120, height: 40 }),
  )
  await setup.renderOnce()
  return { s: setup, spawned }
}

test("e opens the note in $EDITOR at the top line of Source", async () => {
  const prev = { v: process.env.VISUAL, e: process.env.EDITOR }
  process.env.VISUAL = "ed-test"
  try {
    const d = tmp({ "a.md": "# A\n\nline\nline\n" })
    const { s, spawned } = await mountEdit(d, "a.md")
    await keys(s, "s", "e")
    expect(spawned).toEqual([["ed-test", "+1", join(d, "a.md")]])
  } finally {
    if (prev.v === undefined) delete process.env.VISUAL
    else process.env.VISUAL = prev.v
  }
})

test("e in Preview lands on the heading at the top of the view", async () => {
  const d = tmp({ "a.md": "intro\n\n# One\n\ntext\n\n## Two\n\n" + "para\n\n".repeat(60) })
  const { s, spawned } = await mountEdit(d, "a.md")
  await keys(s, "]", "]", "e") // scroll to the second heading
  expect(spawned.length).toBe(1)
  expect(spawned[0]![1]).toBe("+7")
})

test("e reloads the note afterwards and says so", async () => {
  const d = tmp({ "a.md": "# A\n" })
  const { s } = await mountEdit(d, "a.md")
  expect(await keys(s, "e")).toContain("edited")
})

test("e says when the editor fails or exits with an error, and still reloads", async () => {
  const d = tmp({ "a.md": "# A\n" })
  const failed = await mountEdit(d, "a.md", { code: 1, signal: null })
  const f = await keys(failed.s, "e")
  expect(f).toContain("exited with 1")
  expect(f).not.toContain("edited")
  failed.s.renderer.destroy()
  const none = await mountEdit(d, "a.md", { error: "no terminal for the editor" })
  expect(await keys(none.s, "e")).toContain("no terminal for the editor")
})

test("e is listed in the help", async () => {
  const d = tmp({ "a.md": "# A\n" })
  const { s } = await mountEdit(d, "a.md")
  expect(await keys(s, "?")).toContain("edit the note in $EDITOR")
})

test("e with no note open toasts", async () => {
  const d = tmp({ "x.txt": "nothing" })
  const { s, spawned } = await mountEdit(d)
  expect(await keys(s, "e")).toContain("no note to edit")
  expect(spawned).toEqual([])
})

// ------------------------------------------------------------- stdin document

/** `scanDelay`: when the background link scan starts; far off by default so a test controls when the folder is read. */
async function mountStdin(text: string, root: string, size = { width: 120, height: 30 }, scanDelay = 60_000) {
  const spawned: string[][] = []
  setup = quietAct(await testRender(<App root={root} stdin={text} linkScanDelay={scanDelay} edit={(argv) => void spawned.push(argv)} />, size))
  await setup.renderOnce()
  return { s: setup, spawned }
}

test("stdin: the piped text is the document, titled stdin", async () => {
  const d = tmp({ "other.md": "# Other\n" })
  const { s } = await mountStdin("# Piped\n\nhello from a pipe\n", d)
  const f = s.captureCharFrame()
  expect(f).toContain("hello from a pipe")
  expect(f).toContain("stdin")
})

test("stdin: no Files tree, so the folder's notes are not listed", async () => {
  const d = tmp({ "other.md": "# Other\n" })
  const { s } = await mountStdin("# Piped\n", d)
  expect(await keys(s, "1")).not.toContain("other")
})

test("stdin: e toasts instead of spawning an editor", async () => {
  const d = tmp({})
  const { s, spawned } = await mountStdin("# Piped\n", d)
  expect(await keys(s, "e")).toContain("stdin · nothing to edit")
  expect(spawned).toEqual([])
})

test("stdin: links resolve against the working folder's notes", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const { s } = await mountStdin("see [[other]]\n", d)
  expect(s.captureCharFrame()).toContain("see")
  await keys(s, "f", "a")
  expect(s.captureCharFrame()).toContain("body of other")
})

// the folder is scanned on first link use, not at startup: a note created after mounting is found
test("stdin: f follows a link to a note created after startup (scan is lazy)", async () => {
  const d = tmp({})
  const { s } = await mountStdin("see [[late]]\n", d)
  writeFileSync(join(d, "late.md"), "# Late\n\nbody of late\n")
  await keys(s, "f", "a")
  expect(s.captureCharFrame()).toContain("body of late")
})

test("stdin: the folder is scanned in the background, so links light up without a key", async () => {
  const d = tmp({ "late.md": "# Late\n" })
  const linkFg = (s: Setup) => JSON.stringify(spansOf(s).find((sp) => sp.text.includes("late"))?.fg)
  const idle = (await mountStdin("see [[late]]\n", d)).s
  const before = linkFg(idle)
  idle.renderer.destroy()
  const { s } = await mountStdin("see [[late]]\n", d, undefined, 0)
  await waitFor(s, () => linkFg(s) !== before)
})

test("stdin: using a link before the background scan runs scans once", async () => {
  const d = tmp({})
  const { s } = await mountStdin("see [[late]]\n", d)
  writeFileSync(join(d, "late.md"), "# Late\n\nbody of late\n")
  await keys(s, "f", "a")
  expect(s.captureCharFrame()).toContain("body of late")
  writeFileSync(join(d, "later.md"), "# Later\n")
  await keys(s, "f") // already scanned: the new note is not picked up again
  expect(await keys(s, "C-p", "type:later")).not.toContain("later.md")
})

test("stdin: C-p lists notes created after startup (scan is lazy)", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n", d)
  writeFileSync(join(d, "late.md"), "# Late\n")
  expect(await keys(s, "C-p", "type:lat")).toContain("late")
})

test("stdin: opening a link from Info scans on demand", async () => {
  const d = tmp({})
  const { s } = await mountStdin("see [[late]]\n", d)
  writeFileSync(join(d, "late.md"), "# Late\n\nbody of late\n")
  await keys(s, "2", "enter")
  expect(s.captureCharFrame()).toContain("body of late")
})

test("stdin: nothing is recorded as a project", async () => {
  const d = tmp({})
  await mountStdin("# Piped\n", d)
  expect(existsSync(join(cfgDir, "brothy", "projects.json"))).toBe(false)
})

test("stdin: a summarizes the piped text for this run without caching it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({})
  const ai = aiStub()
  setup = quietAct(await testRender(<App root={d} stdin={"# Piped\n\nwords about pipes\n"} fetch={ai.f} />, W120))
  await setup.renderOnce()
  await keys(setup, "a")
  expect(ai.calls.length).toBe(1)
  expect(JSON.stringify(ai.calls[0]!.body)).toContain("words about pipes")
  ai.send(0, "Pipes are discussed.")
  ai.end(0)
  await waitFrame(setup, (f) => f.includes("Pipes are discussed."))
  expect(cached()).toEqual({})
  expect(existsSync(cacheFile())).toBe(false)
  expect(setup.captureCharFrame()).not.toContain("outdated")
})

test("stdin: the footer does not offer e", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n", d)
  expect(s.captureCharFrame()).not.toContain("e edit")
})

test("stdin: the tab row is ¹Outline ²Info, with no Files", async () => {
  const d = tmp({ "other.md": "# Other\n" })
  const { s } = await mountStdin("# Piped\n\n## Sub\n", d)
  const row = s.captureCharFrame().split("\n").find((l) => l.includes("Outline"))!
  expect(row.slice(0, 31)).toBe("  ¹Outline   ²Info" + " ".repeat(13))
  expect(row).not.toContain("Files")
})

test("stdin: 1 and 2 pick Outline and Info, 3 does nothing, / on Info filters the Outline", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n\n## Sub\n", d)
  expect(await keys(s, "2")).toMatch(/Info[\s\S]*Words|Info/)
  expect(await keys(s, "3")).not.toContain("no Markdown files")
  expect(s.captureCharFrame().split("\n")[3]).toMatch(/^ ─{9,}━+/) // rule still under Info (second tab), Outline's is not
  await keys(s, "/")
  expect(s.captureCharFrame()).toContain("/ ")
  expect(s.captureCharFrame()).not.toContain("no Markdown files")
  await keys(s, "esc", "1")
  expect(s.captureCharFrame()).toContain("Sub")
})

test("stdin: the help describes 1 2 for the piped document", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n", d, { width: 90, height: 40 }) // one column: the description is not cut
  expect(await keys(s, "?")).toContain("piped: 1 2 only")
})

test("stdin: the view choice is not saved", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n", d)
  await keys(s, "2")
  expect(existsSync(join(cfgDir, "brothy", "config.json"))).toBe(false)
})

test("stdin: e on a followed note runs the editor as a piped session (keys from the terminal)", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const runs: [string, boolean][] = []
  setup = quietAct(
    await testRender(<App root={d} stdin={"see [[other]]\n"} linkScanDelay={60_000} edit={(argv, piped) => void runs.push([argv.at(-1)!, piped])} />, W120),
  )
  await setup.renderOnce()
  await keys(setup, "f", "a")
  expect(await keys(setup, "e")).toContain("edited")
  expect(runs).toEqual([[join(d, "other.md"), true]])
})

test("stdin: H comes back to the piped document from a followed link", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const { s } = await mountStdin("see [[other]]\n\npiped body\n", d)
  expect(await keys(s, "f", "a")).toContain("body of other")
  const back = await keys(s, "H")
  expect(back).toContain("piped body")
  expect(back).not.toContain("is gone")
})

test("stdin: a followed note keeps the piped tabs, 1 is Outline and nothing is saved; H back draws", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const { s } = await mountStdin("see [[other]]\n\npiped body\n", d)
  await keys(s, "f", "a")
  const f = await keys(s, "1")
  expect(f).toContain("¹Outline")
  expect(f).not.toContain("Files")
  expect(existsSync(join(cfgDir, "brothy", "config.json"))).toBe(false)
  expect(await keys(s, "H")).toContain("piped body")
})

test("stdin: quitting on a followed note records no project", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const { s } = await mountStdin("see [[other]]\n", d)
  await keys(s, "f", "a")
  s.renderer.destroy() // the renderer's end records the workspace, as q does
  expect(existsSync(join(cfgDir, "brothy", "projects.json"))).toBe(false)
})

const TWO = "# A\n\n## One\n\nfirst\n\n## Two\n\nsecond\n"
const EDITED = "# A\n\n## One\n\nfirst, edited\n\n## Two\n\nsecond\n\n## Three\n\nthird\n"

test("a live reload lists the changed sections in Info and counts them in the toast", async () => {
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", W120)
  await keys(s, "3")
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("reloaded · 2 sections changed"), 4000)
  const f = s.captureCharFrame()
  expect(f).not.toContain("D explains") // no ai block
  expect(f).toMatch(/Changed · since \d\d:\d\d/)
  expect(f).toMatch(/~ One\s+\+1 −1/)
  expect(f).toMatch(/\+ Three\s+\+3/)
  expect(f).not.toMatch(/[~+] Two/)
})

test("with an ai block the reload toast names D", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", W120)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("reloaded · 2 sections changed · D explains"), 4000)
})

test("saves add up against the text the note was opened with", async () => {
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", W120)
  writeFileSync(join(d, "a.md"), TWO.replace("first", "first!"))
  await waitFrame(s, (f) => f.includes("reloaded · 1 section changed"), 4000)
  writeFileSync(join(d, "a.md"), TWO.replace("first", "first!").replace("second", "second!"))
  await waitFrame(s, (f) => f.includes("reloaded · 2 sections changed"), 4000)
})

test("a properties-only change and an unchanged save", async () => {
  const d = tmp({ "a.md": "---\ntitle: x\n---\n" + TWO })
  const s = await mount(d, "a.md", W120)
  await keys(s, "3")
  writeFileSync(join(d, "a.md"), "---\ntitle: y\n---\n" + TWO)
  await waitFrame(s, (f) => f.includes("reloaded · properties changed"), 4000)
  expect(s.captureCharFrame()).not.toContain("Changed")
  writeFileSync(join(d, "a.md"), "---\ntitle: x\n---\n" + TWO + "\n\n")
  await waitFrame(s, (f) => f.includes("reloaded from disk"), 4000)
})

test("switching notes drops the change list; coming back starts from the text on disk", async () => {
  const d = tmp({ "a.md": TWO, "b.md": "# B\n" })
  const s = await mount(d, "a.md", W120)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("2 sections changed"), 4000)
  await openNote(s, "b")
  expect(await keys(s, "3")).not.toContain("Changed")
  await openNote(s, "a")
  expect(await keys(s, "3")).not.toContain("Changed")
})

test("D streams an explanation of the changed hunks into Info; the baseline moves", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  const [system, user] = ai.calls[0]!.body.messages
  expect(system!.content).toBe(DELTA_PROMPT)
  expect(user!.content.startsWith("Note: a\n§1 edited · A › One\n@@\n")).toBe(true)
  expect(user!.content).toContain("+ first, edited")
  expect(user!.content).toContain("§2 added · A › Three")
  expect(user!.content).not.toContain("second") // unchanged sections are never sent
  expect(await keys(s)).toContain("Changed · explaining…")
  ai.send(0, "Rewords the first part and adds a third.\n§1: first line reworded")
  await waitFrame(s, (f) => f.includes("Rewords the first part"))
  ai.send(0, ' | "first, edited"\n§2: new closing section\n')
  ai.end(0)
  await waitFrame(s, (f) => f.includes("Changed · llama3.2") && f.includes("first line reworded") && f.includes("new closing section"))
  expect(await keys(s, "D")).toMatch(/no changes since \d\d:\d\d/)
})

test("D mid-stream cancels; the list goes back to idle", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  const f = await keys(s, "D")
  expect(f).toContain("explanation cancelled")
  expect(f).toMatch(/Changed · since \d\d:\d\d/)
})

test("a reload mid-stream leaves the newer changes listed after completion", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  writeFileSync(join(d, "a.md"), EDITED.replace("first, edited", "first, edited twice"))
  await waitFrame(s, (f) => f.includes("first, edited twice"), 4000)
  ai.send(0, "Old summary.\n§1: reworded")
  ai.end(0)
  await waitFrame(s, (f) => /Changed · since \d\d:\d\d/.test(f) && /~ One/.test(f))
  const f = s.captureCharFrame()
  expect(f).not.toContain("Old summary.")
  expect(f).not.toMatch(/\+ Three/) // explained already: the baseline moved to the sent text
})

test("an explanation goes once a reload is too large to compare", async () => {
  aiConfig(OLLAMA)
  // five sections of 1000 lines: rewriting them all is over DIFF_BUDGET, editing one line is not
  const big = (v: (k: number, i: number) => string) =>
    Array.from({ length: 5 }, (_, k) => `## S${k}\n\n` + Array.from({ length: 1000 }, (_, i) => v(k, i)).join("\n") + "\n").join("\n")
  const d = tmp({ "a.md": big((k, i) => `a${k}-${i}`) })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), big((k, i) => (k === 0 && i === 5 ? "edited" : `a${k}-${i}`)))
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Rewords one line.\n§1: one line edited\n")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("Changed · llama3.2") && f.includes("Rewords one line."))
  writeFileSync(join(d, "a.md"), big((k, i) => `b${k}-${i}`))
  await waitFrame(s, (f) => f.includes("reloaded · too large to compare"), 4000)
  const f = await keys(s)
  expect(f).not.toContain("Rewords one line.")
  expect(f).not.toContain("Changed")
})

test("a failed request: one error toast, the list stays", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.fail(0, "boom")
  await waitFrame(s, (f) => f.includes("AI: boom") && /Changed · since/.test(f))
})

test("a reply past MAX_DELTA keeps the summary and the finished section lines", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Rewords the first part.\n§1: first line reworded\n")
  await waitFrame(s, (f) => f.includes("first line reworded"))
  ai.send(0, "§2: " + "very ".repeat(500))
  await waitFrame(s, (f) => f.includes("Changed · llama3.2") && f.includes("Rewords the first part.") && f.includes("first line reworded"))
  const f = s.captureCharFrame()
  expect(f).not.toContain("too long")
  expect(f).not.toContain("very very")
})

test("a reply with nothing usable: AI: no usable explanation", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "§9: no such section")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("AI: no usable explanation"))
})

test("leaving the note mid-stream cancels and drops the list", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO, "b.md": "# B\n" })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  await openNote(s, "b")
  expect(ai.calls[0]!.signal?.aborted).toBe(true)
  await openNote(s, "a") // a fresh baseline from the text on disk: nothing listed
  expect(await keys(s, "3")).not.toContain("Changed")
  expect(await keys(s, "D")).toMatch(/no changes since/) // the cancelled job no longer counts or runs
})

test("D: AI off without an ai block; no changes without a reload", async () => {
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", W120)
  expect(await keys(s, "D")).toContain(`AI off · set "ai" in config.json`)
  aiConfig(OLLAMA)
  expect(await keys(s, "D")).toMatch(/no changes since \d\d:\d\d/)
})

test("D in zen does nothing", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", W120)
  const z = await keys(s, "z", "D")
  expect(z).not.toContain("no changes since")
  expect(z).not.toContain("AI off")
})

test("help lists D in the AI group; the Info footer shows D changes only with changes and AI", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { width: 120, height: 40 })
  const help = (await openHelp(s)).split("\n")
  const at = help.findIndex((l) => l.includes("explain what changed on disk"))
  const ai = help.findIndex((l) => /  AI  /.test(l))
  expect(ai).toBeGreaterThan(help.findIndex((l) => l.includes("Document")))
  expect(at).toBeGreaterThan(ai)
  expect(help[at]!.indexOf("D ")).toBe(help[ai]!.indexOf("AI"))
  await keys(s, "esc")
  expect((await keys(s, "3")).split("\n")[38]).not.toContain("D changes")
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  setSystemTime(new Date(Date.now() + 10_000)) // past the toast, so the hints get the whole line
  try {
    expect((await keys(s, "tab", "3")).split("\n")[38]).toContain("D changes")
  } finally {
    setSystemTime()
  }
})

const LONG = "# A\n\n## One\n\n" + Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n\n") + "\n\n## Two\n\nsecond\n\n## Three\n\nthird\n\n" +
  Array.from({ length: 30 }, (_, i) => `tail ${i}`).join("\n\n") + "\n" // room below Three, so its heading can reach the top

test("⏎ on a change row jumps to its heading; removed rows are skipped", async () => {
  const d = tmp({ "a.md": LONG })
  const s = await mount(d, "a.md", W120)
  writeFileSync(join(d, "a.md"), LONG.replace("row 3\n", "row 3 edited\n").replace("## Two\n\nsecond\n\n", "").replace("third", "third!"))
  await waitFrame(s, (f) => f.includes("3 sections changed"), 4000)
  await keys(s, "3")
  // rows: ~ One (stop), − Two (not a stop), ~ Three (stop): j goes from One straight to Three
  const f = await keys(s, "j", "enter")
  expect(bodyRows(f).split("\n")[0]).toContain("Three")
})

test("⏎ after D lands on the quoted line", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": LONG })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), LONG.replace("row 40\n", "row 40 changed now\n"))
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, 'One line changed.\n§1: row forty reworded | "row 40 changed now"\n')
  ai.end(0)
  await waitFrame(s, (f) => f.includes("row forty reworded"))
  const f = await keys(s, "enter")
  expect(bodyRows(f).split("\n").slice(0, 3).join("\n")).toContain("row 40 changed now")
  // Source: the same row by its raw text
  const src = await keys(s, "s", "3", "enter")
  expect(bodyRows(src).split("\n").slice(0, 3).join("\n")).toContain("row 40 changed now")
})

test("jump finds the heading again when it moved", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": LONG })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), LONG.replace("third", "third!"))
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  // mid-request a new section lands above: Three's outline index shifts by one
  writeFileSync(join(d, "a.md"), LONG.replace("## One", "## Zero\n\nz\n\n## One").replace("third", "third!"))
  await waitFrame(s, (f) => f.includes("Zero"), 4000)
  const f = await keys(s, "3", "enter") // loading rows: the sent list, one stop (Three)
  expect(bodyRows(f).split("\n")[0]).toContain("Three")
})

test("D cancels a running explanation even after the ai block is gone", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  writeFileSync(join(cfgDir, "brothy", "config.json"), "{}")
  const f = await keys(s, "D")
  expect(f).toContain("explanation cancelled")
  expect(ai.calls[0]!.signal?.aborted).toBe(true)
})

// ------------------------------------------------------------- zen gloss
const { glossTarget, glossKey } = await import("../src/gloss")
const said = (w: string, n = 25) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ")
/** Four sections, each with 25 words of its own. */
const GLOSS_MD = ["Guide", "Apples", "Pears", "Plums"].map((h, i) => `${i ? "##" : "#"} ${h}\n\n${said(h.toLowerCase())}\n`).join("\n")
const glossFile = () => join(cacheDir, "brothy", "glosses.json")
const glossCache = () => (existsSync(glossFile()) ? (JSON.parse(readFileSync(glossFile(), "utf8")) as Record<string, { gloss: string }>) : {})
/** Cache a gloss for section `index` of the note at `path`, fresh unless `hash` is given. */
function seedGloss(path: string, index: number, gloss: string, hash?: string) {
  const g = glossTarget(readFileSync(path, "utf8"), index, path, "a")!
  const all = glossCache()
  all[glossKey(g.id, "explain")] = { hash: hash ?? textHash(g.text), v: 1, gloss, model: "llama3.2", at: Date.now() } as never
  mkdirSync(join(cacheDir, "brothy"), { recursive: true })
  writeFileSync(glossFile(), JSON.stringify(all))
}

test("zen shows a fresh cached gloss for the reading section by itself, without a request", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "About the guide.")
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  const f = await keys(s, "z")
  expect(f).toContain("┈ gloss · Guide ┈")
  expect(f).toContain("About the guide.")
  expect(ai.calls.length).toBe(0)
})

test("a section never glossed shows nothing; leaving fades the sheet; coming back shows it again", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "About the guide.")
  const s = await mount(d, "a.md", W120)
  expect(await keys(s, "z")).toContain("About the guide.")
  await keys(s, "]")
  await waitFrame(s, (f) => !f.includes("gloss ·"))
  expect(s.captureCharFrame()).not.toContain("About the guide.")
  expect(await keys(s, "[")).toContain("About the guide.")
})

test("an outdated gloss never shows by itself", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "About the guide.", "stale")
  const s = await mount(d, "a.md", W120)
  expect(await keys(s, "z")).not.toContain("gloss ·")
})

test("editing the glossed section marks the sheet outdated; editing another section keeps it fresh", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const p = join(d, "a.md")
  seedGloss(p, 0, "About the guide.")
  const s = await mount(d, "a.md", W120)
  expect(await keys(s, "z")).toContain("gloss · Guide ┈")
  writeFileSync(p, GLOSS_MD.replace("pears3", "PEARS"))
  let f = await keys(s, "r")
  expect(f).toContain("gloss · Guide ┈")
  expect(f).not.toContain("outdated")
  writeFileSync(p, GLOSS_MD.replace("guide3", "GUIDE"))
  f = await keys(s, "r")
  expect(f).toContain("gloss · Guide · outdated · a")
  expect(f).toContain("About the guide.")
})

test("no gloss sheet without an ai block, even with a cached gloss", async () => {
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "About the guide.")
  const s = await mount(d, "a.md", W120)
  expect(await keys(s, "z")).not.toContain("gloss ·")
})

test("leaving zen hides the gloss; entering again shows it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "About the guide.")
  const s = await mount(d, "a.md", W120)
  await keys(s, "z")
  const f = await keys(s, "z")
  expect(panelShown(f)).toBe(true)
  expect(f).not.toContain("About the guide.")
  expect(await keys(s, "z")).toContain("About the guide.")
})

test("a small terminal keeps the reading line clear of the sheet", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "About the guide.")
  const s = await mount(d, "a.md", { width: 60, height: 14 })
  const lines = (await keys(s, "z")).split("\n")
  const mark = lines.findIndex((l) => l.includes("▸"))
  const rule = lines.findIndex((l) => l.includes("gloss · Guide"))
  expect(mark).toBeGreaterThan(-1)
  expect(rule).toBeGreaterThan(mark)
})

test("a long gloss is cut to 3 rows ending in …", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, said("gloss", 60))
  const lines = (await keys(await mount(d, "a.md", W120), "z")).split("\n")
  const rule = lines.findIndex((l) => l.includes("gloss · Guide"))
  expect(lines[rule + 3]!.trimEnd().endsWith("…")).toBe(true)
})

test("a in zen on a section with nothing in it: nothing to gloss here", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n" })
  const s = await mount(d, "a.md", W120)
  expect(await keys(s, "z", "a")).toContain("nothing to gloss here")
})

test("esc hides the gloss and stays in zen; a shows the cached gloss again without a request; esc esc leaves zen", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "About the guide.")
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  expect(await keys(s, "z")).toContain("About the guide.")
  let f = await keys(s, "esc")
  expect(f).not.toContain("About the guide.")
  expect(panelShown(f)).toBe(false)
  expect(await keys(s, "a")).toContain("About the guide.")
  expect(ai.calls.length).toBe(0)
  await keys(s, "esc")
  f = await keys(s, "esc")
  expect(panelShown(f)).toBe(true)
})

test("an esc-hidden gloss stays hidden until the reading line leaves and comes back", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "About the guide.")
  const s = await mount(d, "a.md", W120)
  await keys(s, "z", "esc")
  expect(await keys(s, "j")).not.toContain("About the guide.") // still in Guide
  await keys(s, "]")
  expect(await keys(s, "[")).toContain("About the guide.")
})

test("the a gloss hint shows in zen only with an ai block", async () => {
  const d = tmp({ "a.md": GLOSS_MD })
  let s = await mount(d, "a.md", { width: 140, height: 30 })
  expect((await keys(s, "z")).split("\n")[HINT_ROW]).not.toContain("a gloss")
  s.renderer.destroy()
  aiConfig(OLLAMA)
  s = await mount(d, "a.md", { width: 140, height: 30 })
  const row = (await keys(s, "z")).split("\n")[HINT_ROW]!
  expect(row).toContain("a gloss")
  expect(row.indexOf("[ ] section")).toBeLessThan(row.indexOf("a gloss"))
})

test("help lists the gloss under Zen and esc hides it", async () => {
  const d = tmp({ "a.md": "# A\n" })
  const s = await mount(d, "a.md", { width: 90, height: 80 }) // one column: the two-column sheet cuts long descriptions
  const lines = (await keys(s, "?")).split("\n")
  const at = lines.findIndex((l) => l.includes("gloss: explain the section you're reading"))
  const zen = lines.findIndex((l) => /\bZen\b/.test(l))
  expect(zen).toBeGreaterThan(lines.findIndex((l) => l.includes("Document")))
  expect(at).toBeGreaterThan(zen)
  expect(lines.some((l) => l.includes("clear find · hide gloss · leave zen"))).toBe(true)
})

test("a outside zen is still the TL;DR", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  const f = await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  expect(ai.calls[0]!.body.messages[0]!.content).not.toStartWith("Explain this section")
  expect(f).toContain("summarizing")
  expect(f).not.toContain("gloss")
})

test("a in zen streams a gloss for the reading section, caches it; a second run shows it without a request", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const ai = aiStub()
  let s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "z", "a")
  await waitFor(s, () => ai.calls.length === 1)
  const msgs = ai.calls[0]!.body.messages
  expect(msgs[0]!.content).toStartWith("Explain this section of a note to its reader")
  expect(msgs[1]!.content).toBe(`Note: a\nSection: Guide\n\n${said("guide")}`)
  await waitFrame(s, (f) => f.includes("gloss · Guide · explaining…"))
  ai.send(0, "The guide ")
  await waitFrame(s, (f) => f.includes("The guide"))
  ai.send(0, "introduces fruit.")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("The guide introduces fruit.") && !f.includes("explaining…"))
  expect(Object.values(glossCache()).map((e) => e.gloss)).toEqual(["The guide introduces fruit."])
  s.renderer.destroy()

  const ai2 = aiStub()
  s = await mount(d, "a.md", W120, ai2.f)
  expect(await keys(s, "z")).toContain("The guide introduces fruit.")
  expect(ai2.calls.length).toBe(0)
})

test("a while the gloss streams cancels it: nothing cached, the sheet closes", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "z", "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Half")
  const f = await keys(s, "a")
  expect(f).toContain("gloss cancelled")
  expect(f).not.toContain("gloss · Guide")
  expect(ai.calls[0]!.signal?.aborted).toBe(true)
  expect(glossCache()).toEqual({})
})

test("a on a gloss already on screen regenerates it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "Old gloss.")
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  expect(await keys(s, "z")).toContain("Old gloss.")
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  await waitFrame(s, (f) => f.includes("gloss · Guide · explaining…"))
})

test("a on an outdated gloss sends a new request", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  seedGloss(join(d, "a.md"), 0, "Old gloss.", "stale")
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "z", "a")
  await waitFor(s, () => ai.calls.length === 1)
})

test("a 4th concurrent AI request is refused: AI busy · 3 requests running", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "z", "a", "]", "a", "]", "a", "]")
  await waitFor(s, () => ai.calls.length === 3)
  expect(await keys(s, "a")).toContain("AI busy · 3 requests running")
  expect(ai.calls.length).toBe(3)
})

test("a failed gloss: error toast, the sheet closes, nothing cached", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "z", "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.fail(0, "model overloaded")
  await waitFrame(s, (f) => f.includes("AI: model overloaded") && !f.includes("gloss · Guide"))
  expect(glossCache()).toEqual({})
})

test("a failure for a section the reading line left names its heading", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "z", "a")
  await waitFor(s, () => ai.calls.length === 1)
  await keys(s, "]")
  ai.fail(0, "model overloaded")
  await waitFrame(s, (f) => f.includes("AI · Guide: model overloaded"))
})

test("moving on mid-stream: the gloss is cached for its own section and shows on coming back", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "z", "a")
  await waitFor(s, () => ai.calls.length === 1)
  await keys(s, "]")
  await waitFrame(s, (f) => !f.includes("gloss · Guide"))
  ai.send(0, "About the guide.")
  ai.end(0)
  await waitFor(s, () => Object.keys(glossCache()).length === 1)
  expect(s.captureCharFrame()).not.toContain("About the guide.") // Apples is under the reading line
  expect(await keys(s, "[")).toContain("About the guide.")
})

test("a gloss's model error mentions the gloss, not a summary", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "z", "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.end(0) // a stream with no text
  await waitFrame(s, (f) => f.includes("AI: empty gloss"))
})

test("a gloss without the preset's key env var toasts which one to set", async () => {
  aiConfig({ provider: "openrouter", model: "x/y" })
  const prev = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    const d = tmp({ "a.md": GLOSS_MD })
    const ai = aiStub()
    const s = await mount(d, "a.md", W120, ai.f)
    expect(await keys(s, "z", "a")).toContain("AI: set OPENROUTER_API_KEY")
    expect(ai.calls.length).toBe(0)
  } finally {
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev
  }
})

test("a piped document's gloss shows for the run but is not written to glosses.json", async () => {
  aiConfig(OLLAMA)
  const d = tmp({})
  const ai = aiStub()
  setup = quietAct(await testRender(<App root={d} stdin={GLOSS_MD} linkScanDelay={60_000} fetch={ai.f} />, W120))
  const s = setup
  await s.renderOnce()
  await keys(s, "z", "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Piped gloss.")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("Piped gloss.") && !f.includes("explaining…"))
  expect(existsSync(glossFile())).toBe(false)
})

test("a cancels a running gloss even after the ai block is gone", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": GLOSS_MD })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "z", "a")
  await waitFor(s, () => ai.calls.length === 1)
  writeFileSync(join(cfgDir, "brothy", "config.json"), "{}")
  const f = await keys(s, "a")
  expect(f).toContain("gloss cancelled")
  expect(f).not.toContain("AI off")
  expect(ai.calls[0]!.signal?.aborted).toBe(true)
})

test("a cancels a running summary even after the ai block is gone", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nText to summarize.\n" })
  const ai = aiStub()
  const s = await mount(d, "a.md", W120, ai.f)
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  writeFileSync(join(cfgDir, "brothy", "config.json"), "{}")
  const f = await keys(s, "a")
  expect(f).toContain("summary cancelled")
  expect(f).not.toContain("AI off")
  expect(ai.calls[0]!.signal?.aborted).toBe(true)
})

test("a rerank is sent again after a candidate note's text changed", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const d = askVault()
  const s = await mount(d, "README.md", W120, ai.f)
  await askIt(s, ai)
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  ai.send(1, JSON.stringify({ answers: [{ id: "c1", why: "pass the file path" }] }))
  ai.end(1)
  await waitFrame(s, (fr) => fr.includes("Other matches"))
  await keys(s, "esc")
  const file = join(d, "getting-started.md")
  writeFileSync(file, readFileSync(file, "utf8").replace("Give a single file path to brothy.", "Give a single file path to brothy, or a folder, or stdin."))
  utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  await keys(s, "C-p", "type:?how do I open one file")
  await waitFrame(s, (fr) => fr.includes("⏎ ask"))
  await keys(s, "enter") // the queries come from memory
  await waitFrame(s, (fr) => fr.includes("↻ rerank with excerpts"))
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 3)
  expect(ai.calls[2]!.body.messages[1]!.content).toContain("or a folder, or stdin")
})

const OPENING = "**brothy** is a terminal Markdown reader with a calm, panel-based interface. Browse a folder of notes on the left, read on the right, and never leave the terminal."
const ZEN_BODY = "lorem ipsum dolor sit amet consectetur ".repeat(8)

test("an opening paragraph reads as written, in Preview and in zen: no initial, no altered letters", async () => {
  const s = await mount(tmp({ "a.md": `# A\n\n${OPENING}\n\n## Two\n\nSecond ${ZEN_BODY}\n` }), "a.md", { width: 100, height: 40 })
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

// ------------------------------------------------------------- welcome

function seedProjects(entries: { root: string; at: number; lastNote?: string }[]) {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "projects.json"), JSON.stringify({ projects: entries.map((e) => ({ lastNote: null, top: 0, ...e })) }))
}
const WELCOME = { width: 120, height: 34 }
const { MINI_W } = await import("../src/minimap")

test("welcome: the wordmark over a bowl, today's message, keycaps, recent projects and the hint", async () => {
  const t = themeByName("brothy")
  const other = tmp({ "x.md": "# X\n" })
  // three recents, as in v3's frame
  seedProjects([{ root: other, at: Date.now() - 3600_000, lastNote: join(other, "x.md") }, { root: tmp({}), at: 2 }, { root: tmp({}), at: 1 }])
  const empty = tmp({ "notes.txt": "" })
  const s = await mount(empty, undefined, WELCOME)
  const f = await keys(s)
  const rows = f.split("\n")
  expect(f).toContain("┏┓ ┳━┓┏━┓╺┳╸╻ ╻╻ ╻")
  expect(f).toContain("▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖")
  // the line is cut at the 80-column measure, and macOS's temp paths run past it
  expect(f).toContain(`No Markdown files found in ${empty}`.slice(0, 79))
  expect(f).toContain(" o  open a project    t  theme    ?  keys    q  quit")
  expect(f).toContain("⏎ open   o all projects or a path")
  const head = rows.findIndex((r) => /Recent\s+3\b/.test(r))
  expect(head).toBeGreaterThan(0)
  expect(rows[head + 1]).toContain(basename(other))
  expect(rows[head + 1]).toContain("x") // the last note, right-aligned
  // v3's rows at 120×34: wordmark 4–6, rim 12, message 20, keycaps 22
  expect(rows[4]).toContain("┏┓ ┳━┓")
  expect(rows[12]).toContain("▗▄▄")
  expect(rows[20]).toContain("No Markdown files")
  expect(rows[22]).toContain("open a project")
  const sp = spansOf(s)
  const cap = sp.find((x) => x.text.includes(" o "))!
  expect([hex(cap.fg), hex(cap.bg)]).toEqual([t.accent, t.backgroundElement])
  expect(hex(sp.find((x) => x.text.includes("┏┓"))!.fg)).toBe(t.primary)
  expect(hex(sp.find((x) => x.text.includes("▗"))!.fg)).toBe(t.text) // rim
  expect(sp.some((x) => x.text.includes("▄") && hex(x.bg) === t.secondary)).toBe(true) // broth
  expect(hex(sp.find((x) => x.text.includes("████"))!.fg)).toBe(t.primary) // body
  expect(onBg(s, t.primary).join("")).toContain(basename(other)) // first row selected at rest
})

test("welcome: no recent projects leaves out the list, the hint stays", async () => {
  const s = await mount(tmp({ "notes.txt": "" }), undefined, WELCOME)
  const f = await keys(s)
  expect(f).not.toContain("Recent")
  expect(f).toContain("o all projects or a path")
  expect(f).not.toContain("⏎ open")
})

test("welcome at 80×24: the small bowl, no chopsticks, v3's rows", async () => {
  seedProjects([{ root: tmp({}), at: 3 }, { root: tmp({}), at: 2 }, { root: tmp({}), at: 1 }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { width: 80, height: 24 })
  const rows = (await keys(s)).split("\n")
  expect(rows[2]).toContain("┏┓ ┳━┓")
  expect(rows[7]).toContain("▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖")
  expect(rows.join("\n")).not.toContain("▞")
  expect(rows[12]).toContain("No Markdown files")
  expect(rows[14]).toContain("open a project")
})

test("welcome: a click on a recent project opens it", async () => {
  const other = tmp({ "x.md": "# Xylophone\n" })
  seedProjects([{ root: other, at: Date.now() }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, WELCOME)
  const rows = (await keys(s)).split("\n")
  const y = rows.findIndex((r) => r.includes(basename(other)) && !r.includes("No Markdown"))
  await s.mockMouse.click(rows[y]!.indexOf(basename(other)), y)
  expect(await waitFrame(s, (f) => f.includes("Xylophone"))).toContain("Xylophone")
})

test("welcome: ↑ ↓ move the selection and ⏎ opens it; pointing moves it too", async () => {
  const a = tmp({ "a.md": "# Alpha note\n" })
  const b = tmp({ "b.md": "# Bravo note\n" })
  seedProjects([{ root: a, at: Date.now() }, { root: b, at: Date.now() - 1000 }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, WELCOME)
  await keys(s)
  const sel = () => onBg(s, PRIMARY).join("")
  expect(sel()).toContain(basename(a))
  await keys(s, "down")
  expect(sel()).toContain(basename(b))
  await keys(s, "down") // stays on the last row
  expect(sel()).toContain(basename(b))
  await keys(s, "up")
  expect(sel()).toContain(basename(a))
  const rows = s.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes(basename(b)))
  await s.mockMouse.moveTo(rows[y]!.indexOf(basename(b)), y)
  await keys(s)
  expect(sel()).toContain(basename(b))
  await keys(s, "up") // the pointer still rests on b
  expect(sel()).toContain(basename(a))
  await keys(s, "down")
  expect(sel()).toContain(basename(b))
  expect(await keys(s, "enter")).toContain("Bravo note")
})

test("welcome: a missing project is listed muted; opening it drops it with a toast", async () => {
  const gone = join(tmpdir(), "brothy-gone-" + Date.now())
  seedProjects([{ root: gone, at: Date.now() }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, WELCOME)
  const f = await keys(s)
  expect(f).toContain("missing")
  const after = await keys(s, "enter")
  expect(after).toContain("is gone")
  expect(after).not.toContain("Recent")
})

test("welcome with motion: the wordmark and bowl ink in from border; the steam rises until a key stops it for good", async () => {
  const t = themeByName("brothy")
  const d = tmp({ "notes.txt": "" })
  setup = quietAct(await testRender(<App root={d} motion />, WELCOME))
  await setup.renderOnce()
  const s = setup
  const markFg = () => hex(spansOf(s).find((x) => x.text.includes("┏┓"))!.fg)
  expect(markFg()).toBe(t.border)
  const steam = () => s.captureCharFrame().split("\n").slice(7, 12).map((r) => r.replace(/▞/g, " ")).join("\n")
  const first = steam()
  await waitFor(s, () => markFg() === t.primary)
  await waitFor(s, () => steam() !== first)
  await keys(s, "x") // any key
  const still = steam()
  await sleep(400)
  await s.renderOnce()
  expect(steam()).toBe(still)
  expect(markFg()).toBe(t.primary)
})

test("welcome without motion (tests): drawn still, inked, the same frame later", async () => {
  const t = themeByName("brothy")
  const s = await mount(tmp({ "notes.txt": "" }), undefined, WELCOME)
  const a = await keys(s)
  expect(hex(spansOf(s).find((x) => x.text.includes("┏┓"))!.fg)).toBe(t.primary)
  expect(a).toMatch(/[⠁-⣿]/)
  await sleep(350)
  await s.renderOnce()
  expect(s.captureCharFrame()).toBe(a)
})

test("welcome with motion: a resize stops the steam for good, and so does opening a note", async () => {
  const other = tmp({ "x.md": "# Xylophone\n" })
  seedProjects([{ root: other, at: Date.now() }])
  setup = quietAct(await testRender(<App root={tmp({ "notes.txt": "" })} motion />, WELCOME))
  await setup.renderOnce()
  const s = setup
  const steam = () => s.captureCharFrame().split("\n").filter((r) => /[⠁-⣿]/.test(r)).join("\n")
  const first = steam()
  await waitFor(s, () => steam() !== first)
  s.resize(118, 34)
  await sleep(30)
  await s.renderOnce()
  const still = steam()
  await sleep(400)
  await s.renderOnce()
  expect(steam()).toBe(still)
  await keys(s, "enter")
  const opened = await waitFrame(s, (f) => f.includes("Xylophone"))
  expect(opened.split("\n").map((r) => [...r].slice(0, 118 - MINI_W).join("")).join("\n")).not.toMatch(/[⠁-⣿]/) // the minimap keeps its braille
})

test("welcome keys act only on the rows on screen: none listed, ⏎ opens nothing; a short list stops at its last row", async () => {
  const ps = Array.from({ length: 5 }, (_, i) => tmp({ "n.md": `# Project ${i}\n` }))
  seedProjects(ps.map((root, i) => ({ root, at: 10 - i })))
  const tiny = await mount(tmp({ "notes.txt": "" }), undefined, { width: 60, height: 16 })
  expect(await keys(tiny)).not.toContain("Recent")
  expect(await keys(tiny, "enter")).not.toContain("Project 0")
  tiny.renderer.destroy()
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { width: 100, height: 20 })
  const f = await keys(s)
  const shown = ps.filter((p) => f.includes(basename(p))).length
  expect(shown).toBeGreaterThan(0)
  expect(shown).toBeLessThan(5)
  await keys(s, ...Array.from({ length: 6 }, () => "down"))
  expect(onBg(s, PRIMARY).join("")).toContain(basename(ps[shown - 1]!))
  await keys(s, "enter")
  expect(await waitFrame(s, (x) => x.includes(`Project ${shown - 1}`))).toContain(`Project ${shown - 1}`)
})

test("welcome: coming back to the empty folder lists the project just left, with its last note", async () => {
  const b = tmp({ "bee.md": "# Bee note\n" })
  seedProjects([{ root: b, at: Date.now() }])
  const a = tmp({ "notes.txt": "" })
  const s = await mount(a, undefined, WELCOME)
  expect(await keys(s)).not.toContain("bee")
  await keys(s, "enter")
  await waitFrame(s, (f) => f.includes("Bee note"))
  await keys(s, "o", `type:${basename(a)}`, "enter")
  const f = await waitFrame(s, (x) => x.includes("No Markdown files"))
  const row = f.split("\n").find((r) => r.includes(basename(b)))!
  expect(row).toContain("bee")
})

test("welcome with motion: a key in the middle of the ink-in shows the inked art at once", async () => {
  const t = themeByName("brothy")
  setup = quietAct(await testRender(<App root={tmp({ "notes.txt": "" })} motion />, WELCOME))
  await setup.renderOnce()
  const s = setup
  await keys(s, "x")
  expect(hex(spansOf(s).find((x) => x.text.includes("┏┓"))!.fg)).toBe(t.primary)
})

test("welcome at 60 columns: recent rows stay inside the measure and the hint lines up with them", async () => {
  const p = tmp({ "x.md": "# X\n" })
  seedProjects([{ root: p, at: Date.now() }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { width: 60, height: 24 })
  const rows = (await keys(s)).split("\n")
  const head = rows.findIndex((r) => /Recent\s+1/.test(r))
  const y = head + 1
  expect(rows.find((r) => r.includes("⏎ open"))!.indexOf("⏎")).toBe(rows[head]!.indexOf("Recent"))
  const fill = s.captureSpans().lines[y]!.spans.filter((sp) => hex(sp.bg) === PRIMARY).reduce((n, sp) => n + sp.text.length, 0)
  expect(fill).toBeLessThanOrEqual(54) // the measure at 60 columns
})

for (const width of [80, 100, 120])
  test(`welcome: the highlighted recent row is as wide as the centred block at ${width} columns`, async () => {
    seedProjects([{ root: tmp({ "x.md": "# X\n" }), at: Date.now() }])
    const s = await mount(tmp({ "notes.txt": "" }), undefined, { width, height: 34 })
    const rows = (await keys(s)).split("\n")
    const y = rows.findIndex((r) => /Recent\s+1/.test(r)) + 1
    const cells = s.captureSpans().lines[y]!.spans.reduce<{ x: number; on: boolean }[]>((a, sp) => {
      for (const _ of sp.text) a.push({ x: a.length, on: hex(sp.bg) === PRIMARY })
      return a
    }, [])
    const on = cells.filter((c) => c.on).map((c) => c.x)
    const [l, r] = [Math.min(...on), width - 1 - Math.max(...on)]
    expect(on.length).toBeLessThanOrEqual(58)
    expect(Math.abs(l - r)).toBeLessThanOrEqual(1)
  })

/** Left and right blank margins of the first row matching `re` (by code point). */
function margins(row: string, W: number, re: RegExp) {
  const cells = [...row]
  const first = cells.findIndex((c) => re.test(c))
  let last = cells.length - 1
  while (last >= 0 && !re.test(cells[last]!)) last--
  return [first, W - 1 - last]
}

test("welcome: full width and centred, no panel and no footer hints; a note brings the panel back, the saved sidebar untouched", async () => {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), JSON.stringify({ sidebar: { view: "outline", hidden: false } }))
  const other = tmp({ "x.md": "# Xylophone\n" })
  seedProjects([{ root: other, at: Date.now() }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, WELCOME)
  // the panel keys do nothing here: nothing to show, and nothing saved
  const f = await keys(s, "C-b", "2", "tab")
  const rows = f.split("\n")
  expect(f).not.toMatch(/Files|Outline|Info/)
  const [l, r] = margins(rows.find((x) => x.includes("▗▄"))!, WELCOME.width, /[▗▄▖]/)
  expect(Math.abs(l - r)).toBeLessThanOrEqual(1)
  const [rl, rr] = margins(rows[1]!, WELCOME.width, /─/) // the top-row rule spans the centred text column
  expect(Math.abs(rl - rr)).toBeLessThanOrEqual(1)
  expect(rows[WELCOME.height - 2]!.trim()).toBe("") // no footer hints
  expect(f).not.toContain("j k scroll")
  expect(f).toContain(" o  open a project")
  expect(savedConfig().sidebar).toEqual({ view: "outline", hidden: false })
  await keys(s, "enter")
  const g = await waitFrame(s, (x) => x.includes("Xylophone"))
  expect(g).toContain("²Outline")
  expect(savedConfig().sidebar).toEqual({ view: "outline", hidden: false })
})

test("welcome: a, z, Z, s and w do nothing there (no zen, no hidden Source, no panel, nothing saved); the next note opens as usual", async () => {
  const other = tmp({ "x.md": "# Xylophone\n\n## Part\n\nbody\n" })
  seedProjects([{ root: other, at: Date.now() }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, WELCOME)
  const before = s.captureCharFrame()
  expect(await keys(s, "a", "z", "Z", "s", "w")).toBe(before)
  expect(existsSync(join(cfgDir, "brothy", "config.json"))).toBe(false)
  await keys(s, "enter")
  const g = await waitFrame(s, (x) => x.includes("Xylophone"))
  expect(g).not.toContain("# Xylophone") // Preview, not Source
  expect(g).toContain("¹Files") // not zen
})

test("welcome at 80×24: no drawer and no scrim, the bowl centred across the screen", async () => {
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { width: 80, height: 24 })
  const f = await keys(s, "1")
  expect(f).not.toContain("▏")
  expect(f).not.toMatch(/Files|Outline|Info/)
  const [l, r] = margins(f.split("\n").find((x) => x.includes("▗▄"))!, 80, /[▗▄▖]/)
  expect(Math.abs(l - r)).toBeLessThanOrEqual(1)
})

// ------------------------------------------------------------- minimap

const BRAILLE = /[⠁-⣿]/
/** the two braille cells at the right edge (the lane is the last column) */
const miniCol = (f: string, W: number) => f.split("\n").map((r) => [...r].slice(W - 3, W - 1).join(""))
const laneCol = (f: string, W: number) => f.split("\n").map((r) => [...r][W - 1] ?? "")
const LONG_NOTE = "# Top\n\n" + Array.from({ length: 12 }, (_, i) => `## Part ${i}\n\n${"lorem ipsum dolor sit amet ".repeat(6)}\n`).join("\n")

test("minimap: on at 120 columns, braille at the right edge, headings in primary, the text column unmoved", async () => {
  const t = themeByName("brothy")
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { width: 120, height: 34 })
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
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { width: 120, height: 34 })
  expect(miniCol(await keys(s, "s"), 120).some((c) => BRAILLE.test(c))).toBe(true)
  setup!.renderer.destroy()
  setup = undefined
  // text only at the far right of each line: the left cell stays empty
  const s2 = await mount(tmp({ "b.md": Array.from({ length: 40 }, () => " ".repeat(70) + "x").join("\n") }), "b.md", { width: 120, height: 34 })
  const f = await keys(s2, "s")
  expect(f.split("\n").map((r) => [...r].slice(117, 119).join("")).some((c) => c[1] && BRAILLE.test(c[1]))).toBe(true)
  expect(f.split("\n").some((r) => BRAILLE.test([...r][117] ?? ""))).toBe(false)
})

test("minimap: hidden below 110 columns and in zen", async () => {
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { width: 109, height: 34 })
  expect(miniCol(await keys(s), 109).some((c) => BRAILLE.test(c))).toBe(false)
  s.resize(120, 34)
  expect(miniCol(await keys(s), 120).some((c) => BRAILLE.test(c))).toBe(true)
  expect(miniCol(await keys(s, "z"), 120).some((c) => BRAILLE.test(c))).toBe(false)
})

test("m hides the minimap, saves minimap:false, and a remount keeps it hidden", async () => {
  const d = tmp({ "a.md": LONG_NOTE })
  const s = await mount(d, "a.md", { width: 120, height: 34 })
  const f = await keys(s, "m")
  expect(f).toContain("minimap off")
  expect(miniCol(f, 120).some((c) => BRAILLE.test(c))).toBe(false)
  expect(JSON.parse(readFileSync(join(cfgDir, "brothy", "config.json"), "utf8")).minimap).toBe(false)
  setup!.renderer.destroy()
  setup = undefined
  const s2 = await mount(d, "a.md", { width: 120, height: 34 })
  expect(miniCol(await keys(s2), 120).some((c) => BRAILLE.test(c))).toBe(false)
  expect(await keys(s2, "m")).toContain("minimap on")
})

test("m below 110 columns says the minimap needs 110 columns and leaves the setting alone", async () => {
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { width: 100, height: 30 })
  expect(await keys(s, "m")).toContain("minimap needs 110 columns")
  s.resize(120, 34)
  expect(miniCol(await keys(s), 120).some((c) => BRAILLE.test(c))).toBe(true)
})

test("minimap: during a find the lane marks the match lines in secondary", async () => {
  const t = themeByName("brothy")
  const s = await mount(tmp({ "a.md": LONG_NOTE + "\n\nneedle here\n" }), "a.md", { width: 120, height: 34 })
  const f = await keys(s, "/", "type:needle", "enter")
  expect(laneCol(f, 120).some((c) => BRAILLE.test(c))).toBe(true)
  expect(spansOf(s).some((sp) => BRAILLE.test(sp.text) && hex(sp.fg) === t.secondary)).toBe(true)
})

test("minimap: a click scrolls to that part of the note", async () => {
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { width: 120, height: 34 })
  const before = await keys(s)
  const rows = before.split("\n")
  const last = rows.map((r, y) => (BRAILLE.test([...r].slice(117, 119).join("")) ? y : -1)).filter((y) => y >= 0).at(-1)!
  await s.mockMouse.click(117, last)
  const after = await keys(s)
  expect(after).toContain("Part 11")
  expect(after).not.toBe(before)
})

test("minimap: narrowing from 120 to 105 columns hides it and keeps the reading position", async () => {
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { width: 120, height: 34 })
  await keys(s, "]", "]", "]", "]", "]", "]")
  expect(await keys(s)).toContain("Part 5")
  s.resize(105, 34)
  const f = await keys(s)
  expect(miniCol(f, 105).some((c) => BRAILLE.test(c))).toBe(false)
  expect(f).toContain("Part 5")
})

test("minimap with T: off-screen cells unpainted, the band keeps backgroundElement", async () => {
  const t = themeByName("brothy")
  const s = await mount(tmp({ "a.md": LONG_NOTE }), "a.md", { width: 120, height: 34 })
  await keys(s, "T")
  const mini = spansOf(s).filter((sp) => BRAILLE.test(sp.text))
  expect(mini.some((sp) => hex(sp.bg) === t.backgroundElement)).toBe(true)
  expect(mini.some((sp) => hex(sp.bg) === null)).toBe(true)
})

// ------------------------------------------------------------- C-p peek pane

test("C-p at 120 columns peeks at the highlighted note, with its fresh TL;DR and no AI request", async () => {
  const d = tmp({ "a.md": "# Alpha\n", "notes/beta.md": "# Beta notes\n\nPeek body line.\n\n## Part\n\nmore\n" })
  aiConfig(OLLAMA)
  seedSummary(join(d, "notes/beta.md"), "Beta is about peeking.")
  let calls = 0
  const s = await mount(d, "a.md", { width: 120, height: 34 }, (async () => (calls++, new Response(""))) as unknown as typeof fetch)
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
  const s = await mount(d, "a.md", { width: 120, height: 34 })
  await keys(s, "C-p", "type:gamma")
  const f = await waitFrame(s, (x) => x.includes("Under the heading."))
  expect(f).toContain("Under the heading.")
  expect(f).not.toContain("Stale words.")
  expect(f).not.toContain("TL;DR")
  expect(f).not.toContain("Intro.")
})

test("C-p below 100 columns has no peek pane", async () => {
  const d = tmp({ "a.md": "# Alpha\n", "beta.md": "# Beta\n\nPlain words here.\n" })
  const s = await mount(d, "a.md", { width: 90, height: 30 })
  const f = await keys(s, "C-p", "type:beta")
  await sleep(100)
  expect(await keys(s)).not.toContain("Plain words here.")
  expect(f).toContain("Go to")
})
