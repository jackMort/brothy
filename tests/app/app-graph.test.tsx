// App: the Graph sheet on ^g: open, move, walk and back, open a note, close.
import { expect, test } from "bun:test"
import { KITCHEN } from "../helpers/vault"
import { keys, useAppHarness, waitFrame } from "./helpers"

const { tmp, mount } = useAppHarness()

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

test("^g with no note open says so; in zen it does nothing", async () => {
  const empty = await mount(tmp({ "notes.txt": "x" }), undefined, { size: SIZE })
  expect(await keys(empty, "C-g")).toContain("no note open")
  const s = await mount(tmp(KITCHEN), "Broth.md", { size: SIZE })
  expect(sheet(await keys(s, "z", "C-g"))).toBeNull()
})
