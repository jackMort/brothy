// App: find, the Outline cursor, the Files filter, rescans and live reload.
import { expect, test } from "bun:test"
import { renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { keys, numbered, onBg, openHelp, sections, sleep, topLine, useAppHarness, waitFrame } from "./helpers"

const { tmp, mount } = useAppHarness()

const pocs = () =>
  tmp({
    "other.md": "# other",
    "poc notes.md": "# poc",
    "Proof of concept.md": "# proof",
    "deep/pocket.md": "# pocket",
  })

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

test("filter: ⌫ erases a whole character, never half of an emoji", async () => {
  const s0 = await mount(pocs(), "other.md")
  expect(await keys(s0, "tab", "/", "type:a", "😀")).toContain("/ a😀▏") // typeText splits the pair, so the emoji is one key
  const f = await keys(s0, "backspace")
  expect(f).toContain("/ a▏")
  expect(f).not.toContain("\uFFFD")
})

test("find: ⌫ erases a whole character, never half of an emoji", async () => {
  const f = await keys(await mount(pocs(), "other.md"), "/", "type:a", "😀", "backspace")
  expect(f).toContain("a▏")
  expect(f).not.toContain("\uFFFD")
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
  }
})

test("a click in the document ends filter typing; the filter text stays", async () => {
  const s = await mount(pocs(), "other.md", { size: { width: 120, height: 30 } })
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
  const root = tmp({ "a.md": "plain\n" })
  const s = await mount(root, "a.md")
  await keys(s, "2", "j")
  writeFileSync(join(root, "a.md"), sections(2))
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
