// App: the welcome page.
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { MINI_W } from "../../src/ui/minimap"
import { themeByName } from "../../src/theme/theme"
import { keys, onBg, PRIMARY, sleep, spansOf, waitFor, waitFrame, useAppHarness } from "./helpers"
import { hex } from "../helpers/theme"

const { cfgDir, tmp, mount, savedConfig, seedProjects } = useAppHarness()

const WELCOME = { width: 120, height: 34 }

/** Left and right blank margins of the first row matching `re` (by code point). */
function margins(row: string, W: number, re: RegExp): [number, number] {
  const cells = [...row]
  const first = cells.findIndex((c) => re.test(c))
  let last = cells.length - 1
  while (last >= 0 && !re.test(cells[last]!)) last--
  return [first, W - 1 - last]
}

test("welcome: the wordmark over a bowl, today's message, keycaps, recent projects and the hint", async () => {
  const t = themeByName("brothy")
  const other = tmp({ "x.md": "# X\n" })
  // three recents, as in v3's frame
  seedProjects([
    { root: other, at: Date.now() - 3600_000, lastNote: join(other, "x.md") },
    { root: tmp({}), at: 2 },
    { root: tmp({}), at: 1 },
  ])
  const empty = tmp({ "notes.txt": "" })
  const s = await mount(empty, undefined, { size: WELCOME })
  const f = await keys(s)
  const rows = f.split("\n")
  expect(f).toContain("▄▄▄▄  ▄▄▄▄   ▄▄▄ ▄▄▄▄▄▄ ▄▄ ▄▄ ▄▄ ▄▄")
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
  expect(rows[4]).toContain("▄▄▄▄  ▄▄▄▄")
  expect(rows[12]).toContain("▗▄▄")
  expect(rows[20]).toContain("No Markdown files")
  expect(rows[22]).toContain("open a project")
  const sp = spansOf(s)
  const cap = sp.find((x) => x.text.includes(" o "))!
  expect([hex(cap.fg), hex(cap.bg)]).toEqual([t.accent, t.backgroundElement])
  expect(hex(sp.find((x) => x.text.includes("▄▄▄▄"))!.fg)).toBe(t.primary)
  expect(hex(sp.find((x) => x.text.includes("▗"))!.fg)).toBe(t.text) // rim
  expect(sp.some((x) => x.text.includes("▄") && hex(x.bg) === t.secondary)).toBe(true) // broth
  expect(hex(sp.find((x) => x.text.includes("████"))!.fg)).toBe(t.primary) // body
  expect(onBg(s, t.primary).join("")).toContain(basename(other)) // first row selected at rest
})

test("welcome: no recent projects leaves out the list, the hint stays", async () => {
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: WELCOME })
  const f = await keys(s)
  expect(f).not.toContain("Recent")
  expect(f).toContain("o all projects or a path")
  expect(f).not.toContain("⏎ open")
})

test("welcome at 80×24: the small bowl, no chopsticks, v3's rows", async () => {
  seedProjects([
    { root: tmp({}), at: 3 },
    { root: tmp({}), at: 2 },
    { root: tmp({}), at: 1 },
  ])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: { width: 80, height: 24 } })
  const rows = (await keys(s)).split("\n")
  expect(rows[2]).toContain("▄▄▄▄  ▄▄▄▄")
  expect(rows[7]).toContain("▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖")
  expect(rows.join("\n")).not.toContain("▞")
  expect(rows[12]).toContain("No Markdown files")
  expect(rows[14]).toContain("open a project")
})

test("welcome: a click on a recent project opens it", async () => {
  const other = tmp({ "x.md": "# Xylophone\n" })
  seedProjects([{ root: other, at: Date.now() }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: WELCOME })
  const rows = (await keys(s)).split("\n")
  const y = rows.findIndex((r) => r.includes(basename(other)) && !r.includes("No Markdown"))
  await s.mockMouse.click(rows[y]!.indexOf(basename(other)), y)
  expect(await waitFrame(s, (f) => f.includes("Xylophone"))).toContain("Xylophone")
})

test("welcome: ↑ ↓ move the selection and ⏎ opens it; pointing moves it too", async () => {
  const a = tmp({ "a.md": "# Alpha note\n" })
  const b = tmp({ "b.md": "# Bravo note\n" })
  seedProjects([
    { root: a, at: Date.now() },
    { root: b, at: Date.now() - 1000 },
  ])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: WELCOME })
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
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: WELCOME })
  const f = await keys(s)
  expect(f).toContain("missing")
  const after = await keys(s, "enter")
  expect(after).toContain("is gone")
  expect(after).not.toContain("Recent")
})

test("welcome with motion: the wordmark and bowl ink in from border; the steam rises until a key stops it for good", async () => {
  const t = themeByName("brothy")
  const d = tmp({ "notes.txt": "" })
  const s = await mount(d, undefined, { size: WELCOME, motion: true })
  const markFg = () => hex(spansOf(s).find((x) => x.text.includes("▄▄▄▄"))!.fg)
  expect(markFg()).toBe(t.border)
  const steam = () =>
    s
      .captureCharFrame()
      .split("\n")
      .slice(7, 12)
      .map((r) => r.replace(/▞/g, " "))
      .join("\n")
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
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: WELCOME })
  const a = await keys(s)
  expect(hex(spansOf(s).find((x) => x.text.includes("▄▄▄▄"))!.fg)).toBe(t.primary)
  expect(a).toMatch(/[⠁-⣿]/)
  await sleep(350)
  await s.renderOnce()
  expect(s.captureCharFrame()).toBe(a)
})

test("welcome with motion: a resize stops the steam for good, and so does opening a note", async () => {
  const other = tmp({ "x.md": "# Xylophone\n" })
  seedProjects([{ root: other, at: Date.now() }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: WELCOME, motion: true })
  const steam = () =>
    s
      .captureCharFrame()
      .split("\n")
      .filter((r) => /[⠁-⣿]/.test(r))
      .join("\n")
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
  expect(
    opened
      .split("\n")
      .map((r) => [...r].slice(0, 118 - MINI_W).join(""))
      .join("\n"),
  ).not.toMatch(/[⠁-⣿]/) // the minimap keeps its braille
})

test("welcome keys act only on the rows on screen: none listed, ⏎ opens nothing; a short list stops at its last row", async () => {
  const ps = Array.from({ length: 5 }, (_, i) => tmp({ "n.md": `# Project ${i}\n` }))
  seedProjects(ps.map((root, i) => ({ root, at: 10 - i })))
  const tiny = await mount(tmp({ "notes.txt": "" }), undefined, { size: { width: 60, height: 16 } })
  expect(await keys(tiny)).not.toContain("Recent")
  expect(await keys(tiny, "enter")).not.toContain("Project 0")
  tiny.renderer.destroy()
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: { width: 100, height: 20 } })
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
  const s = await mount(a, undefined, { size: WELCOME })
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
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: WELCOME, motion: true })
  await keys(s, "x")
  expect(hex(spansOf(s).find((x) => x.text.includes("▄▄▄▄"))!.fg)).toBe(t.primary)
})

test("welcome at 60 columns: recent rows stay inside the measure and the hint lines up with them", async () => {
  const p = tmp({ "x.md": "# X\n" })
  seedProjects([{ root: p, at: Date.now() }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: { width: 60, height: 24 } })
  const rows = (await keys(s)).split("\n")
  const head = rows.findIndex((r) => /Recent\s+1/.test(r))
  const y = head + 1
  expect(rows.find((r) => r.includes("⏎ open"))!.indexOf("⏎")).toBe(rows[head]!.indexOf("Recent"))
  const fill = s
    .captureSpans()
    .lines[y]!.spans.filter((sp) => hex(sp.bg) === PRIMARY)
    .reduce((n, sp) => n + sp.text.length, 0)
  expect(fill).toBeLessThanOrEqual(54) // the measure at 60 columns
})

for (const width of [80, 100, 120])
  test(`welcome: the highlighted recent row is as wide as the centred block at ${width} columns`, async () => {
    seedProjects([{ root: tmp({ "x.md": "# X\n" }), at: Date.now() }])
    const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: { width, height: 34 } })
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

test("welcome: full width and centred, no panel and no footer hints; a note brings the panel back, the saved sidebar untouched", async () => {
  mkdirSync(join(cfgDir, "brothy"), { recursive: true })
  writeFileSync(join(cfgDir, "brothy", "config.json"), JSON.stringify({ sidebar: { view: "outline", hidden: false } }))
  const other = tmp({ "x.md": "# Xylophone\n" })
  seedProjects([{ root: other, at: Date.now() }])
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: WELCOME })
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
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: WELCOME })
  const before = s.captureCharFrame()
  expect(await keys(s, "a", "z", "Z", "s", "w")).toBe(before)
  expect(existsSync(join(cfgDir, "brothy", "config.json"))).toBe(false)
  await keys(s, "enter")
  const g = await waitFrame(s, (x) => x.includes("Xylophone"))
  expect(g).not.toContain("# Xylophone") // Preview, not Source
  expect(g).toContain("¹Files") // not zen
})

test("welcome at 80×24: no drawer and no scrim, the bowl centred across the screen", async () => {
  const s = await mount(tmp({ "notes.txt": "" }), undefined, { size: { width: 80, height: 24 } })
  const f = await keys(s, "1")
  expect(f).not.toContain("▏")
  expect(f).not.toMatch(/Files|Outline|Info/)
  const [l, r] = margins(f.split("\n").find((x) => x.includes("▗▄"))!, 80, /[▗▄▖]/)
  expect(Math.abs(l - r)).toBeLessThanOrEqual(1)
})
