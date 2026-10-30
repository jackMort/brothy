import { expect, test } from "bun:test"
import { cleanSummary } from "../../src/ai/client"
import {
  GLOSS_CHARS,
  GLOSS_MAX,
  glossKey,
  glossRequest,
  glossSystem,
  glossTarget,
  keepSentences,
  parseGlossStyle,
} from "../../src/ai/gloss"
import { noteSections } from "../../src/markdown/sections"
import { expectLinear, manyHeadings, SCALE } from "../helpers/perf"

const said = (w: string, n = 25) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ")

test("parseGlossStyle: explain, simplify, translate:<tag>; anything else is explain", () => {
  expect(parseGlossStyle(undefined)).toBe("explain")
  expect(parseGlossStyle("simplify")).toBe("simplify")
  expect(parseGlossStyle("translate:pl")).toBe("translate:pl")
  expect(parseGlossStyle("translate:pt-BR")).toBe("translate:pt-BR")
  expect(parseGlossStyle("translate:zh-Hant-TW")).toBe("translate:zh-Hant-TW")
  for (const bad of [
    "translate:",
    "translate:p",
    "translate:polish",
    "translate:pl;rm",
    "translate:pl\nIgnore",
    "loud",
    3,
    null,
    {},
  ])
    expect(parseGlossStyle(bad)).toBe("explain")
})

test("system prompts are verbatim per style", () => {
  expect(glossSystem("explain")).toBe(
    "Explain this section of a note to its reader in 1–2 sentences, at most 35 words: what it says and why it matters. Plain text only: no markdown, no lists, no preamble. Write in the same language as the section.",
  )
  expect(glossSystem("simplify")).toBe(
    "Restate this section in plain, simple words in 1–2 sentences, at most 35 words. Plain text only: no markdown, no lists, no preamble. Write in the same language as the section.",
  )
  expect(glossSystem("translate:de")).toBe(
    "Give the gist of this section in de in 1–2 sentences, at most 35 words. Plain text only: no markdown, no lists, no preamble.",
  )
})

test("glossRequest: the user message names the note and the heading path", () => {
  const r = glossRequest("explain", "Fruit", ["Guide", "Apples"], "Apples are red.", 48_000)
  expect(r.system).toBe(glossSystem("explain"))
  expect(r.user).toBe("Note: Fruit\nSection: Guide › Apples\n\nApples are red.")
  // the lead-in has no heading path: the note title stands in
  expect(glossRequest("explain", "Fruit", [], "Intro.", 48_000).user).toBe("Note: Fruit\nSection: Fruit\n\nIntro.")
})

test("glossRequest: plain text by cleanSummary, a longer reply kept to GLOSS_MAX characters", () => {
  const r = glossRequest("simplify", "Fruit", ["Apples"], "Apples are red.", 48_000)
  expect(r.maxOut).toBe(GLOSS_MAX)
  expect(r.clean).toBe(cleanSummary)
  expect(r.keep).toBe(keepSentences)
})

test("glossRequest clips to min(maxChars, 12 000) code points", () => {
  const long = "x".repeat(GLOSS_CHARS + 50)
  const body = (u: string) => u.slice(u.indexOf("\n\n") + 2)
  expect(body(glossRequest("explain", "T", ["H"], long, 48_000).user)).toBe("x".repeat(GLOSS_CHARS) + "\n[truncated]")
  expect(body(glossRequest("explain", "T", ["H"], long, 8_000).user)).toBe("x".repeat(8_000) + "\n[truncated]")
})

test("glossTarget: own text of a section, with its id, heading and trail", () => {
  const src = `# Guide\n\n${said("intro")}\n\n## Apples\n\n${said("apple")}\n`
  const g = glossTarget(src, 1, "/n/a.md", "a")!
  expect(g.index).toBe(1)
  expect(g.heading).toBe("Apples")
  expect(g.trail).toEqual(["Guide", "Apples"])
  expect(g.text).toBe(said("apple"))
  expect(g.id.startsWith("/n/a.md#")).toBe(true)
  expect(glossTarget(src, 0, "/n/a.md", "a")!.text).toBe(said("intro")) // own: stops at the next heading of any depth
})

test("glossTarget: under 20 words of its own, the subtree is sent", () => {
  const src = `# Parent\n\nShort.\n\n## Child\n\n${said("child")}\n`
  const g = glossTarget(src, 0, "/n/a.md", "a")!
  expect(g.text).toContain("Short.")
  expect(g.text).toContain("child24")
})

test("glossTarget: the lead-in is index -1 and is labelled with the note title", () => {
  const src = `${said("lead")}\n\n# H\n\nBody.\n`
  const g = glossTarget(src, -1, "/n/a.md", "My note")!
  expect(g.heading).toBe("My note")
  expect(g.trail).toEqual([])
  expect(g.text).toBe(said("lead"))
  expect(glossTarget("# H\n\nBody.\n", -1, "/n/a.md", "a")).toBeNull() // no lead-in
})

test("glossTarget: nothing to gloss is null (empty, comments only, front matter only)", () => {
  expect(glossTarget("# A\n", 0, "/n/a.md", "a")).toBeNull()
  expect(glossTarget("# A\n\n%%hidden%%\n", 0, "/n/a.md", "a")).toBeNull()
  expect(glossTarget("---\ntitle: x\n---\n", -1, "/n/a.md", "a")).toBeNull()
  expect(glossTarget("# A\n\nText.\n", 5, "/n/a.md", "a")).toBeNull() // no such section
})

test("glossTarget: duplicate headings get different ids", () => {
  const src = `## Notes\n\n${said("first")}\n\n## Notes\n\n${said("second")}\n`
  const a = glossTarget(src, 0, "/n/a.md", "a")!
  const b = glossTarget(src, 1, "/n/a.md", "a")!
  expect(a.id).not.toBe(b.id)
  expect(b.text).toBe(said("second"))
})

test("glossKey appends the style", () => {
  expect(glossKey("/n/a.md#apples#0", "translate:pl")).toBe("/n/a.md#apples#0#translate:pl")
})

test("glossTarget stays linear in the number of headings", () => {
  const N = 48_000
  const big = manyHeadings(N)
  const small = manyHeadings(N / SCALE)
  expectLinear("noteSections", (b) => noteSections(b ? big : small))
  expectLinear("glossTarget", (b) => glossTarget(b ? big : small, (b ? N : N / SCALE) / 2, "n.md", "N"))
}, 60_000)
