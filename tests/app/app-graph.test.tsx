// App: the Graph sheet on ^g: open, move, walk and back, open a note, close.
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { setRendererCapabilities } from "@opentui/core/testing"
import { hubFiles, KITCHEN } from "../helpers/vault"
import { keys, panelShown, useAppHarness, waitFrame, withClock } from "./helpers"

const { tmp, mount, writeConfig, savedConfig, configFile } = useAppHarness()

const SIZE = { width: 120, height: 34 }
/** The popup at 120 columns: 108 wide, 6 in. */
const POPUP_X = 6
const HINT_ROW = 32

/** The sheet's rows from its title row down, cut to the popup, trailing blanks dropped; null while closed. */
const sheet = (f: string) => {
  const rows = f.split("\n")
  const top = rows.findIndex((r) => r.includes("Graph · "))
  return top < 0 ? null : rows.slice(top, top + 30).map((r) => r.slice(POPUP_X, POPUP_X + 108).trimEnd())
}
/** The list column: the text right of the last │ on each row that has one, blank ones dropped. */
const listRows = (f: string) =>
  (sheet(f) ?? [])
    .filter((r) => r.includes("│"))
    .map((r) => r.slice(r.lastIndexOf("│") + 1).trim())
    .filter(Boolean)
/** The picture column: the text left of the last │ on each sheet row. */
const pictureRows = (f: string) =>
  (sheet(f) ?? []).filter((r) => r.includes("│")).map((r) => r.slice(0, r.lastIndexOf("│")))
const BRAILLE = /[⠁-⣿]/
const barRow = (f: string) => listRows(f).find((r) => r.startsWith("▌"))

/** KITCHEN mounted on `file` with ^g pressed, once `ready` holds (by default: the index has landed and the bottom line counts the notes). */
async function opened(file = "Broth.md", size = SIZE, ready = (f: string) => f.includes("of 6 notes")) {
  const d = tmp(KITCHEN)
  const s = await mount(d, file, { size })
  await keys(s, "C-g")
  await waitFrame(s, ready, 4000)
  return { d, s }
}

test("^g opens Graph on the note: the counts by the title, neighbours listed, depth-2 notes under theirs", async () => {
  const { s } = await opened()
  const f = s.captureCharFrame()
  expect(sheet(f)![0]).toMatch(/Graph · Broth\s+← 2 · → 2 · 1 unresolved · depth 2\s+esc$/)
  expect(listRows(f)).toEqual([
    "▌↔ Stock",
    "→ Bones",
    "← Garnish",
    "→ Simmering",
    "→ Nowhere",
    "depth 2 · 5 of 6 notes",
  ])
  const picture = sheet(f)!
    .filter((r) => r.includes("│"))
    .map((r) => r.slice(0, r.lastIndexOf("│")))
  expect(picture.join("\n")).toContain("Broth")
  expect(picture.join("\n")).toMatch(/[⠁-⣿]/)
  expect(f.split("\n")[HINT_ROW]).toMatch(
    /↑↓ neighbour {3}⏎ open {3}l centre {3}h back {3}\+ - depth {3}p pixels {3}\/ filter {3}esc close/,
  )
})

test("↑↓ j k move over notes only: the unresolved row is passed over and the end holds", async () => {
  const { s } = await opened()
  expect(barRow(await keys(s, "j", "j", "j"))).toBe("▌→ Simmering")
  expect(barRow(await keys(s, "j"))).toBe("▌→ Simmering")
  expect(barRow(await keys(s, "k"))).toBe("▌← Garnish")
  expect(barRow(await keys(s, "up"))).toBe("▌  → Bones") // a depth-2 row keeps its indent
})

test("l centres on the focused note; h comes back with the focus on the note just left", async () => {
  const { s } = await opened()
  let f = await keys(s, "j", "j", "l")
  expect(sheet(f)![0]).toContain("Graph · Garnish")
  expect(listRows(f).slice(0, 3)).toEqual(["▌→ Broth", "↔ Stock", "→ Simmering"])
  f = await keys(s, "h")
  expect(sheet(f)![0]).toContain("Graph · Broth")
  expect(barRow(f)).toBe("▌← Garnish")
})

test("⏎ opens the focused note and closes the sheet; H comes back to the note before", async () => {
  const { s } = await opened()
  let f = await keys(s, "j", "j", "j", "enter")
  expect(sheet(f)).toBeNull()
  expect(f.split("\n")[0]).toContain("Simmering")
  f = await keys(s, "H")
  expect(f.split("\n")[0]).toContain("Broth")
})

test("esc closes; a note with no links says so", async () => {
  const { s } = await opened("Lonely.md")
  const f = s.captureCharFrame()
  expect(sheet(f)![0]).toMatch(/Graph · Lonely\s+← 0 · → 0 · depth 2/)
  expect(listRows(f)).toEqual(["no links to or from this note", "depth 2 · 1 of 6 notes"])
  expect(sheet(await keys(s, "esc"))).toBeNull()
})

test("H in the sheet closes it and steps history", async () => {
  const { s } = await opened()
  await keys(s, "j", "j", "j", "enter", "C-g")
  await waitFrame(s, (f) => f.includes("Graph · Simmering"))
  const f = await keys(s, "H")
  expect(sheet(f)).toBeNull()
  expect(f.split("\n")[0]).toContain("Broth")
})

test("^g with no note open says so; in zen it does nothing (esc then leaves zen, no sheet to close)", async () => {
  const empty = await mount(tmp({ "notes.txt": "x" }), undefined, { size: SIZE })
  expect(await keys(empty, "C-g")).toContain("no note open")
  const s = await mount(tmp(KITCHEN), "Broth.md", { size: SIZE })
  expect(panelShown(await keys(s, "z", "C-g"))).toBe(false)
  const f = await keys(s, "esc")
  expect(sheet(f)).toBeNull()
  expect(panelShown(f)).toBe(true)
})

test("p with braille saved where the terminal shows images: pixels, saved", async () => {
  writeConfig({ graph: { render: "braille" } })
  const s = await mount(tmp(KITCHEN), "Broth.md", { size: SIZE })
  setRendererCapabilities(s.renderer, { kitty_graphics: true })
  await keys(s, "C-g")
  expect((await waitFrame(s, (f) => f.includes("of 6 notes"), 4000)).split("\n")[HINT_ROW]).toContain("p pixels")
  const f = await keys(s, "p")
  expect(f).toContain("graph · pixels")
  expect(f.split("\n")[HINT_ROW]).toContain("p braille")
  expect(f).not.toContain("unavailable")
  expect(savedConfig().graph).toEqual({ render: "pixels" })
})

test("- and + switch to depth 1 and back to 2, and save it", async () => {
  const { s } = await opened()
  let f = await keys(s, "-")
  expect(sheet(f)![0]).toContain("depth 1")
  expect(listRows(f)).toEqual(["▌↔ Stock", "← Garnish", "→ Simmering", "→ Nowhere", "depth 1 · 4 of 6 notes"])
  expect(savedConfig().graph).toEqual({ depth: 1 })
  f = await keys(s, "+")
  expect(listRows(f)).toContain("→ Bones")
  expect(savedConfig().graph).toEqual({ depth: 2 })
})

test("p where the terminal shows no images: braille stays, the toast says why, nothing is saved, whatever is saved", async () => {
  const f = await keys((await opened()).s, "p")
  expect(f).toContain("graph · pixels unavailable here · braille")
  expect(pictureRows(f).some((r) => BRAILLE.test(r))).toBe(true)
  expect(existsSync(configFile())).toBe(false)
  writeConfig({ graph: { render: "braille" } })
  expect(await keys((await opened()).s, "p")).toContain("graph · pixels unavailable here · braille")
  expect(savedConfig().graph).toEqual({ render: "braille" })
})

test("where the terminal shows images: pixels with text labels; p switches to braille and saves it", async () => {
  const s = await mount(tmp(KITCHEN), "Broth.md", { size: SIZE })
  setRendererCapabilities(s.renderer, { kitty_graphics: true })
  await keys(s, "C-g")
  let f = await waitFrame(s, (x) => x.includes("of 6 notes"), 4000)
  expect(pictureRows(f).some((r) => BRAILLE.test(r))).toBe(false)
  expect(pictureRows(f).join("\n")).toContain("Broth")
  expect(f.split("\n")[HINT_ROW]).toContain("p braille")
  f = await keys(s, "p")
  expect(f).toContain("graph · braille")
  expect(pictureRows(f).some((r) => BRAILLE.test(r))).toBe(true)
  expect(savedConfig().graph).toEqual({ render: "braille" })
})

test("auto inside a multiplexer: the first open says it draws pixels and how to switch", async () => {
  const s = await mount(tmp(KITCHEN), "Broth.md", { size: SIZE })
  setRendererCapabilities(s.renderer, { kitty_graphics: true, multiplexer: "zellij" })
  expect(await keys(s, "C-g")).toContain("graph · pixels · p braille")
})

test("/ filters the list; nothing matching says so and ⏎ does nothing; esc clears the filter, then closes", async () => {
  const { s } = await opened()
  let f = await keys(s, "/", "type:sim")
  expect(listRows(f)).toEqual(["▌→ Simmering", "depth 2 · 5 of 6 notes"])
  expect(f.split("\n")[HINT_ROW]).toMatch(/type filter {3}↑↓ neighbour {3}⏎ open {3}tab keep {3}esc clear/)
  f = await keys(s, "type:zz", "enter")
  expect(listRows(f)).toEqual(["no match", "depth 2 · 5 of 6 notes"])
  f = await keys(s, "esc")
  expect(listRows(f)[0]).toBe("▌↔ Stock")
  expect(sheet(await keys(s, "esc"))).toBeNull()
})

/** The screen cell of `name` on its list row. */
const rowCell = (f: string, name: string): [number, number] => {
  const rows = f.split("\n")
  const y = rows.findIndex((r) => r.includes(`${name}`) && r.includes("│"))
  return [rows[y]!.lastIndexOf(name), y]
}

test("hover focuses a row and a click on it centres there; a slower second click walks on, never opens", async () => {
  const { s } = await opened()
  const [x, y] = rowCell(s.captureCharFrame(), "Garnish")
  await s.mockMouse.moveTo(x, y)
  expect(barRow(await keys(s))).toBe("▌← Garnish")
  await s.mockMouse.click(x, y)
  let f = await keys(s)
  expect(sheet(f)![0]).toContain("Graph · Garnish")
  f = await withClock(new Date(Date.now() + 1000), async () => {
    await s.mockMouse.click(x, y)
    return keys(s)
  })
  expect(sheet(f)).not.toBeNull()
  expect(sheet(f)![0]).not.toContain("Graph · Garnish")
})

test("a click on the row j k focused opens it, the pointer moved onto it first", async () => {
  const { s } = await opened()
  const f = await keys(s, "j", "j")
  expect(barRow(f)).toBe("▌← Garnish")
  const [x, y] = rowCell(f, "Garnish")
  await s.mockMouse.moveTo(x, y)
  await s.mockMouse.click(x, y)
  const after = await keys(s)
  expect(sheet(after)).toBeNull()
  expect(after.split("\n")[0]).toContain("Garnish")
})

test("the click that opened a note from the sheet: a second one right after lands nowhere, a later one does", async () => {
  const { s } = await opened()
  let f = await keys(s, "j", "j")
  const [x, y] = rowCell(f, "Garnish")
  await s.mockMouse.moveTo(x, y)
  await s.mockMouse.click(x, y)
  f = await keys(s)
  expect(sheet(f)).toBeNull()
  const rows = f.split("\n")
  const ly = rows.findIndex((r) => r.slice(0, 30).includes("Lonely"))
  const lx = rows[ly]!.indexOf("Lonely")
  await s.mockMouse.click(lx, ly) // the double-click's second half, over the Files panel
  await Bun.sleep(600)
  expect((await keys(s)).split("\n")[0]).toContain("Garnish")
  await s.mockMouse.click(lx, ly)
  await Bun.sleep(600)
  expect((await keys(s)).split("\n")[0]).toContain("Lonely")
})

test("a double-click on a row opens that note", async () => {
  const { s } = await opened()
  const [x, y] = rowCell(s.captureCharFrame(), "Simmering")
  await s.mockMouse.doubleClick(x, y)
  const f = await keys(s)
  expect(sheet(f)).toBeNull()
  expect(f.split("\n")[0]).toContain("Simmering")
})

test("a click on + n more lists the rest, as ⏎ does", async () => {
  const d = tmp(hubFiles())
  const s = await mount(d, "Hub.md", { size: SIZE })
  await keys(s, "C-g", "-")
  let f = await waitFrame(s, (x) => x.includes("+ 7 more"), 4000)
  const [x, y] = rowCell(f, "+ 7 more")
  await s.mockMouse.click(x, y)
  f = await keys(s)
  expect(listRows(f).join("\n")).toContain("⏎ fewer")
})

test("⏎ on a note reached from a Files preview: H comes back to the previewed note", async () => {
  const s = await mount(tmp(KITCHEN), "Broth.md", { size: SIZE })
  await keys(s, "tab", "j")
  await waitFrame(s, (f) => f.split("\n")[0]!.includes("Garnish")) // previewed after OPEN_DELAY
  await keys(s, "C-g")
  await waitFrame(s, (f) => f.includes("Graph · Garnish") && f.includes("of 6 notes"), 4000)
  let f = await keys(s, "enter")
  expect(sheet(f)).toBeNull()
  expect(f.split("\n")[0]).toContain("Broth")
  f = await keys(s, "H")
  expect(f.split("\n")[0]).toContain("Garnish")
})

test("^g while the index builds: every note's links once it is done, the build's rows meanwhile", async () => {
  const s = await mount(tmp(hubFiles()), "Hub.md", { size: SIZE })
  s.mockInput.pressKey("g", { ctrl: true })
  await s.renderOnce() // before the first note is read
  expect(listRows(s.captureCharFrame())[0]).toBe("▍ indexing notes")
  const f = await waitFrame(s, (x) => x.includes("of 76 notes"), 6000)
  expect(sheet(f)![0]).toMatch(/← 0 · → 25 · depth 2/)
  expect(listRows(f)[0]).toBe("▌→ n00")
})

test("below 100 columns the picture takes the width and the row under it names the focused note", async () => {
  const { s } = await opened("Broth.md", { width: 80, height: 24 }, (f) => f.includes("▌↔ Stock"))
  const rows = s.captureCharFrame().split("\n")
  const top = rows.findIndex((r) => r.includes("Graph · Broth"))
  const body = rows.slice(top + 2, top + 2 + 18)
  expect(body.some((r) => r.includes("│"))).toBe(false)
  expect(body.at(-1)).toMatch(/▌↔ Stock/)
})

test("the smallest screen (60×14) still opens the sheet", async () => {
  const { s } = await opened("Broth.md", { width: 60, height: 14 }, (f) => f.includes("▌↔ Stock"))
  expect(s.captureCharFrame()).toContain("Graph · Broth")
})
