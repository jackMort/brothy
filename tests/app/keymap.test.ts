import { expect, test } from "bun:test"
import {
  FOOTERS,
  type FooterState,
  footerHints,
  HELP_GROUPS,
  isDown,
  KEY_IDS,
  keyDef,
  modeOf,
  PINNED,
  WELCOME_OFF,
  ZEN_OFF,
} from "../../src/app/keymap"

const ALL: FooterState = { query: true, preview: true, disk: true, ai: true, changes: true, tldr: true, pics: true }
const NONE: FooterState = {
  query: false,
  preview: false,
  disk: false,
  ai: false,
  changes: false,
  tldr: false,
  pics: false,
}
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
    "c chat",
    "⏎ view",
    "p pictures",
    "tab panel",
    "? keys",
  ])
})

test("a hint waits for its state: n N for a query, f for Preview, e for a note on disk", () => {
  expect(words(NONE)).toEqual(["j k scroll", "␣ b page", "[ ] section", "/ find", "H L history", "tab panel", "? keys"])
  expect(words({ ...NONE, preview: true })).toContain("f links")
  expect(words({ ...NONE, disk: true })).toContain("e edit")
})

test("AI hints show only with an `ai` block; D only while the Changed block gives it something to do", () => {
  expect(words({ ...NONE, ai: true }, "panel:info")).toEqual([
    "↑↓ links",
    "⏎ open",
    "a summarize",
    "tab document",
    "? keys",
  ])
  expect(words(ALL, "panel:info")).toContain("D explain")
  expect(footerHints("panel:info", ALL, { explainChange: "retry" }).map((h) => `${h.key} ${h.word}`)).toContain(
    "D retry",
  )
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
  expect(spare("doc")).toEqual(["f", "H L", "e", "a", "c", "p"])
  expect(spare("panel:info")).toEqual(["a"]) // D shows only while it has something to do: it is never dropped first
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

test("the Proof sheet's footer: sections, go to, D only while it has something to do, close; no help rows of its own", () => {
  expect(words(ALL, "proof")).toEqual(["↑↓ section", "⏎ go to", "D explain", "esc close"])
  expect(words(NONE, "proof")).toEqual(["↑↓ section", "⏎ go to", "esc close"])
  expect(footerHints("proof", ALL, { proofExplain: "cancel" }).map((h) => h.word)).toContain("cancel")
  for (const id of ["proofMove", "proofGo", "proofExplain", "proofClose"] as const)
    expect(keyDef(id).desc).toBeUndefined()
})

test("a typing binding's empty word stays empty", () => {
  expect(footerHints("filter", ALL).map((h) => h.word)).toEqual(["", "", "open", "clear"])
})

test("popups and typing pin their hints; the document (landed too, on a cite too), the panel and zen fade theirs", () => {
  for (const c of Object.keys(FOOTERS) as (keyof typeof FOOTERS)[])
    expect(PINNED.includes(c)).toBe(
      !(c === "doc" || c === "landing" || c === "chatLanded" || c === "zen" || c.startsWith("panel:")),
    )
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
  expect(ai.entries.map((e) => e.keys)).toEqual(["a", "D", "c", "^p ?"])
  const all = HELP_GROUPS.flatMap((g) => g.entries.map((e) => e.desc))
  expect(all).not.toContain(undefined)
  expect(HELP_GROUPS.map((g) => g.title)).toEqual(["Global", "Document", "Zen", "Panel", "Graph", "AI"])
})

test("graph: ^g everywhere but zen; the sheet's footer with p named for what it switches to; the filter's own; help group Graph", () => {
  const on = { query: false, preview: true, disk: true, ai: false, changes: false, tldr: false, pics: false }
  const words = (c: Parameters<typeof footerHints>[0], w = {}) => footerHints(c, on, w).map((h) => `${h.key} ${h.word}`)
  expect(words("graph", { graphRender: "braille" })).toEqual([
    "↑↓ neighbour",
    "⏎ open",
    "l centre",
    "h back",
    "+ - depth",
    "p braille",
    "/ filter",
    "esc close",
  ])
  expect(words("graphFilter")).toEqual(["type filter", "↑↓ neighbour", "⏎ open", "tab keep", "esc clear"])
  expect(words("doc")).not.toContain("^g graph")
  expect(ZEN_OFF).toContain("graphOpen")
  expect(PINNED).toEqual(expect.arrayContaining(["graph", "graphFilter"]))
  expect(HELP_GROUPS.find((g) => g.title === "Graph")!.entries.map((e) => e.keys)).toEqual([
    "↑↓ j k",
    "⏎",
    "l →",
    "h ←",
    "+ -",
    "p",
    "/",
    "H L",
    "esc",
  ])
  expect(HELP_GROUPS.find((g) => g.title === "Document")!.entries.some((e) => e.keys === "^g")).toBe(true)
})

test("p pictures waits for a picture in Preview; its word is what p switches to", () => {
  expect(words(NONE)).not.toContain("p pictures")
  expect(words({ ...NONE, pics: true })).toContain("p pictures")
  expect(footerHints("doc", { ...NONE, pics: true }, { pictures: "text" }).map((h) => `${h.key} ${h.word}`)).toContain(
    "p text",
  )
})

test("the pill's footer follows its stage; landed on a cite: [ ] marks, c answer, esc hide, j k scroll", () => {
  const say = (stage: Parameters<typeof footerHints>[4]) =>
    footerHints("chat", ALL, {}, null, stage).map((h) => `${h.key} ${h.word}`)
  expect(say("input")).toEqual(["⏎ send", "[[ note", "⌫ chip", "esc hide"])
  expect(say("pick")).toEqual(["tab complete", "⏎ add", "esc back"])
  expect(say("waiting")).toEqual(["esc cancel"])
  expect(say("answer")).toEqual(["↑↓ marks", "⏎ go to", "type follow-up", "esc fold"])
  expect(say("error")).toEqual(["⏎ retry", "esc fold"])
  expect(words(ALL, "chatLanded")).toEqual(["[ ] marks", "c answer", "esc hide", "j k scroll"])
  expect(modeOf("chatLanded")).toBe("doc")
  expect(PINNED).toContain("chat")
})

test("c: AI group, spare, only with an ai block; off in zen and on the welcome page; the pill's keys have no help rows", () => {
  expect(HELP_GROUPS.find((g) => g.title === "AI")!.entries.map((e) => e.keys)).toContain("c")
  expect(keyDef("chat")).toMatchObject({ spare: true, when: "ai", group: "AI" })
  expect(ZEN_OFF).toContain("chat")
  expect(WELCOME_OFF).toContain("chat")
  const pillIds = KEY_IDS.filter((id) => id.startsWith("chat") && id !== "chat")
  expect(pillIds.filter((id) => keyDef(id).desc)).toEqual([])
  expect(words({ ...ALL, ai: false })).not.toContain("c chat")
})

test("no key clash in the chat mode", () => {
  const specs = KEY_IDS.filter((id) => keyDef(id).modes.includes("chat")).flatMap((id) => keyDef(id).keys)
  expect(new Set(specs).size).toBe(specs.length)
})
