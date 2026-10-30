import { expect, test } from "bun:test"
import { FOOTERS, type FooterState, footerHints, HELP_GROUPS, isDown, modeOf, PINNED } from "../../src/app/keymap"

const ALL: FooterState = { query: true, preview: true, disk: true, ai: true, changes: true, tldr: true }
const NONE: FooterState = { query: false, preview: false, disk: false, ai: false, changes: false, tldr: false }
const words = (on: FooterState, c: Parameters<typeof footerHints>[0] = "doc") =>
  footerHints(c, on).map((h) => `${h.key} ${h.word}`)

test("document hints: short keys, a context's own word over the binding's", () => {
  expect(words(ALL)).toEqual([
    "j k scroll",
    "␣ b page",
    "[ ] section",
    "/ find",
    "n N match",
    "f links",
    "H L history",
    "e edit",
    "a summarize",
    "tab panel",
    "? keys",
  ])
})

test("a hint waits for its state: n N for a query, f for Preview, e for a note on disk", () => {
  expect(words(NONE)).toEqual(["j k scroll", "␣ b page", "[ ] section", "/ find", "H L history", "tab panel", "? keys"])
  expect(words({ ...NONE, preview: true })).toContain("f links")
  expect(words({ ...NONE, disk: true })).toContain("e edit")
})

test("AI hints show only with an `ai` block; D also needs changes to explain", () => {
  expect(words({ ...NONE, ai: true }, "panel:info")).toEqual([
    "↑↓ links",
    "⏎ open",
    "a summarize",
    "tab document",
    "? keys",
  ])
  expect(words(ALL, "panel:info")).toContain("D changes")
  expect(words({ ...NONE, ai: true }, "zen")).toContain("a gloss")
  expect(words(NONE, "zen")).not.toContain("a gloss")
})

test("the document offers a only while the note has no fresh TL;DR; state words win over the binding's", () => {
  expect(words({ ...NONE, ai: true })).not.toContain("a summarize")
  expect(words({ ...NONE, ai: true, tldr: true })).toContain("a summarize")
  const say = (c: Parameters<typeof footerHints>[0], w: Parameters<typeof footerHints>[2]) =>
    footerHints(c, { ...NONE, ai: true, tldr: true }, w).map((h) => `${h.key} ${h.word}`)
  expect(say("doc", { summarizeHint: "cancel" })).toContain("a cancel")
  expect(say("panel:info", { infoMove: "move", infoOpen: "more", summarize: "retry" }).slice(0, 3)).toEqual([
    "↑↓ move",
    "⏎ more",
    "a retry",
  ])
  expect(say("panel:outline", { infoMove: "less" })[0]).toBe("↑↓ move") // words go to their own binding only
})

test("spare hints are the optional ones", () => {
  const spare = (c: Parameters<typeof footerHints>[0]) =>
    footerHints(c, ALL)
      .filter((h) => h.spare)
      .map((h) => h.key)
  expect(spare("doc")).toEqual(["f", "H L", "e", "a"])
  expect(spare("panel:info")).toEqual(["a", "D"])
  expect(spare("theme")).toEqual(["type"])
  expect(spare("switch")).toEqual(["?"])
})

test("the switcher's footer: `? ask` only with an `ai` block; a question's footer follows the ask's stage", () => {
  const sw = (on: FooterState, ask?: Parameters<typeof footerHints>[3]) =>
    footerHints("switch", on, {}, ask).map((h) => `${h.key} ${h.word}`)
  expect(sw(ALL)).toEqual(["type search", "↑↓ select", "tab section", "⏎ open", "? ask", "esc close"])
  expect(sw(NONE)).not.toContain("? ask")
  const stages: [Parameters<typeof footerHints>[3], string[]][] = [
    ["off", ["esc close"]],
    ["short", ["⌫ edit", "esc close"]],
    ["target", ["⌫ edit", "esc close"]],
    ["idle", ["⏎ ask", "⌫ edit", "esc close"]],
    ["asking", ["⌫ edit · cancels", "esc close"]],
    ["indexing", ["⌫ edit", "esc close"]],
    ["result", ["↑↓ select", "⏎ open", "tab rerank", "esc close"]],
    ["none", ["⌫ edit", "esc close"]],
    ["reranking", ["↑↓ select", "⏎ open", "esc close"]],
    ["reranked", ["↑↓ select", "⏎ open", "tab section", "esc close"]],
    ["error", ["⏎ try again", "⌫ edit", "esc close"]],
  ]
  for (const [stage, want] of stages) expect(sw(ALL, stage)).toEqual(want)
  // another context ignores the ask
  expect(footerHints("doc", ALL, {}, "idle")).toEqual(footerHints("doc", ALL))
})

test("a typing binding's empty word stays empty", () => {
  expect(footerHints("filter", ALL).map((h) => h.word)).toEqual(["", "", "open", "clear"])
})

test("popups and typing pin their hints; the document, the panel and zen fade theirs", () => {
  for (const c of Object.keys(FOOTERS) as (keyof typeof FOOTERS)[])
    expect(PINNED.includes(c)).toBe(!(c === "doc" || c === "zen" || c.startsWith("panel:")))
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
