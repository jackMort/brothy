// App: back and forward through the notes (H / L).
import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { bodyRows, HINT_ROW, keys, longB, openHelp, panelShown, useAppHarness, waitFrame } from "./helpers"

const { tmp, mount } = useAppHarness()

// ------------------------------------------------------------- history (H / L)

const histA =
  "# A\n\n" +
  Array.from({ length: 60 }, (_, i) => (i % 8 === 4 ? `row ${i} see [[b]]` : `row ${i}`)).join("\n\n") +
  "\n"
const histVault = () => tmp({ "a.md": histA, "b.md": longB, "c.md": "# Sea note\n", "d.md": "# Dee note\n" })

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
  await waitFrame(
    s,
    (f) => !f.includes("Go to") && f.includes("Dee note") && !f.split("\n")[HINT_ROW]!.includes("forward · b"),
    6000,
  )
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
  const s = await mount(histVault(), "a.md", { size: { width: 100, height: 120 } })
  expect(await keys(s)).toContain("H L history")
  expect(await openHelp(s)).toContain("back to the previous note")
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
