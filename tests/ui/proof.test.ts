import { describe, expect, test } from "bun:test"
import { type Change, diffSections, type Op } from "../../src/ai/delta"
import { A } from "../../src/lib/spans"
import { width } from "../../src/lib/text"
import { headingKey } from "../../src/markdown/sections"
import { themeByName } from "../../src/theme/theme"
import type { ChangeView } from "../../src/ui/panel"
import {
  blockAt,
  blockRow,
  PROOF_CAP,
  type ProofRow,
  proofMarkW,
  proofRows,
  proofSpans,
  proofTop,
  proofWidth,
  windowLine,
} from "../../src/ui/proof"

const t = themeByName("brothy")
const text = (spans: { text: string }[]) => spans.map((s) => s.text).join("")

const edit = (name: string, ops: Op[][], extra: Partial<Change> = {}): Change => ({
  status: "edited",
  index: 0,
  path: ["Doc", name],
  key: headingKey(name),
  ord: 0,
  plus: ops.flat().filter((o) => o.op === "+").length,
  minus: ops.flat().filter((o) => o.op === "-").length,
  hunks: ops.map((o) => ({ ops: o })),
  rewritten: false,
  newText: "",
  ...extra,
})
const lines = (op: Op["op"], n: number): Op[] => Array.from({ length: n }, (_, i) => ({ op, text: `line ${i + 1}` }))
const view = (changes: Change[] | null, over: Partial<ChangeView> = {}): ChangeView => ({
  state: "idle",
  since: "09:23",
  model: "",
  secs: 0,
  changes,
  summary: "",
  notes: [],
  error: null,
  open: false,
  ai: true,
  earlier: null,
  ...over,
})
const simmer = edit("How long to simmer", [
  [
    { op: " ", text: "Bring the pot to a boil once." },
    { op: "-", text: "Simmer chicken broth for 3 to 4 hours." },
    { op: "+", text: "Simmer chicken broth for 4 to 6 hours." },
  ],
  [
    { op: " ", text: "Skim as you go." },
    { op: "+", text: "Salt late." },
  ],
])
const removed: Change = {
  ...edit("Skim as you go", [lines("-", 3)], { index: 1, status: "removed", after: 0 }),
  plus: 0,
}
const added: Change = { ...edit("Storing", [lines("+", 2)], { index: 2, status: "added" }), minus: 0 }
const kinds = (rows: ProofRow[]) => rows.map((r) => r.kind)

describe("proofRows", () => {
  test("idle: a block per change in list order, each followed by its diff, no summary and no notes", () => {
    const rows = proofRows(view([simmer, removed, added]), "Doc", 70)
    expect(rows.filter((r) => r.kind === "block").map((r) => r.kind === "block" && r.name)).toEqual([
      "How long to simmer",
      "Skim as you go",
      "Storing",
    ])
    expect(kinds(rows)).toEqual([
      "block", // simmer
      "diff",
      "diff",
      "diff",
      "gap",
      "diff",
      "diff",
      "block", // removed
      "diff",
      "diff",
      "diff",
      "block", // added
      "diff",
      "diff",
    ])
  })

  test("a block carries the counts, `new` for an added section, a removed one muted", () => {
    const blocks = proofRows(view([simmer, removed, added]), "Doc", 70).filter((r) => r.kind === "block")
    expect(blocks.map((b) => b.kind === "block" && [b.counts, b.muted, b.removed])).toEqual([
      ["+2 −1", false, false],
      ["−3", true, true],
      ["new", false, false],
    ])
  })

  test("the lead-in is named by the note's title", () => {
    const lead = edit("x", [lines("+", 1)], { index: -1, path: [] })
    const [b] = proofRows(view([lead]), "Welcome", 70)
    expect(b).toMatchObject({ kind: "block", name: "Welcome" })
  })

  test("hunks keep their ops in order with a gap row between hunks only", () => {
    const rows = proofRows(view([simmer]), "Doc", 70)
    expect(rows.filter((r) => r.kind === "diff").map((r) => r.kind === "diff" && r.op)).toEqual([
      " ",
      "-",
      "+",
      " ",
      "+",
    ])
    expect(rows.filter((r) => r.kind === "gap")).toHaveLength(1)
  })

  test("notes show only once explained, under their block, hung and cut at two rows", () => {
    const notes = [{ what: "chicken simmer time raised to four to six hours, and a lot more words follow here" }]
    const idle = proofRows(view([simmer], { notes }), "Doc", 40)
    expect(kinds(idle)).not.toContain("note")
    const done = proofRows(view([simmer], { state: "result", notes, summary: "Simmer longer." }), "Doc", 40)
    const n = done.filter((r) => r.kind === "note")
    expect(n).toHaveLength(2)
    expect(n.at(-1)!.kind === "note" && n.at(-1)!.text.endsWith("…")).toBe(true)
    expect(kinds(done).indexOf("note")).toBe(kinds(done).indexOf("block") + 1)
  })

  test("a summary goes on top (five rows at most), with a caret while it streams", () => {
    const summary = "Chicken now simmers longer. ".repeat(12)
    const rows = proofRows(view([simmer], { state: "result", summary }), "Doc", 40)
    const top = rows.filter((r) => r.kind === "summary")
    expect(top).toHaveLength(5)
    expect(top.map((r) => r.kind === "summary" && r.first)).toEqual([true, false, false, false, false])
    expect(kinds(rows).slice(0, 5)).toEqual(Array(5).fill("summary"))
    const live = proofRows(view([simmer], { state: "loading", model: "m", summary: "Chicken now" }), "Doc", 40)
    expect(live[0]).toMatchObject({ kind: "summary", text: "Chicken now▍" })
  })

  test("waiting with nothing streamed yet: the status row alone on top", () => {
    const rows = proofRows(view([simmer], { state: "loading", model: "llama3.2", secs: 3 }), "Doc", 60)
    expect(rows[0]).toEqual({ kind: "status", model: "llama3.2", secs: 3 })
    expect(kinds(rows).filter((k) => k === "summary")).toHaveLength(0)
  })

  test("an error on top, two rows at most, the blocks below it", () => {
    const error = "500 from localhost:11434 · the server said something very long about why it could not do it"
    const rows = proofRows(view([simmer], { state: "error", error }), "Doc", 30)
    expect(kinds(rows).slice(0, 3)).toEqual(["error", "error", "block"])
    expect(rows[0]).toMatchObject({ first: true })
  })

  test("too large to compare has no rows", () => {
    expect(proofRows(view(null, { state: "large" }), "Doc", 70)).toEqual([])
  })

  test("an added or removed section past the cap: PROOF_CAP lines, then `more` with the rest", () => {
    const big = edit("Big", [lines("-", PROOF_CAP + 12)], { status: "removed", after: null })
    const rows = proofRows(view([big]), "Doc", 70)
    expect(rows.filter((r) => r.kind === "diff")).toHaveLength(PROOF_CAP)
    expect(rows.at(-1)).toEqual({ kind: "more", at: 0, op: "-", n: 12 })
    const exact = proofRows(view([edit("Big", [lines("+", PROOF_CAP)], { status: "added" })]), "Doc", 70)
    expect(exact.at(-1)!.kind).toBe("diff")
  })

  test("a rewritten section shows its new text as added lines under a muted row", () => {
    const re = edit("Soup", [], { rewritten: true, newText: "## Soup\nstock\nsalt" })
    const rows = proofRows(view([re]), "Doc", 70)
    expect(kinds(rows)).toEqual(["block", "rewritten", "diff", "diff", "diff"])
    expect(rows.filter((r) => r.kind === "diff").map((r) => r.kind === "diff" && [r.op, r.text])).toEqual([
      ["+", "## Soup"],
      ["+", "stock"],
      ["+", "salt"],
    ])
  })

  test("every row of a real diff fits the width, even a long line and a wide character", () => {
    const before = "# T\n\n## A\n\n" + "word ".repeat(40) + "1\n\n猫".repeat(5) + "\n"
    const after = before.replace("1\n", "2\n").replace("猫猫", "犬犬")
    const rows = proofRows(view(diffSections(before, after)), "T", 50)
    for (const r of rows)
      expect(width(text(proofSpans(r, t, { room: 50, markW: 1, sel: false })))).toBeLessThanOrEqual(50)
  })

  test("the mark column is as wide as the widest number", () => {
    const many = Array.from({ length: 12 }, (_, i) => edit(`S${i}`, [lines("+", 1)]))
    expect(proofMarkW(many)).toBe(2)
    expect(proofMarkW([simmer])).toBe(1)
  })
})

describe("windowLine", () => {
  test("a line that fits is left alone", () => {
    expect(windowLine("short", 20, 3)).toEqual({ text: "short", cutL: false, cutR: false })
  })

  test("a long line is cut around the change with … on the cut sides, never wider than the room", () => {
    const line = "Simmer chicken broth for 3 to 4 hours and beef bones for 8 to 12 hours, then strain it."
    const w = windowLine(line, 30, 24)
    expect(w.cutL && w.cutR).toBe(true)
    expect(w.text).toContain("3 to 4")
    expect(width(w.text) + 2).toBeLessThanOrEqual(30)
    const start = windowLine(line, 30, 0)
    expect(start.cutL).toBe(false)
    expect(start.cutR).toBe(true)
    expect(line.startsWith(start.text)).toBe(true)
    expect(width(start.text) + 1).toBeLessThanOrEqual(30)
  })

  test("a change near the end shows the tail without a right cut", () => {
    const line = "x".repeat(60) + " end"
    const w = windowLine(line, 20, 60)
    expect(w).toMatchObject({ cutL: true, cutR: false })
    expect(w.text.endsWith(" end")).toBe(true)
    expect(width(w.text) + 1).toBeLessThanOrEqual(20)
  })

  test("wide characters are never split and never overflow", () => {
    const line = "猫".repeat(30)
    for (const at of [0, 7, 30, 59]) {
      const w = windowLine(line, 21, at)
      expect(width(w.text) + Number(w.cutL) + Number(w.cutR)).toBeLessThanOrEqual(21)
      expect(w.text).toMatch(/^猫*$/)
    }
  })

  test("a room too small for a window is plainly truncated", () => {
    expect(windowLine("abcdef", 2, 3).text).toBe("a…")
  })
})

describe("diff lines window around the change", () => {
  test("a removed and an added line are cut at the same column, where they first differ", () => {
    const old = "Simmer chicken broth for 3 to 4 hours and beef bones for 8 to 12 hours."
    const hunk = [
      { op: "-" as const, text: old },
      { op: "+" as const, text: old.replace("3 to 4", "4 to 6") },
    ]
    const rows = proofRows(view([edit("S", [hunk])]), "Doc", 40).filter((r) => r.kind === "diff")
    const [a, b] = rows.map((r) => (r.kind === "diff" ? r.text : ""))
    expect(a).toContain("3 to 4")
    expect(b).toContain("4 to 6")
    expect(a!.slice(0, 8)).toBe(b!.slice(0, 8))
  })
})

describe("blockAt / blockRow / proofTop", () => {
  const rows = proofRows(view([simmer, removed, added], { state: "result", summary: "Simmer longer." }), "Doc", 70)

  test("a row knows its change; rows above the blocks have none", () => {
    expect(blockAt(rows, 0)).toBeNull()
    expect(blockAt(rows, blockRow(rows, 1) + 1)).toBe(1)
    expect(blockAt(rows, 999)).toBeNull()
  })

  test("the first block shows from the very top, the summary above it", () => {
    expect(blockRow(rows, 0)).toBe(1)
    expect(proofTop(rows, 0, 5, 10)).toBe(0)
  })

  test("moves the least that shows the header and the row under it", () => {
    const h = 6
    const from = blockRow(rows, 2)
    expect(proofTop(rows, 2, 0, h)).toBe(from + 2 - h)
    expect(proofTop(rows, 2, from + 2 - h, h)).toBe(from + 2 - h)
    expect(proofTop(rows, 1, rows.length, h)).toBeLessThanOrEqual(blockRow(rows, 1))
  })

  test("never past the last row; a one-row window still shows the header", () => {
    expect(proofTop(rows, 2, 0, 100)).toBe(0)
    expect(proofTop(rows, 2, 0, 1)).toBe(blockRow(rows, 2))
  })
})

describe("proofSpans", () => {
  const row = (r: ProofRow, sel = false, markW = 1, room = 40) => proofSpans(r, t, { room, markW, sel })

  test("a block: cursor bar when highlighted, the number, the name bold, the counts at the right edge", () => {
    const b: ProofRow = { kind: "block", at: 0, name: "Simmer", counts: "+2 −1", muted: false, removed: false }
    const sel = row(b, true)
    expect(text(sel)).toBe("▌¹ Simmer" + " ".repeat(40 - 9 - 5) + "+2 −1")
    expect(sel[0]).toMatchObject({ text: "▌", fg: t.primary })
    expect(sel.find((s) => s.text === "Simmer")!.attr! & A.BOLD).toBeTruthy()
    expect(text(row(b, false)).startsWith(" ¹ Simmer")).toBe(true)
    expect(sel[1]).toMatchObject({ fg: t.primary })
  })

  test("a muted or removed block has a muted number; a removed name is struck through", () => {
    const r: ProofRow = { kind: "block", at: 1, name: "Skim", counts: "−3", muted: true, removed: true }
    const spans = row(r)
    expect(spans[1]).toMatchObject({ text: "²", fg: t.textMuted })
    expect(spans.find((s) => s.text === "Skim")!.attr! & A.STRIKE).toBeTruthy()
  })

  test("diff lines: − in error with muted text, + in success with the text role, context muted", () => {
    const d = (op: Op["op"], s: string): ProofRow => ({ kind: "diff", at: 0, op, text: s, cutL: false, cutR: false })
    const minus = row(d("-", "old"))
    const plus = row(d("+", "new"))
    const ctx = row(d(" ", "same"))
    expect(text(minus)).toBe("   − old")
    expect(minus[1]).toMatchObject({ text: "−", fg: t.error })
    expect(minus.at(-1)).toMatchObject({ text: "old", fg: t.textMuted })
    expect(plus[1]).toMatchObject({ text: "+", fg: t.success })
    expect(plus.at(-1)).toMatchObject({ text: "new", fg: t.text })
    expect(text(ctx)).toBe("     same")
    expect(ctx.at(-1)).toMatchObject({ fg: t.textMuted })
  })

  test("a cut line gets a muted … on the cut side", () => {
    const spans = row({ kind: "diff", at: 0, op: "+", text: "mid", cutL: true, cutR: true })
    expect(text(spans)).toBe("   + …mid…")
  })

  test("summary and error rows: Δ and ✗ in the mark column on the first row, text hung under", () => {
    const first = row({ kind: "summary", first: true, text: "Longer." })
    const next = row({ kind: "summary", first: false, text: "more" })
    expect(text(first)).toBe(" Δ Longer.")
    expect(first[1]).toMatchObject({ fg: t.primary })
    expect(text(next)).toBe("   more")
    expect(row({ kind: "error", first: true, text: "boom" })[1]).toMatchObject({ text: "✗", fg: t.error })
  })

  test("the waiting row, the more row and the rewritten row", () => {
    expect(text(row({ kind: "status", model: "llama3.2", secs: 3 }))).toBe(" ▍ asking llama3.2 · 3 s")
    expect(text(row({ kind: "more", at: 0, op: "-", n: 12 }))).toBe("   − … 12 more lines")
    expect(text(row({ kind: "more", at: 0, op: "+", n: 1 }))).toBe("   + … 1 more line")
    expect(text(row({ kind: "rewritten", at: 0 }))).toBe("   rewritten · showing the new text")
    expect(text(row({ kind: "gap", at: 0 }))).toBe("     …")
  })

  test("a note aligns under the name; a wider mark column pushes everything right", () => {
    expect(text(row({ kind: "note", at: 0, text: "raised" }))).toBe("   raised")
    expect(text(row({ kind: "note", at: 0, text: "raised" }, false, 2))).toBe("    raised")
  })
})

describe("proofWidth", () => {
  test("the screen less its margin below 100 columns, the split popup's from there", () => {
    expect(proofWidth(80)).toBe(78)
    expect(proofWidth(99)).toBe(97)
    expect(proofWidth(100)).toBe(88)
    expect(proofWidth(200)).toBe(116)
  })
})
