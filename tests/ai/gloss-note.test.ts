// The zen gloss's note, pure: a reply kept to its finished sentences, the rule's tail, the bottom sheet, the margin.
import { describe, expect, test } from "bun:test"
import {
  GLOSS_MAX,
  GLOSS_ROWS,
  GLOSS_ROWS_OPEN,
  type GlossView,
  glossTail,
  keepSentences,
  overflows,
  sheetFit,
  sheetRows,
} from "../../src/ai/gloss"
import type { Span } from "../../src/lib/spans"
import { width } from "../../src/lib/text"
import { mix, themeByName } from "../../src/theme/theme"
import { CARET, DIM_STALE, RULE, SIDENOTE_W } from "../../src/ui/footnote"
import { brothy } from "../helpers/theme"

const text = (spans: Span[]) => spans.map((s) => s.text).join("")
const said = (w: string, n: number) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ")

describe("keepSentences", () => {
  const sentence = (n: number) => `${"word ".repeat(n).trim()}.`

  test("a reply that fits is unchanged, 400 characters included", () => {
    expect(keepSentences("Short.")).toBe("Short.")
    const exact = "x".repeat(GLOSS_MAX - 1) + "."
    expect(keepSentences(exact)).toBe(exact)
  })

  test("past the cap: up to the last finished sentence that fits, no trailing space", () => {
    const three = [sentence(30), sentence(30), sentence(30)].join(" ") // 3 × 150 characters
    expect(three.length).toBe(452)
    const out = keepSentences(three)
    expect(out).toBe([sentence(30), sentence(30)].join(" "))
    expect(out.length).toBeLessThanOrEqual(GLOSS_MAX)
  })

  test("every sentence end counts, closing quotes and brackets too; 3.14 is none", () => {
    const pad = "x".repeat(380)
    for (const end of [".", "!", "?", "…", "。", '."', ".)", ".”"])
      expect(keepSentences(`${pad} ab${end} ${"y".repeat(40)}`, 400)).toBe(`${pad} ab${end}`)
    // not a sentence: the word cut instead
    expect(keepSentences(`${pad} pi 3.14 and ${"y".repeat(40)}`, 400)).toBe(`${pad} pi 3.14 and…`)
  })

  test("no sentence end within the cap: a word cut with …, no , or ; before it", () => {
    const words = `${"lorem ipsum, dolor; ".repeat(30)}end`
    const out = keepSentences(words)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(GLOSS_MAX)
    expect(out).not.toMatch(/[,;:\s]…$/)
  })

  test("no space at all: a hard cut with …, never inside a surrogate pair", () => {
    const out = keepSentences("x".repeat(500))
    expect(out).toBe(`${"x".repeat(GLOSS_MAX - 1)}…`)
    const emoji = keepSentences(`${"x".repeat(GLOSS_MAX - 2)}😀${"x".repeat(100)}`)
    expect(emoji.length).toBeLessThanOrEqual(GLOSS_MAX)
    expect([...emoji].every((ch) => !/^[\uD800-\uDFFF]$/.test(ch))).toBe(true)
  })

  test("idempotent", () => {
    for (const x of [said("w", 120), "x".repeat(500), `${sentence(50)} ${sentence(50)}`])
      expect(keepSentences(keepSentences(x))).toBe(keepSentences(x))
  })
})

const view = (o: Partial<GlossView> = {}): GlossView => ({
  state: "result",
  index: 0,
  text: "Pears ripen off the tree.",
  old: "",
  open: false,
  fadeAt: null,
  model: "llama3.2",
  secs: 0,
  stale: null,
  ...o,
})

describe("glossTail", () => {
  test("every state's words, keyed on a, the status cut first", () => {
    const tail = (o: Partial<GlossView>, overflow = false, open = false) => glossTail(view(o), overflow, open)
    expect(tail({ state: "waiting" })).toEqual({
      status: "asking llama3.2",
      model: "llama3.2",
      key: "a",
      word: "cancel",
      drop: "status",
    })
    expect(tail({ state: "waiting", secs: 3 })!.status).toBe("asking llama3.2 · 3 s")
    const long = tail({ state: "waiting", model: "m".repeat(40) })!
    expect(long.status).toBe(`asking ${"m".repeat(23)}…`)
    expect(long.status).toContain(long.model!)
    expect(tail({ state: "streaming" })).toEqual({ key: "a", word: "cancel", drop: "status" })
    expect(tail({}, true)).toEqual({ key: "a", word: "more", drop: "status" })
    expect(tail({})).toBeNull()
    expect(tail({ open: true }, true, true)!.word).toBe("less")
    expect(tail({ state: "outdated", stale: "edited" })).toEqual({
      status: "edited since",
      key: "a",
      word: "refresh",
      drop: "status",
    })
    expect(tail({ state: "outdated", stale: "version" })!.status).toBe("older version")
  })
})

describe("sheetFit", () => {
  test("the room below the reading row and the row under it", () => {
    expect(sheetFit(3, 4)).toBeNull()
    expect(sheetFit(3, 5)).toEqual({ gap: false, text: 1 })
    expect(sheetFit(3, 6)).toEqual({ gap: false, text: 1 })
    expect(sheetFit(3, 11)).toEqual({ gap: true, text: 3 })
    expect(sheetFit(8, 11)).toEqual({ gap: true, text: 3 })
    expect(sheetFit(8, 21)).toEqual({ gap: true, text: 8 })
    expect(sheetFit(8, 32)).toEqual({ gap: true, text: 8 })
    expect(sheetFit(1, 21)).toEqual({ gap: true, text: 1 })
  })

  test("never reaches the reading row", () => {
    for (let CH = 4; CH <= 40; CH++) {
      const fit = sheetFit(GLOSS_ROWS_OPEN, CH)
      if (fit) expect(CH - fit.text - 1 - Number(fit.gap)).toBeGreaterThan(Math.floor(CH / 2))
    }
  })
})

describe("sheetRows", () => {
  const CW = 72
  const CH = 21
  const long = said("pear", 60)

  test.each([brothy, themeByName("brothy-light")])(
    "the rule: CW wide, RULE × ─ in border, the tail right-aligned",
    (t) => {
      const rows = sheetRows(t, view({ text: long }), CW, CH)
      const rule = rows[1]!
      expect(width(text(rule))).toBe(CW)
      expect(rule[0]).toEqual({ text: "─".repeat(RULE), fg: t.border })
      expect(text(rule).endsWith("a more")).toBe(true)
      expect(rule.find((s) => s.text === "a")!.fg).toBe(t.text)
      expect(rule.at(-1)).toEqual({ text: " more", fg: t.textMuted })
    },
  )

  test("a narrow sheet: the rule shrinks, then the model goes, the key stays", () => {
    const rule = text(sheetRows(brothy, view({ state: "waiting", text: "", secs: 3 }), 30, CH)[1]!)
    expect(width(rule)).toBe(30)
    expect(rule.endsWith("a cancel")).toBe(true)
    expect(rule.startsWith("────")).toBe(true)
  })

  test("waiting: the gap row, the rule, ¹ ▍", () => {
    const rows = sheetRows(brothy, view({ state: "waiting", text: "" }), CW, CH)
    expect(rows.map(text).map((r) => r.trimEnd())).toEqual([
      "",
      `${"─".repeat(RULE)}${" ".repeat(CW - RULE - "asking llama3.2 · a cancel".length)}asking llama3.2 · a cancel`,
      `¹ ${CARET}`,
    ])
    expect(rows[2]!.at(-1)).toEqual({ text: CARET, fg: brothy.text })
    expect(rows[2]![0]).toEqual({ text: "¹", fg: brothy.primary })
  })

  test("streaming grows a row at a time to 3, the last rows with the caret last", () => {
    const at = (n: number) => sheetRows(brothy, view({ state: "streaming", text: said("pear", n) }), CW, CH)
    expect(at(2)).toHaveLength(3)
    expect(at(14)).toHaveLength(2 + 2)
    expect(at(60)).toHaveLength(2 + GLOSS_ROWS)
    const rows = at(60)
    expect(rows.at(-1)!.at(-1)).toEqual({ text: CARET, fg: brothy.text })
    expect(rows.map(text).join("")).not.toContain("…")
    expect(text(rows[1]!).endsWith("a cancel")).toBe(true)
  })

  test("done: 3 rows cut with …, a hanging indent of 2; expanded: up to 8", () => {
    const rows = sheetRows(brothy, view({ text: long }), CW, CH)
    expect(rows).toHaveLength(2 + GLOSS_ROWS)
    expect(text(rows.at(-1)!).endsWith("…")).toBe(true)
    expect(text(rows[3]!).startsWith("  pear")).toBe(true)
    const open = sheetRows(brothy, view({ text: long, open: true }), CW, CH)
    expect(open.length).toBeGreaterThan(2 + GLOSS_ROWS)
    expect(open.length).toBeLessThanOrEqual(2 + GLOSS_ROWS_OPEN)
    expect(text(open[1]!).endsWith("a less")).toBe(true)
    expect(text(sheetRows(brothy, view(), CW, CH)[1]!).trimEnd()).toBe("─".repeat(RULE))
  })

  test("colours: the mark primary, the text muted; outdated: the mark muted, the text dimmed", () => {
    const t = brothy
    const fresh = sheetRows(t, view(), CW, CH)[2]!
    expect(fresh[0]).toEqual({ text: "¹", fg: t.primary })
    expect(fresh[1]!.fg).toBe(t.textMuted)
    const stale = sheetRows(t, view({ state: "outdated", stale: "edited" }), CW, CH)
    expect(stale[2]![0]!.fg).toBe(t.textMuted)
    expect(stale[2]![1]!.fg).toBe(mix(t.textMuted, t.background, DIM_STALE))
    expect(text(stale[1]!).endsWith("edited since · a refresh")).toBe(true)
  })

  test("no room: nothing; a fade goes over every colour", () => {
    expect(sheetRows(brothy, view(), CW, 4)).toEqual([])
    const faded = sheetRows(brothy, view({ text: long }), CW, CH, () => "#000000")
    expect(faded.flat().every((s) => s.fg === undefined || s.fg === "#000000")).toBe(true)
  })

  test("overflows: by the note's own wrapping", () => {
    expect(overflows(long, CW, GLOSS_ROWS)).toBe(true)
    expect(overflows("Short.", CW, GLOSS_ROWS)).toBe(false)
    expect(overflows(said("w", 60), SIDENOTE_W, 6)).toBe(true)
  })
})
