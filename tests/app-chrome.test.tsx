// App: hints, the help sheet, toasts, the top line and popup chrome.
import { expect, test } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GHOST_STEP, HINT_HOLD } from "../src/zen"
import { type Setup, B, hex, HINT_ROW, keys, numbered, openHelp, PRIMARY, sections, spansOf, waitFor, waitFrame, withClock, useAppHarness } from "./helpers/app"

const { tmp, mount, unmount, projectsFile, readProjects } = useAppHarness()

const PAST_HINTS = () => new Date(Date.now() + HINT_HOLD + 4 * GHOST_STEP + 10)

/** C0 (but newline), DEL and C1: nothing a hostile note or file name holds may reach the terminal raw. */
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/
const clean = (s: Setup) => {
  expect(s.captureCharFrame()).not.toMatch(CONTROL)
  for (const l of s.captureSpans().lines) for (const sp of l.spans) expect(sp.text).not.toMatch(CONTROL)
}

/** 100x30: panel SW 27, text starts at column 1 + 27 + 1 + 2 = 31 and is 66 wide. */
const TEXT_L = 31
const TEXT_R = 97

/** Row 0 with the (astral, two UTF-16 units) logo swapped for one unit, so string indexes equal columns. */
const head = (f: string) => f.split("\n")[0]!.replace("󰘗", "L")

/** fg of the first span on row 0 containing `text`. */
const row0Fg = (s: Setup, text: string) => hex(s.captureSpans().lines[0]!.spans.find((sp) => sp.text.includes(text))!.fg)

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

test("hints appear after tab and are gone after HINT_HOLD and the fade", async () => {
  const s = await mount(tmp({ "a.md": sections(2) }), "a.md")
  expect((await keys(s, "tab")).split("\n")[HINT_ROW]).toContain("tab document")
  await withClock(PAST_HINTS(), async () => {
    expect((await keys(s, "k")).split("\n")[HINT_ROW]!.trim()).toBe("") // k at the top: a no-op that renders
  })
})

test("? ? at 120 columns: five chip groups in two columns, Global and Panel left; j scrolls both", async () => {
  const s = await mount(tmp({ "a.md": "# A\n" }), "a.md", { size: { width: 120, height: 30 } })
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
  const s = await mount(tmp({ "a.md": "# A\n" }), "a.md", { size: { width: 90, height: 120 } })
  const rows = (await openHelp(s)).split("\n")
  const at = (g: string) => rows.findIndex((r) => r.trim() === g)
  const order = ["Global", "Document", "Zen", "Panel", "AI"].map(at)
  expect(order.every((y) => y > 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(rows[at("Global")]).not.toContain("Document")
})

test("? shows the hints first; a second ? opens the Keybindings popup", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md")
  await withClock(PAST_HINTS(), async () => { // let the startup hints go
    const f = await keys(s, "?")
    expect(f).not.toContain("Keybindings")
    expect(f.split("\n")[HINT_ROW]).toContain("? keys")
    expect(await keys(s, "?")).toContain("Keybindings")
  })
})

test("n without a query is an error toast in the error color; ok toasts don't replace it; esc dismisses it", async () => {
  const s = await mount(tmp({ "a.md": "# a" }), "a.md")
  expect((await keys(s, "n")).split("\n")[HINT_ROW]).toContain("✗ nothing to find · / to search")
  expect(spansOf(s).some((sp) => sp.text.includes("✗") && hex(sp.fg) === B.error)).toBe(true)
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

test("󰘗 sits at column 0 of row 0", async () => {
  const f = await keys(await mount(tmp({ "a.md": "# a" }), "a.md"))
  expect(Array.from(f.split("\n")[0]!)[0]).toBe("󰘗")
})

test("󰘗 is muted while watching, primary after a live reload, muted again after a second; absent when the file is gone", async () => {
  const root = tmp({ "a.md": "# one" })
  const s = await mount(root, "a.md")
  expect(row0Fg(s, "󰘗")).toBe(B.textMuted)
  writeFileSync(join(root, "a.md"), "# two")
  await waitFrame(s, (f) => f.includes("two"))
  expect(row0Fg(s, "󰘗")).toBe(PRIMARY)
  await waitFor(s, () => row0Fg(s, "󰘗") === B.textMuted)
  rmSync(join(root, "a.md"))
  await waitFrame(s, (f) => Array.from(f.split("\n")[0]!)[0] !== "󰘗")
})

test("a deep folder is shrunk first / … / last over the panel; a short one is shown in full", async () => {
  const deep = "alpha/bravo/charlie/delta/echo"
  const s = await mount(tmp({ [deep + "/n.md"]: "# n", "x/y/m.md": "# m" }), deep + "/n.md", { size: { width: 120, height: 32 } })
  expect((await keys(s)).split("\n")[0]).toMatch(/^󰘗 alpha \/ … \/ echo\s/)
  const t = await mount(tmp({ "x/y/m.md": "# m" }), "x/y/m.md", { size: { width: 120, height: 32 } })
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
  expect(row0Fg(s, "Calm")).toBe(B.textMuted)
  await keys(s, "space", "space", "space")
  expect(row0Fg(s, "Calm")).toBe(B.text)
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
  const wide = head(await keys(await mount(tmp(short), "notes/a.md", { size: { width: 80, height: 24 } }), "]"))
  expect(wide).toMatch(/^L +notes \/ a › t › A long section heading/)
  unmount()
  const body = { "notes/a-fairly-long-note-title-for-a-narrow-screen-so-it-must-be-cut.md": "# t\n\n## A long section heading\n\n" + "text\n\n".repeat(40) }
  const key = Object.keys(body)[0]!
  const f = head(await keys(await mount(tmp(body), key, { size: { width: 60, height: 14 } }), "]"))
  expect(f.length).toBeLessThanOrEqual(60)
  expect(f[0]).toBe("L")
  expect(f).toContain("…")
})

test("zen: 󰘗 rides the top line and fades with it", async () => {
  const s = await mount(tmp({ "a.md": sections(3) }), "a.md")
  expect(Array.from((await keys(s, "z")).split("\n")[0]!)[0]).toBe("󰘗")
  await waitFrame(s, (f) => f.split("\n")[0]!.trim() === "", 5000)
})

test("popups leave the footer hint row and progress line visible", async () => {
  const root = tmp({ "a.md": "# Alpha\n\nbody\n", "b.md": "# Beta\n" })
  for (const [width, height] of [[100, 30], [100, 20], [60, 14]] as const) {
    for (const k of [["t"], ["?"], ["C-p"], ["o"], ["/"]]) {
      const s = await mount(root, "a.md", { size: { width, height } })
      const f = await keys(s, ...k)
      const rows = f.split("\n")
      expect(rows[height - 2]!.trim(), `${k} at ${width}x${height}`).toMatch(/esc|open/) // the hint row, not popup rows
      s.renderer.destroy()
    }
  }
})

test("help title never wraps: the theme name goes first at 60x14", async () => {
  const s = await mount(tmp({ "a.md": "# Alpha\n" }), "a.md", { size: { width: 60, height: 14 } })
  await keys(s, "t", "type:catp", "tab", "enter") // catppuccin-light, the longest name
  const f = await openHelp(s)
  const rows = f.split("\n")
  expect(rows.filter((r) => r.includes("Keybindings")).length).toBe(1)
  expect(rows.findIndex((r) => r.includes("Keybindings"))).toBeGreaterThan(0)
  expect(rows[12]!).toContain("esc") // footer hint row stays
})

test("find rows show a match near the line end", async () => {
  const long = "word ".repeat(12) + "zebra"
  const s = await mount(tmp({ "a.md": `# T\n\n\`\`\`\n${long}\n\`\`\`\n` }), "a.md", { size: { width: 80, height: 24 } })
  const f = await keys(s, "/", "type:zebra")
  expect(f.split("\n").filter((r) => r.includes("zebra") && r.includes("…")).length).toBeGreaterThan(0)
})

test("too-small screen keeps the requirement and never wraps mid-word", async () => {
  for (const [width, height] of [[10, 3], [20, 5], [40, 10]] as const) {
    const s = await mount(tmp({ "a.md": "# Alpha\n" }), "a.md", { size: { width, height } })
    const text = s.captureCharFrame().split("\n").map((r) => r.trim()).filter(Boolean).join(" ")
    expect(text).toContain("60×14")
    expect(text).not.toMatch(/\bneed\b.*\bne\b/)
    s.renderer.destroy()
  }
})

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
