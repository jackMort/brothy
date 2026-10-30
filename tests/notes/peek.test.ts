import { expect, test } from "bun:test"
import type { Span } from "../../src/lib/spans"
import { parseFrontMatter } from "../../src/markdown/frontmatter"
import { normalize } from "../../src/markdown/lexer"
import { render } from "../../src/markdown/render"
import { PEEK_BYTES, PEEK_TLDR, type PeekInput, peekLines, peekWindow, switchSplit } from "../../src/notes/peek"
import { indexNote, type SwitchRow } from "../../src/notes/vault"
import { brothy } from "../helpers/theme"

const t = brothy
const W = 40
const SRC =
  "---\ntitle: x\n---\n# Simmering notes\n\nA ==slow read== beats a fast scroll.\n\n\n\nSecond line.\n\n## A tiny stock\n\nStock body.\n\n## Heat levels\n\nHeat body.\n\n## Later\n\nLater body.\n"
const doc = indexNote(SRC, 2000, SRC.length)
const view = render(parseFrontMatter(SRC).body, W, t)
const base = { path: "/v/notes/simmering.md", name: "simmering", folder: "notes" }
const note: SwitchRow = { kind: "note", ...base, hits: [] }
const input = (row: SwitchRow | undefined, more: Partial<PeekInput> = {}): PeekInput => ({
  row,
  rel: "notes/simmering.md",
  doc,
  view,
  words: 58,
  minutes: 1,
  summary: undefined,
  ...more,
})
const text = (r: Span[]) =>
  r
    .map((s) => s.text)
    .join("")
    .trimEnd()
const texts = (rs: Span[][]) => rs.map(text)
/** the body: the rows after the rule */
const body = (rs: Span[][]) => texts(rs.slice(rs.findIndex((r) => text(r) === "─".repeat(W)) + 1))

test("switchSplit: a split from 100 columns, the list a little over half the inside", () => {
  expect(switchSplit(99)).toEqual({ split: false, width: 70, listW: 68, peekW: 0 })
  expect(switchSplit(120)).toEqual({ split: true, width: 108, listW: 58, peekW: 41 })
  expect(switchSplit(200).width).toBe(116)
  const s = switchSplit(100)
  expect(s.listW + 1 + s.peekW + 6).toBe(s.width - 2) // list, divider, pane (padding 2 left, 4 right)
})

test("peekLines: a note hit shows the path and length, the H1 over its outline, then the first rendered lines", () => {
  const rs = peekLines(input(note), t, W, 30)
  expect(text(rs[0]!)).toBe("notes/simmering.md" + " ".repeat(W - 18 - 16) + "58 words · 1 min")
  expect(rs[0]!.every((s) => s.fg === t.textMuted || !s.text.trim())).toBe(true)
  expect(text(rs[1]!)).toBe("")
  expect(rs[2]).toEqual([{ text: "Simmering notes", fg: t.text, attr: 1 }])
  expect(texts(rs.slice(3, 6))).toEqual([" ├ A tiny stock", " ├ Heat levels", " └ Later"])
  expect(rs[3]!.find((s) => s.text.includes("├"))!.fg).toBe(t.borderSubtle)
  expect(rs[3]!.find((s) => s.text === "A tiny stock")!.fg).toBe(t.textMuted)
  expect(rs.find((r) => text(r) === "─".repeat(W))![0]!.fg).toBe(t.border)
  // real rendered spans: the highlight keeps its own style; blank runs collapse to one
  expect(body(rs).slice(0, 3)).toEqual(["A slow read beats a fast scroll.", "", "Second line."])
  const first = rs[rs.findIndex((r) => text(r) === "─".repeat(W)) + 1]!
  expect(first.some((s) => s.text.includes("slow read") && s.bg !== undefined)).toBe(true)
})

test("peekLines: a heading hit marks its heading in primary and starts after it", () => {
  const row: SwitchRow = { kind: "heading", ...base, heading: 2, text: "Heat levels", hits: [] }
  const rs = peekLines(input(row), t, W, 30)
  const cur = rs.find((r) => text(r).endsWith("Heat levels"))!
  expect(cur.find((s) => s.text === "Heat levels")!.fg).toBe(t.primary)
  expect(rs.find((r) => text(r).endsWith("A tiny stock"))!.find((s) => s.text === "A tiny stock")!.fg).toBe(t.textMuted)
  expect(body(rs)[0]).toBe("Heat body.")
})

test("peekLines: a text hit starts at its line", () => {
  const row: SwitchRow = { kind: "text", ...base, heading: 0, line: 9, context: "Second line.", hits: [] }
  const rs = peekLines(input(row), t, W, 30)
  expect(body(rs)[0]).toBe("Second line.")
  const answer: SwitchRow = {
    kind: "answer",
    ...base,
    heading: 1,
    text: "A tiny stock",
    key: "a tiny stock",
    ord: 0,
    id: "x",
    query: "stock",
    hits: [],
    right: "",
  }
  expect(body(peekLines(input(answer), t, W, 30))[0]).toBe("Stock body.")
})

test("peekLines: a fresh TL;DR is * and at most PEEK_TLDR rows hung under it, no label or model", () => {
  const rs = peekLines(input(note, { summary: { text: "A tour of what brothy renders.", model: "haiku" } }), t, W, 30)
  const at = rs.findIndex((r) => text(r) === "* A tour of what brothy renders.")
  expect(at).toBeGreaterThan(0)
  expect(rs[at]).toEqual([
    { text: "*", fg: t.primary },
    { text: " A tour of what brothy renders.", fg: t.text },
  ])
  expect(text(rs[at - 1]!)).toBe("") // after a blank row
  expect(texts(rs).some((x) => x.includes("haiku") || x.includes("TL;DR"))).toBe(false)
  const long = peekLines(input(note, { summary: { text: "word ".repeat(60), model: "m" } }), t, W, 30)
  const from = long.findIndex((r) => text(r).startsWith("* word"))
  const sum = texts(long.slice(from, from + PEEK_TLDR + 1))
  expect(sum.slice(1, PEEK_TLDR).every((x) => x.startsWith("  word"))).toBe(true)
  expect(sum[PEEK_TLDR - 1]!.endsWith(" …")).toBe(true)
  expect(sum[PEEK_TLDR]).toBe("")
  expect(texts(peekLines(input(note), t, W, 30)).some((x) => x.startsWith("* "))).toBe(false)
})

test("peekLines: header and action rows peek nothing; an unindexed note says indexing…", () => {
  expect(peekLines(input({ kind: "header", title: "Notes", count: "1" }), t, W, 30)).toEqual([])
  expect(peekLines(input(undefined), t, W, 30)).toEqual([])
  const rs = texts(peekLines(input(note, { doc: undefined, view: undefined, words: undefined }), t, W, 30))
  expect(rs[0]).toBe("notes/simmering.md")
  expect(rs).toContain("simmering")
  expect(rs.at(-1)).toBe("indexing…")
})

test("peekLines: a long path is cut from the left, next to the length", () => {
  const rs = peekLines(input(note, { rel: "a/".repeat(30) + "simmering.md" }), t, W, 30)
  expect(text(rs[0]!)).toBe("…" + "a/".repeat(5) + "simmering.md 58 words · 1 min")
})

test("peekLines: the outline is a tree; its window keeps the hit's heading in view and marks more with …", () => {
  const nested = "# Top\n\n## a\n\n### a1\n\n### a2\n\n## b\n\nbody\n"
  const d1 = indexNote(nested, 1, nested.length)
  const rs = peekLines(input(note, { doc: d1, view: render(nested, W, t) }), t, W, 30)
  expect(texts(rs.slice(3, 7))).toEqual([" ├ a", " │ ├ a1", " │ └ a2", " └ b"])

  const src = Array.from({ length: 12 }, (_, i) => `## H${i}\n\nbody ${i}\n`).join("\n")
  const d = indexNote(src, 1, src.length)
  const row: SwitchRow = { kind: "heading", ...base, heading: 8, text: "H8", hits: [] }
  const ls = peekLines(input(row, { doc: d, view: render(src, W, t) }), t, W, 20)
  const outline = texts(ls).filter((x) => /^ [├└] H\d+$/.test(x))
  expect(outline).toHaveLength(5)
  expect(outline).toContain(" ├ H8")
  expect(texts(ls).filter((x) => x.trim() === "…")).toHaveLength(2) // more above and below
  expect(text(ls[2]!)).toBe("simmering") // no single H1: the note's name is the title
  expect(ls.length).toBeLessThanOrEqual(20)
})

// a note far over PEEK_BYTES: front matter, a lead-in, 60 sections of ~1 KB, a fence across a section's end
const PARA = "Simmer the stock slowly and skim it often; patience is the whole recipe here. ".repeat(12).trim()
const BIG =
  "---\ntitle: big\n---\nLead-in paragraph.\n\n" +
  Array.from(
    { length: 60 },
    (_, i) => `## Part ${i}\n\n${PARA}\n\nline ${i} marker\n\n\`\`\`js\nconst part = ${i}\n\`\`\`\n`,
  ).join("\n")
const bigDoc = indexNote(BIG, 1, BIG.length)
const bigLines = normalize(BIG).split("\n")
const bigFm = parseFrontMatter(BIG).offset
const bigFull = render(parseFrontMatter(BIG).body, W, t)
/** The pane as the whole note renders it and as its window renders it: the look must not change. */
function both(row: SwitchRow) {
  const win = peekWindow(bigLines, bigFm, bigDoc, row)
  const view = render(bigLines.slice(win.from, win.to).join("\n"), W, t)
  const at = (v: typeof view, b: number) =>
    peekLines({ row, rel: "big.md", doc: bigDoc, view: v, base: b, words: 1, minutes: 1, summary: undefined }, t, W, 30)
  return { win, full: at(bigFull, 0), part: at(view, win.base) }
}

test("peekWindow: a heading hit starts at its heading, a bounded slice cut at a line; the pane looks the same", () => {
  const row: SwitchRow = { kind: "heading", ...base, heading: 10, text: "Part 10", hits: [] }
  const { win, full, part } = both(row)
  expect(win.from).toBe(bigDoc.headings[10]!.line)
  expect(win.base).toBe(10)
  const size = bigLines.slice(win.from, win.to).join("\n").length
  expect(size).toBeGreaterThan(PEEK_BYTES)
  expect(size).toBeLessThan(PEEK_BYTES + PARA.length + 2)
  expect(part).toEqual(full)
  expect(body(part)[0]).toStartWith("Simmer the stock")
})

test("peekWindow: a note hit (no single H1) starts after the front matter; text and answer hits look the same", () => {
  const note = both({ kind: "note", ...base, hits: [] })
  expect(note.win).toMatchObject({ from: bigFm, base: 0 })
  expect(note.part).toEqual(note.full)
  expect(body(note.part)[0]).toBe("Lead-in paragraph.")
  const line = bigLines.indexOf("line 33 marker")
  const text = both({ kind: "text", ...base, heading: 33, line, context: "line 33 marker", hits: [] })
  expect(text.part).toEqual(text.full)
  expect(body(text.part)[0]).toBe("line 33 marker")
  const answer = both({
    kind: "answer",
    ...base,
    heading: 59,
    text: "Part 59",
    key: "part 59",
    ord: 0,
    id: "x",
    query: "q",
    hits: [],
    right: "",
  })
  expect(answer.win.to).toBe(bigLines.length) // the last section runs to the end
  expect(answer.part).toEqual(answer.full)
})

test("peekWindow: a text hit past PEEK_BYTES into its section is still inside the window", () => {
  const long =
    "# Long\n\n" + Array.from({ length: 2000 }, (_, i) => `row ${i} of a very long single section`).join("\n\n") + "\n"
  const d = indexNote(long, 1, long.length)
  const lines = normalize(long).split("\n")
  const line = lines.indexOf("row 1900 of a very long single section")
  const w = peekWindow(lines, 0, d, { kind: "text", ...base, heading: 0, line, context: "", hits: [] })
  expect(w.from).toBe(0)
  expect(w.to).toBeGreaterThan(line)
})
