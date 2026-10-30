// The AI family's footnote helpers: marks, the rule and its tail, waiting rows, hanging-indent notes, sidenotes.
import { describe, expect, test } from "bun:test"
import { type Span, safe } from "../../src/lib/spans"
import { width } from "../../src/lib/text"
import { themeByName } from "../../src/theme/theme"
import {
  CARET,
  DIM_OTHER,
  DIM_STALE,
  type FootInk,
  footInk,
  footnoteRule,
  type Mark,
  type MarkSource,
  MODEL_W,
  markFor,
  markText,
  noteRows,
  placeMark,
  RULE,
  RULE_MIN,
  SIDENOTE_GAP,
  SIDENOTE_MIN_W,
  SIDENOTE_ROWS,
  SIDENOTE_ROWS_OPEN,
  SIDENOTE_SUMMARY_ROWS,
  SIDENOTE_W,
  type SideNote,
  type Stale,
  sidenoteAt,
  sidenoteLayout,
  staleKind,
  staleTail,
  type Tail,
  waitingRow,
  waitSecs,
  waitText,
} from "../../src/ui/footnote"
import { layout } from "../../src/ui/layout"
import { MINI_W } from "../../src/ui/minimap"
import { ZEN_DEFAULTS } from "../../src/ui/zen"
import { brothy } from "../helpers/theme"

const THEMES = [brothy, themeByName("brothy-light")]
const t = brothy
const c = footInk(t)
const text = (spans: Span[]) => spans.map((s) => s.text).join("")
const at = (spans: Span[], s: string) => spans.find((x) => x.text === s)

test("constants", () => {
  expect([RULE, RULE_MIN, MODEL_W, CARET, DIM_STALE, DIM_OTHER]).toEqual([16, 4, 24, "▍", 0.4, 0.6])
  expect([SIDENOTE_MIN_W, SIDENOTE_GAP, SIDENOTE_W]).toEqual([140, 3, 30])
  expect([SIDENOTE_ROWS, SIDENOTE_ROWS_OPEN, SIDENOTE_SUMMARY_ROWS]).toEqual([6, 18, 5])
})

describe("marks", () => {
  test("markText: * and Δ plain, numbers in superscript", () => {
    const marks: Mark[] = ["*", "Δ", 1, 3, 10]
    expect(marks.map(markText)).toEqual(["*", "Δ", "¹", "³", "¹⁰"])
  })

  test("markFor: change, then ask, then gloss; the first of equals; none → null", () => {
    const m = (source: MarkSource, id = 0) => ({ source, id })
    expect(markFor([m("gloss"), m("ask"), m("change")])).toEqual(m("change"))
    expect(markFor([m("gloss"), m("ask")])).toEqual(m("ask"))
    expect(markFor([m("gloss", 1), m("gloss", 2)])).toEqual(m("gloss", 1))
    expect(markFor([])).toBeNull()
  })

  const sup: Span = { text: "¹", fg: c.mark }
  test("placeMark: right after the text, no space, trailing blanks ignored", () => {
    const row = [{ text: "## " }, { text: "Checkpoints", fg: t.primary }, { text: "   " }]
    const placed = placeMark(row, 20, sup)
    expect("inline" in placed && text(placed.inline)).toBe("## Checkpoints¹")
    expect("inline" in placed && placed.inline.at(-1)).toBe(sup)
    expect(placeMark([{ text: "Checkpoints  " }], 12, sup)).toEqual({ inline: [{ text: "Checkpoints" }, sup] })
  })

  test("placeMark: a full row and a rules-style fill row go to the gutter", () => {
    expect(placeMark([{ text: "x".repeat(20) }], 20, sup)).toEqual({ gutter: sup })
    const rules = [{ text: "── Short " }, { text: "─".repeat(11), fg: t.border }]
    expect(placeMark(rules, 20, sup)).toEqual({ gutter: sup })
    expect(placeMark([{ text: "x".repeat(19) }], 20, { text: "¹⁰" })).toEqual({ gutter: { text: "¹⁰" } })
  })
})

describe("footInk", () => {
  test("every role of the family table, in both brothy themes", () => {
    for (const th of THEMES) {
      const k = footInk(th)
      expect(k).toMatchObject({ mark: th.primary, markStale: th.textMuted, rule: th.border, error: th.error })
      expect([k.status, k.word, k.note]).toEqual([th.textMuted, th.textMuted, th.textMuted])
      expect([k.key, k.text, k.caret]).toEqual([th.text, th.text, th.text])
      expect(k.markOther).not.toBe(th.primary)
      expect(new Set([k.stale, k.other, th.textMuted, th.background]).size).toBe(4)
    }
  })

  test("a fade goes over every colour", () => {
    const faded = footInk(t, () => "#000000")
    expect(new Set(Object.values(faded) as FootInk[keyof FootInk][])).toEqual(new Set(["#000000"]))
  })
})

describe("staleness and waiting", () => {
  test("staleKind: the text wins over the prompt version", () => {
    const e = { hash: "h1", v: 1 }
    expect(staleKind(e, "h2", 1)).toBe("edited")
    expect(staleKind(e, "h1", 2)).toBe("version")
    expect(staleKind(e, "h1", 1)).toBeNull()
    expect(staleKind(e, "h2", 2)).toBe("edited")
  })

  test("staleTail", () => {
    const kinds: Stale[] = ["edited", "version"]
    expect(kinds.map((k) => staleTail(k, "a"))).toEqual([
      { status: "edited since", key: "a", word: "refresh" },
      { status: "older version", key: "a", word: "refresh" },
    ])
  })

  test("waitSecs: whole seconds, never negative", () => {
    expect([999, 1000, 3999, -50].map((ms) => waitSecs(10_000 + ms, 10_000))).toEqual([0, 1, 3, 0])
  })

  test("waitText: the seconds from 1 s; the model cut to MODEL_W, then to the room", () => {
    expect(waitText("llama3.2", 0)).toBe("asking llama3.2")
    expect(waitText("llama3.2", 3)).toBe("asking llama3.2 · 3 s")
    const long = waitText("deepseek-r1-distill-qwen-32b-instruct", 12)
    expect(long).toBe(`asking ${"deepseek-r1-distill-qwe"}… · 12 s`)
    expect(width(long) - width("asking  · 12 s")).toBe(MODEL_W)
    expect(waitText("llama3.2", 3, 16)).toBe("asking ll… · 3 s")
    expect(waitText("llama3.2", 3, 12)).toBe("asking · 3 s")
    expect(waitText("llama\x1b[31m", 0)).not.toContain("\x1b")
  })
})

describe("footnoteRule", () => {
  const row = (w: number, tail: Tail | null) => text(footnoteRule(t, w, tail))

  test("exactly `width` wide: RULE × ─ in border flush left, the tail right-aligned", () => {
    for (const th of THEMES) {
      const spans = footnoteRule(th, 60, { status: "edited since", key: "a", word: "refresh" })
      expect(text(spans)).toBe(`${"─".repeat(16)}${" ".repeat(60 - 16 - 24)}edited since · a refresh`)
      expect(spans[0]).toEqual({ text: "─".repeat(16), fg: th.border })
      expect(at(spans, "a")?.fg).toBe(th.text)
      expect(at(spans, " refresh")?.fg).toBe(th.textMuted)
      expect(at(spans, "edited since")?.fg).toBe(th.textMuted)
      expect(at(spans, " · ")?.fg).toBe(th.textMuted)
    }
    expect(row(40, null)).toBe("─".repeat(16) + " ".repeat(24))
  })

  test("the rule shrinks first (a 30-column panel)", () => {
    const model = "llama3.2"
    expect(row(30, { status: `TL;DR · ${model}`, model })).toBe(`${"─".repeat(13)} TL;DR · llama3.2`)
    expect(row(30, { status: waitText(model, 1), model })).toBe(`${"─".repeat(8)} asking llama3.2 · 1 s`)
    expect(row(30, staleTail("edited", "a"))).toBe(`${"─".repeat(5)} edited since · a refresh`)
    expect(row(30, { key: "a", word: "retry" })).toBe(`${"─".repeat(16)}${" ".repeat(7)}a retry`)
  })

  test("then the model (to …, then out), then the drop part; gloss keeps its key", () => {
    const model = "llama3.2"
    const wait: Tail = { status: waitText(model, 3), model }
    expect(row(20, wait)).toBe("──── asking l… · 3 s")
    expect(row(17, wait)).toBe("──── asking · 3 s")
    const gloss: Tail = { ...wait, key: "a", word: "cancel", drop: "status" }
    expect(row(40, gloss)).toBe("─────── asking llama3.2 · 3 s · a cancel")
    expect(row(30, gloss)).toBe("──── asking … · 3 s · a cancel")
    expect(row(20, gloss)).toBe(`${"─".repeat(11)} a cancel`)
    const tldr: Tail = { status: model, model, key: "a", word: "cancel" }
    expect(row(24, tldr)).toBe("──── llama3.2 · a cancel")
    expect(row(20, tldr)).toBe("──── lla… · a cancel")
    expect(row(13, tldr)).toBe("──── a cancel")
    expect(row(12, staleTail("edited", "a"))).toBe("──── edited…")
    expect(row(12, { ...staleTail("edited", "a"), drop: "status" })).toBe("─".repeat(12))
  })

  test("the key and its word can come first", () => {
    const more: Tail = { status: "llama3.2", model: "llama3.2", key: "⏎", word: "more", keyFirst: true }
    expect(row(30, more)).toBe(`${"─".repeat(12)} ⏎ more · llama3.2`)
    expect(row(16, more)).toBe("──── ⏎ more · l…")
  })

  test("never wider or narrower than `width`, never without its rule", () => {
    const tails: (Tail | null)[] = [
      null,
      { status: waitText("qwen2.5-coder:32b", 7), model: "qwen2.5-coder:32b", key: "a", word: "cancel" },
      { ...staleTail("version", "a"), drop: "status" },
      { status: "llama3.2", model: "llama3.2", key: "⏎", word: "less", keyFirst: true },
    ]
    for (const tail of tails)
      for (let w = 0; w <= 50; w++) {
        const spans = footnoteRule(t, w, tail)
        expect(width(text(spans))).toBe(w)
        const rule = spans[0]!.text
        expect(rule).toMatch(/^─*$/)
        expect(rule.length).toBeGreaterThanOrEqual(Math.min(w, RULE_MIN))
        expect(rule.length).toBeLessThanOrEqual(RULE)
      }
  })
})

describe("waitingRow", () => {
  test("slot shape: the mark and the caret where the text will be", () => {
    const row = waitingRow(t, { mark: 1, model: "llama3.2", secs: 3, status: false, width: 30 })
    expect(row).toEqual([{ text: "¹", fg: t.primary }, { text: " " }, { text: CARET, fg: t.text }])
    const regen = waitingRow(t, { mark: "*", model: "llama3.2", secs: 0, status: false, width: 30, stale: true })
    expect(regen[0]).toEqual({ text: "*", fg: t.textMuted })
  })

  test("status-row shape: the caret, then asking <model> · N s", () => {
    const row = (secs: number, w = 40) => waitingRow(t, { mark: null, model: "llama3.2", secs, status: true, width: w })
    expect(text(row(0))).toBe("▍ asking llama3.2")
    expect(text(row(3))).toBe("▍ asking llama3.2 · 3 s")
    expect(at(row(3), "asking llama3.2 · 3 s")?.fg).toBe(t.textMuted)
    expect(at(row(3), CARET)?.fg).toBe(t.text)
    expect(text(row(3, 18))).toBe("▍ asking ll… · 3 s")
    expect(width(text(row(3, 18)))).toBeLessThanOrEqual(18)
  })
})

describe("noteRows", () => {
  const words = "A good broth takes patience: bones and cold water held where the surface barely moves"

  test("the mark, a space, then a hanging indent of the same width", () => {
    const rows = noteRows(words, 24, 1, 9)
    expect(rows[0]!.startsWith("¹ A good")).toBe(true)
    expect(rows.slice(1).every((r) => r.startsWith("  ") && r[2] !== " ")).toBe(true)
    expect(rows.every((r) => width(r) <= 24)).toBe(true)
    expect(
      noteRows(words, 24, 10, 9)
        .slice(1)
        .every((r) => r.startsWith("   ")),
    ).toBe(true)
    expect(noteRows(words, 24, null, 9)[1]![0]).not.toBe(" ")
  })

  test("at most `max` rows, the last cut ` …` (or `…`) only when text is left", () => {
    const all = noteRows(words, 24, "*", 99)
    expect(all.length).toBeGreaterThan(3)
    expect(noteRows(words, 24, "*", all.length)).toEqual(all)
    const cut = noteRows(words, 24, "*", 3)
    expect(cut).toHaveLength(3)
    expect(cut[2]!.endsWith("…")).toBe(true)
    expect(noteRows(words, 30, "*", 2)[1]).toMatch(/ …$/)
    expect(noteRows(words, 24, "*", 3, { cut: "…" })[2]).toMatch(/[^ ]…$/)
  })

  test("tail: the last rows, uncut, the caret last", () => {
    const rows = noteRows(words + CARET, 24, 1, 2, { tail: true })
    expect(rows).toHaveLength(2)
    expect(rows[0]!.startsWith("¹ ")).toBe(true)
    expect(rows[1]!.endsWith(`moves${CARET}`)).toBe(true)
    expect(rows.join("")).not.toContain("…")
  })

  test("nothing to show; control characters; a token wider than the row", () => {
    expect(noteRows("   ", 24, 1, 3)).toEqual([])
    expect(noteRows(words, 2, 1, 3)).toEqual([])
    expect(noteRows("a\x1b[31mb\tc", 24, 1, 3)).toEqual([`¹ ${safe("a\x1b[31mb")} c`])
    expect(noteRows("x".repeat(200), 24, 1, 3).every((r) => width(r) <= 24)).toBe(true)
  })
})

describe("sidenoteAt", () => {
  const zenState = (measure: number) => ({ ...state, zen: true, zenCfg: { ...ZEN_DEFAULTS, measure } })
  const state = {
    hidden: true,
    drawerOpen: false,
    zen: false,
    source: false,
    zenCfg: ZEN_DEFAULTS,
    wide: false,
    minimap: false,
    openPath: "a.md",
  }
  /** the margin's column for the document at W columns: text from `layout()`, the right edge less the minimap */
  const marginFor = (W: number, s = state) => {
    const L = layout(W, 40, s)
    return sidenoteAt(W, 1 + L.padL + (L.inline ? L.SW + 1 : 0), L.CW, W - 1 - (L.mini ? MINI_W : 0))
  }
  const firstFit = (s: typeof state) => {
    for (let W = 100; W <= 240; W++) if (marginFor(W, s) !== null) return W
    return null
  }

  test("zen: from 140 columns at the default measure; a wider measure needs more", () => {
    expect(ZEN_DEFAULTS.measure).toBe(72)
    expect([80, 120, 139].map((W) => marginFor(W, zenState(72)))).toEqual([null, null, null])
    expect(marginFor(140, zenState(72))).toBe(109)
    expect(marginFor(150, zenState(72))).toBe(114)
    expect(marginFor(160, zenState(72))).toBe(119)
    expect([76, 80, 100].map((m) => marginFor(140, zenState(m)))).toEqual([null, null, null])
    expect(marginFor(160, zenState(100))).toBeNull()
    expect([72, 76, 80, 100].map((m) => firstFit(zenState(m)))).toEqual([140, 143, 147, 167])
  })

  test("Preview with the panel hidden: 147 columns, 155 with the minimap; never beside an inline panel", () => {
    expect(firstFit(state)).toBe(147)
    expect(firstFit({ ...state, minimap: true })).toBe(155)
    expect(marginFor(160, { ...state, minimap: true })).toBe(123)
    expect(marginFor(140, { ...state, minimap: true })).toBeNull()
    expect([140, 160, 180].map((W) => marginFor(W, { ...state, hidden: false }))).toEqual([null, null, null])
  })

  test("the floor holds even when the geometry would fit", () => {
    expect(sidenoteAt(139, 0, 72, 138)).toBeNull()
    expect(sidenoteAt(140, 0, 72, 139)).toBe(75)
  })
})

describe("sidenoteLayout", () => {
  const CH = 30
  const long =
    "Bones and cold water held where the surface barely moves, never a rolling boil, for hours on end, then strained through cloth and cooled before the fat is lifted off the top."
  const note = (n: number, row: number, extra: Partial<SideNote> = {}): SideNote => ({ n, row, text: long, ...extra })
  const rowsText = (rows: Span[][]) => rows.map(text)

  test("each note from its start row, one empty row before the next, cut ` …` there", () => {
    const out = sidenoteLayout(t, [note(2, 10), note(1, 4)], CH, { open: false })
    expect(out.map((p) => [p.n, p.row])).toEqual([
      [1, 4],
      [2, 10],
    ])
    expect(out[0]!.rows).toHaveLength(5)
    expect(rowsText(out[0]!.rows).at(-1)!.endsWith(" …")).toBe(true)
    expect(text(out[0]!.rows[0]!).startsWith("¹ Bones")).toBe(true)
    expect(text(out[1]!.rows[0]!).startsWith("² Bones")).toBe(true)
  })

  test("the last note stops at SIDENOTE_ROWS and the body's bottom", () => {
    expect(sidenoteLayout(t, [note(1, 0)], CH, { open: false })[0]!.rows).toHaveLength(SIDENOTE_ROWS)
    expect(sidenoteLayout(t, [note(1, CH - 2)], CH, { open: false })[0]!.rows).toHaveLength(2)
  })

  test("only what is on screen; the reading note stays on row 0 when its heading scrolls above", () => {
    const out = sidenoteLayout(t, [note(1, -5, { reading: true }), note(2, -3, { reading: false }), note(3, CH)], CH, {
      open: false,
    })
    expect(out.map((p) => [p.n, p.row])).toEqual([[1, 0]])
  })

  test("the reading note expanded ignores the cap and hides the notes it covers", () => {
    const longer = `${long} ${long} ${long}`
    const notes = [note(1, 2, { reading: true, text: longer }), note(2, 5, { reading: false }), note(3, 25)]
    const shut = sidenoteLayout(t, notes, CH, { open: false })
    expect(shut.map((p) => p.n)).toEqual([1, 2, 3])
    const open = sidenoteLayout(t, notes, CH, { open: true })
    expect(open.map((p) => p.n)).toEqual([1, 3])
    expect(open[0]!.rows.length).toBeGreaterThan(SIDENOTE_ROWS)
    expect(open[0]!.rows.length).toBeLessThanOrEqual(SIDENOTE_ROWS_OPEN)
    expect(open[1]!.row).toBeGreaterThan(open[0]!.row + open[0]!.rows.length)
  })

  test("a status row under the reading note, reserved first; dropped when only one row is left", () => {
    const status: Tail = {
      status: waitText("llama3.2", 3),
      model: "llama3.2",
      key: "a",
      word: "cancel",
      drop: "status",
    }
    const [r] = sidenoteLayout(t, [note(1, 0, { reading: true, status })], CH, { open: false })
    expect(r!.rows).toHaveLength(SIDENOTE_ROWS + 1)
    expect(text(r!.rows.at(-1)!)).toBe("asking llama… · 3 s · a cancel")
    const tight = sidenoteLayout(t, [note(1, 0, { reading: true, status }), note(2, 3)], CH, { open: false })
    expect(tight[0]!.rows).toHaveLength(2)
    expect(text(tight[0]!.rows[1]!).trim()).toBe(text(r!.rows.at(-1)!).trim())
    const one = sidenoteLayout(t, [note(1, 0, { reading: true, status }), note(2, 1)], CH, { open: false })
    expect(one[0]!.rows).toHaveLength(1)
  })

  test("waiting and streaming: the caret row, the last rows with the caret", () => {
    const [w] = sidenoteLayout(t, [note(1, 3, { reading: true, text: "" })], CH, { open: false })
    expect(w!.rows.map(text)).toEqual(["¹ ▍"])
    expect(w!.rows[0]!.at(-1)).toEqual({ text: CARET, fg: t.text })
    const [s] = sidenoteLayout(t, [note(1, 3, { reading: true, text: `${long} ${long}${CARET}` })], CH, { open: false })
    expect(s!.rows).toHaveLength(SIDENOTE_ROWS)
    expect(s!.rows.at(-1)!.at(-1)).toEqual({ text: CARET, fg: t.text })
    expect(rowsText(s!.rows).join("")).not.toContain("…")
  })

  test("the Δ summary is pinned on row 0 in the text role; a note on its rows moves under it", () => {
    const out = sidenoteLayout(t, [note(1, 0), note(0, 12, { summary: true })], CH, { open: false })
    expect(out.map((p) => p.row)).toEqual([0, SIDENOTE_SUMMARY_ROWS + 1])
    expect(out[0]!.rows).toHaveLength(SIDENOTE_SUMMARY_ROWS)
    expect(out[0]!.rows[0]![0]).toEqual({ text: "Δ", fg: t.primary })
    expect(out[0]!.rows[0]![1]!.fg).toBe(t.text)
    expect(out[1]!.rows[0]![1]!.fg).toBe(t.textMuted)
  })

  test("colours: outdated and neighbouring notes dimmed, a muted mark alone, a fade over all", () => {
    const [stale, other] = sidenoteLayout(t, [note(1, 0, { stale: true }), note(2, 10, { reading: false })], CH, {
      open: false,
    })
    expect(stale!.rows[0]![0]!.fg).toBe(c.markStale)
    expect(stale!.rows[0]![1]!.fg).toBe(c.stale)
    expect(other!.rows[0]![0]!.fg).toBe(c.markOther)
    expect(other!.rows[1]![0]!.fg).toBe(c.other)
    // an acted-on note: the mark muted, the text as it was
    const [done] = sidenoteLayout(t, [note(1, 0, { markStale: true })], CH, { open: false })
    expect(done!.rows[0]![0]!.fg).toBe(c.markStale)
    expect(done!.rows[0]![1]!.fg).toBe(c.note)
    const faded = sidenoteLayout(t, [note(1, 0)], CH, { open: false, ink: () => "#000000" })
    expect(faded[0]!.rows.flat().every((s) => s.fg === undefined || s.fg === "#000000")).toBe(true)
  })

  test("numbers are the caller's, and no row is wider than SIDENOTE_W", () => {
    const out = sidenoteLayout(t, [note(7, 0), note(12, 8)], CH, { open: false })
    expect(out.map((p) => text(p.rows[0]!).split(" ")[0])).toEqual(["⁷", "¹²"])
    expect(out.flatMap((p) => p.rows).every((r) => width(text(r)) <= SIDENOTE_W)).toBe(true)
  })
})
