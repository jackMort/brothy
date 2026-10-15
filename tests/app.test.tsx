import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { quietAct } from "./quiet-act"

// keep the theme picker from touching the real ~/.config
const prevXdg = process.env.XDG_CONFIG_HOME
const cfgDir = mkdtempSync(join(tmpdir(), "brothy-cfg-"))
process.env.XDG_CONFIG_HOME = cfgDir
afterAll(async () => {
  await shutdownHighlighter() // the parser worker would otherwise keep the process alive
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevXdg
  rmSync(cfgDir, { recursive: true, force: true })
})
const { App } = await import("../src/App")
const { shutdownHighlighter } = await import("../src/highlight")
import { mix, themeByName } from "../src/theme"
import { GHOST_STEP, HINT_HOLD } from "../src/zen"

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
const dirs: string[] = []
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Render until `pred` holds. App timers (OPEN_DELAY, fades, the teleprompter) run late under load: wait, don't sleep. */
async function waitFor(s: Setup, pred: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    await s.renderOnce()
    if (pred()) return
  }
  throw new Error("never matched:\n" + s.captureCharFrame())
}
const waitFrame = (s: Setup, pred: (f: string) => boolean, ms = 2000) => waitFor(s, () => pred(s.captureCharFrame()), ms)

async function mount(root: string, file?: string, size = { width: 100, height: 30 }) {
  setup = quietAct(await testRender(<App root={root} initialFile={file ? join(root, file) : undefined} />, size))
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

/** The panel's tab strip is on screen (compact `Files  Outline` or full `Files   2 Outline`). */
const panelShown = (f: string) => /Files\s+(?:2 )?Outline/.test(f)

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

test("theme picker lists dark themes then light ones, tagged, and scrolls inside a short terminal", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md", { width: 100, height: 24 })
  const f = await keys(s, "t")
  expect(f).toContain("Themes")
  expect(f).toMatch(/brothy\s+.*\bcurrent\b/)
  expect(f).toMatch(/catppuccin\s+.*\bdark\b/)
  expect(f).not.toContain("flexoki-light")
  const g = await keys(s, "G")
  expect(g).toMatch(/flexoki-light\s+.*\blight\b/)
  expect(g).not.toMatch(/\bcatppuccin\s/)
  expect(g.trimEnd().split("\n")).toHaveLength(24)
  await keys(s, "esc")
  expect(await openHelp(s)).toMatch(/brothy v\d+\.\d+\.\d+ · brothy/)
})

test("picking a light theme applies it", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md")
  const f = await keys(s, "t", "G", "enter")
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
  const y = rows.findIndex((l) => /Files\s+Outline/.test(l))
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
  const rows = (await keys(s)).split("\n").filter((l) => l.includes("lorem"))
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
  expect(f).toContain("show Files · Outline · Info")
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
  const first = f.split("\n").find((l) => l.includes("lorem"))!
  const left = first.search(/lorem/)
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
  const rows = f.split("\n").filter((l) => l.includes("lorem"))
  expect(Math.max(...rows.map((r) => r.trimEnd().length - r.search(/lorem|ipsum|dolor/)))).toBeGreaterThan(100)
  for (const r of rows) expect(r.trimEnd().length).toBeLessThanOrEqual(160 - 2)
  expect(savedConfig().wide).toBe(true)
  const back = await keys(s, "w")
  for (const r of back.split("\n").filter((l) => l.includes("lorem"))) expect(r.trimEnd().length - r.search(/lorem|ipsum|dolor/)).toBeLessThanOrEqual(80)
  expect(savedConfig().wide).toBe(false)
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

test("t in zen previews themes; esc reverts the theme and stays in zen", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  expect(await keys(s, "z", "t")).toContain("Themes")
  const f = await keys(s, "j", "esc")
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
  expect(await keys(s, "tab")).toContain("Files  Outline  Info")
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

test("a folder without Markdown: Files says so and tab still focuses the panel", async () => {
  const f = await keys(await mount(tmp({ "x.txt": "" })), "tab")
  expect(f).toContain("no Markdown files here")
  expect(f).toContain("tab document")
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
  const s = await mount(tmp({ "a.md": "# a" }), "gone\x1b]0;X\x07.md")
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
  await keys(s, "C-p", "type:dee", "enter")
  expect((await keys(s, "H")).split("\n")[HINT_ROW]).toContain("back · b")
})

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
  await keys(s, "t")
  for (let i = 0; i < 40 && !(await keys(s, "down")).includes("catppuccin-light ")  ; i++);
  await keys(s, "enter")
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
  for (const k of [["w"], ["T"], ["C-b"], ["2"], ["t", "j", "enter"], ["z", "<"], ["z", "+"], ["Z", "j", "space", "enter"]]) {
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
