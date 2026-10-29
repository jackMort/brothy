import { expect, test } from "bun:test"
import { FOOTERS, type FooterState, footerHints, HELP_GROUPS, isDown, modeOf, PINNED } from "../../src/app/keymap"

const ALL: FooterState = { query: true, preview: true, disk: true, ai: true, changes: true }
const NONE: FooterState = { query: false, preview: false, disk: false, ai: false, changes: false }
const words = (on: FooterState, c: Parameters<typeof footerHints>[0] = "doc") => footerHints(c, on).map((h) => `${h.key} ${h.word}`)

test("document hints: short keys, a context's own word over the binding's", () => {
  expect(words(ALL)).toEqual(["j k scroll", "␣ b page", "[ ] section", "/ find", "n N match", "f links", "H L history", "e edit", "tab panel", "? keys"])
})

test("a hint waits for its state: n N for a query, f for Preview, e for a note on disk", () => {
  expect(words(NONE)).toEqual(["j k scroll", "␣ b page", "[ ] section", "/ find", "H L history", "tab panel", "? keys"])
  expect(words({ ...NONE, preview: true })).toContain("f links")
  expect(words({ ...NONE, disk: true })).toContain("e edit")
})

test("AI hints show only with an `ai` block; D also needs changes to explain", () => {
  expect(words({ ...NONE, ai: true }, "panel:info")).toEqual(["↑↓ links", "⏎ open", "a summarize", "tab document", "? keys"])
  expect(words(ALL, "panel:info")).toContain("D changes")
  expect(words({ ...NONE, ai: true }, "zen")).toContain("a gloss")
  expect(words(NONE, "zen")).not.toContain("a gloss")
})

test("spare hints are the optional ones", () => {
  const spare = (c: Parameters<typeof footerHints>[0]) =>
    footerHints(c, ALL)
      .filter((h) => h.spare)
      .map((h) => h.key)
  expect(spare("doc")).toEqual(["f", "H L", "e"])
  expect(spare("panel:info")).toEqual(["a", "D"])
  expect(spare("theme")).toEqual(["type"])
  expect(spare("switch")).toEqual([])
})

test("a typing binding's empty word stays empty", () => {
  expect(footerHints("filter", ALL).map((h) => h.word)).toEqual(["", "", "open", "clear"])
})

test("popups and typing pin their hints; the document, the panel and zen fade theirs", () => {
  for (const c of Object.keys(FOOTERS) as (keyof typeof FOOTERS)[]) expect(PINNED.includes(c)).toBe(!(c === "doc" || c === "zen" || c.startsWith("panel:")))
})

test("modeOf maps a panel context to its view's mode", () => {
  expect(modeOf("panel:files")).toBe("files")
  expect(modeOf("doc")).toBe("doc")
  expect(modeOf("switch")).toBe("switch")
})

test("isDown is the forward key of each pair", () => {
  const k = (name: string, ctrl = false) => ({ name, ctrl }) as Parameters<typeof isDown>[0]
  for (const n of ["j", "down", "d", "space", "pagedown"]) expect(isDown(k(n))).toBe(true)
  for (const n of ["k", "up", "u", "b", "pageup"]) expect(isDown(k(n))).toBe(false)
  expect(isDown(k("f", true))).toBe(true)
  expect(isDown(k("f"))).toBe(false)
})

test("the help sheet groups: AI collects its bindings, a binding without a description stays out", () => {
  const ai = HELP_GROUPS.find((g) => g.title === "AI")!
  expect(ai.entries.map((e) => e.keys)).toEqual(["a", "D", "^p ?"])
  const all = HELP_GROUPS.flatMap((g) => g.entries.map((e) => e.desc))
  expect(all).not.toContain(undefined)
  expect(HELP_GROUPS.map((g) => g.title)).toEqual(["Global", "Document", "Zen", "Panel", "AI"])
})
