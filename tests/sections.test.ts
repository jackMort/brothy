import { describe, expect, test } from "bun:test"
import { parseFrontMatter } from "../src/frontmatter"
import { render } from "../src/markdown"
import { noteSections, sectionId, sectionOf, sectionSource } from "../src/sections"
import { renderSource } from "../src/source"
import { brothy } from "./helpers/theme"

const t = brothy
// 0 ---  1 title  2 ---  3 lead in  4 # A  5 a text  6 ## A1  7 a1 text  8 # B  9 b %%secret%% text  10-12 %% hidden %%
const NOTE = "---\ntitle: x\n---\nlead in\n# A\na text\n## A1\na1 text\n# B\nb %%secret%% text\n%%\nhidden\n%%\n"

describe("noteSections", () => {
  test("lead-in first, then one section per heading with own and tree ranges in source lines", () => {
    const s = noteSections(NOTE)
    expect(s.map((x) => [x.index, x.depth, x.text, x.line, x.own, x.tree])).toEqual([
      [-1, 0, "", 0, [0, 4], [0, 4]],
      [0, 1, "A", 4, [4, 6], [4, 8]],
      [1, 2, "A1", 6, [6, 8], [6, 8]],
      [2, 1, "B", 8, [8, 13], [8, 13]],
    ])
  })
  test("a note without headings is one lead-in over every line", () => {
    expect(noteSections("just\ntext\n").map((x) => [x.index, x.own])).toEqual([[-1, [0, 2]]])
  })
  test("duplicate headings get ord; an empty key doesn't collide with the lead-in", () => {
    const s = noteSections("# Same\none\n# Same\ntwo\n# !!!\nthree\n")
    expect(s.map((x) => [x.key, x.ord])).toEqual([
      ["", 0],
      ["same", 0],
      ["same", 1],
      ["", 1],
    ])
    expect(new Set(s.map((x) => sectionId("/n.md", x))).size).toBe(4)
  })
})

describe("sectionSource", () => {
  test("own text: heading line, front matter and comments left out", () => {
    expect(sectionSource(NOTE, -1, "own")).toBe("lead in")
    expect(sectionSource(NOTE, 0, "own")).toBe("a text")
    expect(sectionSource(NOTE, 2, "own")).toBe("b  text")
  })
  test("tree text keeps the sub-headings", () => {
    expect(sectionSource(NOTE, 0, "tree")).toBe("a text\n## A1\na1 text")
    expect(sectionSource(NOTE, 1, "tree")).toBe("a1 text")
  })
  test("both lines of a setext heading are left out", () => {
    expect(sectionSource("Title\n===\nbody\n", 0, "own")).toBe("body")
  })
  test("CRLF and BOM: same lines as sourceScan, no \\r", () => {
    const src = "﻿# A\r\nx\r\n# B\r\ny\r\n"
    expect(sectionSource(src, 0, "own")).toBe("x")
    expect(sectionSource(src, 1, "own")).toBe("y")
  })
  test("out of range or empty is empty", () => {
    expect(sectionSource(NOTE, 9, "own")).toBe("")
    expect(sectionSource(NOTE, -2, "own")).toBe("")
    expect(sectionSource("# Only\n", 0, "own")).toBe("")
    expect(sectionSource("# H\n%% all hidden %%\n", 0, "own")).toBe("")
  })
})

describe("sectionOf", () => {
  /** App.tsx derive(): the current heading is the last one with line <= top + 1 */
  const derived = (hs: { line: number }[], top: number) => {
    let at = -1
    for (let i = 0; i < hs.length; i++) if (hs[i]!.line <= top + 1) at = i
    return at
  }
  test("matches derive()'s current-heading rule on a rendered note", () => {
    const hs = render(parseFrontMatter(NOTE).body, 40, t).headings
    for (let top = -1; top < 20; top++) expect(sectionOf(hs, top)).toBe(derived(hs, top))
  })
  test("before the first heading is -1; one row above a heading already counts", () => {
    expect(sectionOf([{ line: 3 }], 0)).toBe(-1)
    expect(sectionOf([{ line: 3 }], 2)).toBe(0)
    expect(sectionOf([], 5)).toBe(-1)
  })
})

test("sectionId: path, key, ord", () => {
  expect(sectionId("/v/n.md", { key: "why another reader", ord: 0 })).toBe("/v/n.md#why another reader#0")
})

describe("outline parity", () => {
  const fixtures = [
    NOTE,
    "# A\ntext\n## B\n",
    "---\ntitle: x\n---\n# Real\n```\n# not\n```\nSetext\n===\n",
    "%%\n# hidden\n%%\n# Shown [[note|alias]] `code`\n> # quoted\n",
    "> [!note] Title\n> ## inside\n\n```dataview\nTABLE x\n```\n## after\n",
  ]
  test("section i is heading i in Preview and Source", () => {
    for (const src of fixtures) {
      const sections = noteSections(src).slice(1).map((s) => [s.depth, s.text])
      expect(sections).toEqual(render(parseFrontMatter(src).body, 60, t).headings.map((h) => [h.depth, h.text]))
      expect(sections).toEqual(renderSource(src, 60, t).headings.map((h) => [h.depth, h.text]))
    }
  })
})
