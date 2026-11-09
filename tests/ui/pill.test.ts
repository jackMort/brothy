import { describe, expect, test } from "bun:test"
import { citeSection, type Exchange, type Thread, verifyCites } from "../../src/ai/thread"
import { MIN_H, MIN_W } from "../../src/app/store"
import { width } from "../../src/lib/text"
import { render } from "../../src/markdown/render"
import { renderSource } from "../../src/markdown/source"
import { mix } from "../../src/theme/theme"
import { INK_MS } from "../../src/ui/chrome"
import { type LayoutState, layout } from "../../src/ui/layout"
import {
  cardClock,
  cardFoot,
  cardRows,
  cardWindow,
  caretCol,
  chatStage,
  chipRow,
  citeRange,
  citeSpot,
  frameRows,
  inkStep,
  inkWalk,
  inputSpans,
  type PillView,
  pickRows,
  pillBorder,
  pillGeo,
  pillMoving,
  pillRow,
  pillWidth,
  quoteTint,
  sizeFoot,
  steamTick,
  tintBg,
  tintSpans,
} from "../../src/ui/pill"
import { STEAM_MS, STILL_TICK } from "../../src/ui/welcome"
import { ZEN_DEFAULTS } from "../../src/ui/zen"
import { brothy as t } from "../helpers/theme"

const LS: LayoutState = {
  wide: false,
  zen: false,
  hidden: false,
  drawerOpen: false,
  minimap: false,
  zenCfg: ZEN_DEFAULTS,
  source: false,
  openPath: "/n.md",
}
const turn = (error: string | null = null): Exchange => ({
  q: "q",
  at: 0,
  model: "m",
  raw: null,
  parts: [],
  cites: [],
  error,
  doneAt: null,
})
const thread = (turns: Exchange[] = []): Thread => ({ path: "/n.md", chips: [], turns })
const running = { parts: [], arrivals: [], at: 0, live: false, model: "m", secs: 0 }

describe("geometry and stage", () => {
  test("pillGeo: 72 wide and centred at 140×40, the measure at 90×30, the last 3 rows; the card leaves 5", () => {
    for (const [W, H] of [
      [140, 40],
      [90, 30],
      [MIN_W, MIN_H],
    ] as const) {
      const L = layout(W, H, LS)
      const g = pillGeo(L)
      expect(g.w).toBe(pillWidth(L.CW))
      expect(g.x).toBe(Math.floor((L.CW - g.w) / 2))
      expect(g.top).toBe(L.CH - 3)
      expect(g.cardMax).toBe(L.CH - 5)
    }
  })
  test("pillWidth: 72 at the 80 measure, up to 100 as the column widens, 40 at the floor, the column below it", () => {
    expect([80, 120, 100, 44, 30, 108, 200].map(pillWidth)).toEqual([72, 100, 92, 40, 30, 100, 100])
    expect(pillGeo({ CW: 80, CH: 30 })).toMatchObject({ w: 72, x: 4 })
    expect(pillGeo({ CW: 120, CH: 30 })).toMatchObject({ w: 100, x: 10 })
    expect(pillGeo({ CW: 30, CH: 30 })).toMatchObject({ w: 30, x: 0 })
  })
  test("chatStage: pick, waiting, error, answer, else input", () => {
    const pick = { q: "", hl: 0, items: [] }
    expect(chatStage({ pick, running: null, card: true, thread: thread() })).toBe("pick")
    expect(chatStage({ pick: null, running, card: true, thread: thread() })).toBe("waiting")
    expect(chatStage({ pick: null, running: null, card: true, thread: thread([turn(), turn("x")]) })).toBe("error")
    expect(chatStage({ pick: null, running: null, card: true, thread: thread([turn()]) })).toBe("answer")
    expect(chatStage({ pick: null, running: null, card: false, thread: thread([turn()]) })).toBe("input")
  })
})

describe("motion", () => {
  test("inkStep counts INK_MS steps to 3; 3 at once with motion off", () => {
    expect([0, INK_MS, 2 * INK_MS, 9 * INK_MS].map((t) => inkStep(0, t, true))).toEqual([0, 1, 2, 3])
    expect(inkStep(0, 0, false)).toBe(3)
  })
  test("inkWalk: a character's step is its arrival's; past the log, full", () => {
    const log = [
      { len: 5, at: 0 },
      { len: 9, at: 2 * INK_MS },
    ]
    expect(inkWalk(log, 2 * INK_MS, true)(2)).toBe(2)
    expect(inkWalk(log, 2 * INK_MS, true)(7)).toBe(0)
    expect(inkWalk(log, 0, true)(20)).toBe(3)
    expect(inkWalk(log, 0, false)(7)).toBe(3)
  })
  test("inkWalk: walking the characters in order gives each the first arrival past it, a log that shrank too", () => {
    // cleaning can shorten the reply (a <think> closed), so the lengths need not grow
    const log = [3, 8, 6, 12, 12, 20].map((len, k) => ({ len, at: k * INK_MS }))
    const first = (i: number) => {
      const a = log.find((x) => x.len > i)
      return a ? inkStep(a.at, 4 * INK_MS, true) : 3
    }
    const walk = inkWalk(log, 4 * INK_MS, true)
    const ids = Array.from({ length: 24 }, (_, i) => i)
    expect(ids.map((i) => walk(i))).toEqual(ids.map(first))
    expect([5, 2, 15].map((i) => walk(i))).toEqual([5, 2, 15].map(first)) // back again: it starts over
  })
  test("steamTick: a frame per STEAM_MS; STILL_TICK with motion off", () => {
    expect(steamTick(0, 3 * STEAM_MS + 1, true)).toBe(3)
    expect(steamTick(0, 99_999, false)).toBe(STILL_TICK)
  })
})

const text = (row: { text: string }[]) => row.map((s) => s.text).join("")
const CITES = [1, 2, 3].map((n) => ({ n, path: "/n.md", quote: n === 1 ? "do not press the bones" : `q${n}`, line: n }))
const DONE = {
  q: "why cloudy?",
  at: 0,
  model: "llama3.2",
  raw: "r",
  parts: ["Press ", 1, " no ", 2, 3, "."],
  cites: CITES,
  error: null,
  doneAt: 0,
}
function viewOf(o: Partial<PillView>): PillView {
  return {
    path: "/n.md",
    focus: true,
    card: false,
    input: "",
    thread: {
      path: "/n.md",
      chips: [{ path: "/n.md", title: "n" }],
      turns: o.card === undefined && !o.land ? [] : [DONE],
    },
    running: null,
    hl: null,
    top: null,
    pick: null,
    land: null,
    openedAt: 0,
    geo: { x: 0, w: 72, top: 20, cardMax: 18 },
    size: 10,
    clipped: [],
    wheres: [["Strain and cool", "Simmering", "n"]],
    stage: "input",
    quote: null,
    tint: 3,
    cardOut: null,
    ...o,
  }
}

describe("the pill row", () => {
  test("frameRows: rounded, `w` wide, content padded on the panel colour, the foot right on the bottom border", () => {
    const rows = frameRows([[{ text: "hi" }]], 20, t.border, t.backgroundPanel, [{ text: " ~1 tokens " }])
    expect(rows.map(text)).toEqual(["╭──────────────────╮", "│ hi               │", "╰───── ~1 tokens ──╯"])
    expect(rows.every((r) => r.every((s) => s.bg === t.backgroundPanel))).toBe(true)
  })
  test("chipRow: the first chip secondary, the others accent, ` · clipped` muted; the last fold into +n", () => {
    const chips = [
      { path: "/a", title: "Slow broth" },
      { path: "/b", title: "simmering" },
      { path: "/c", title: "stock" },
    ]
    const all = chipRow(t, chips, ["/a"], 80)
    expect(text(all)).toBe(" Slow broth · clipped   simmering   stock ")
    expect(all.find((s) => s.text === "Slow broth")?.fg).toBe(t.secondary)
    expect(all.find((s) => s.text === "simmering")?.fg).toBe(t.accent)
    expect(all.find((s) => s.text === " · clipped")?.fg).toBe(t.textMuted)
    expect(text(chipRow(t, chips, [], 26))).toBe(" Slow broth   +2 ")
  })
  test("inputSpans: the caret after the text's tail; the placeholder muted after the caret; graphemes whole", () => {
    expect(text(inputSpans(t, "", true, 30, "ask about this note…"))).toBe("▍ask about this note…")
    const tail = text(inputSpans(t, "why does my broth go cloudy", true, 12, "x"))
    expect(tail).toStartWith("…")
    expect(tail).toEndWith("cloudy▍")
    expect(width(tail)).toBe(12)
    expect(text(inputSpans(t, "soup 🍜🍜🍜", true, 5, "x"))).toBe("…🍜▍") // a 2-column grapheme is never cut
  })
  test("pillBorder: borderActive inked in from border while focused; border when folded", () => {
    expect(pillBorder(t, { focus: true, openedAt: 0 }, 0, true)).toBe(t.border)
    expect(pillBorder(t, { focus: true, openedAt: 0 }, 0, false)).toBe(t.borderActive)
    expect(pillBorder(t, { focus: false, openedAt: 0 }, 0, false)).toBe(t.border)
  })
  test("sizeFoot: ` ~N tokens ` in the status colour", () => {
    expect(text(sizeFoot(t, 3100))).toBe(" ~3.1k tokens ")
  })
  test("pillRow: wisp, input or placeholder, chips right; folded: the cite and `1 of 3 · ] next`", () => {
    const v = viewOf({})
    expect(text(pillRow(t, v, 0, false))).toMatch(/^⠳⢆ ▍ask about this note…\s+ n $/)
    const folded = viewOf({ focus: false, land: { exchange: 0, n: 1, path: "/n.md", at: 0 } })
    expect(text(pillRow(t, folded, 0, false))).toMatch(/^¹ “do not press the bones”\s+1 of 3 · \] next$/)
    const last = viewOf({ focus: false, land: { exchange: 0, n: 3, path: "/n.md", at: 0 } })
    expect(text(pillRow(t, last, 0, false))).toEndWith("3 of 3 · [ prev")
  })
  test("pillRow: `ask a follow-up` only after a successful answer; a failed one keeps the first placeholder", () => {
    const ok = viewOf({ card: true })
    expect(text(pillRow(t, ok, 0, false))).toContain("ask a follow-up")
    const failed = viewOf({ card: true })
    failed.thread = { ...failed.thread, turns: [{ ...DONE, raw: null, error: "boom" }] }
    expect(text(pillRow(t, failed, 0, false))).toContain("ask about this note…")
  })
  test("pillRow: an empty input says `esc cancels` while an answer runs and `⏎ asks again` after a failure; typed text replaces it", () => {
    const wait = viewOf({ running })
    expect(text(pillRow(t, wait, 0, false))).toContain("▍esc cancels")
    expect(pillRow(t, wait, 0, false).find((s) => s.text === "esc cancels")?.fg).toBe(
      pillRow(t, viewOf({}), 0, false).find((s) => s.text === "ask about this note…")?.fg,
    )
    const failed = viewOf({ card: true, stage: "error" })
    failed.thread = { ...failed.thread, turns: [{ ...DONE, raw: null, error: "boom" }] }
    expect(text(pillRow(t, failed, 0, false))).toContain("▍⏎ asks again")
    expect(text(pillRow(t, { ...failed, input: "why" }, 0, false))).not.toContain("asks again")
    expect(text(pillRow(t, { ...wait, input: "why" }, 0, false))).not.toContain("esc cancels")
  })
  test("caretCol: the column of the caret glyph pillRow draws, short input or long with one short chip", () => {
    for (const input of ["abc", "why does my broth go cloudy when I press the bones so hard every time"]) {
      const v = viewOf({ input, geo: { x: 5, w: 72, top: 20, cardMax: 18 } })
      const row = pillRow(t, v, 0, false)
      const at = text(
        row.slice(
          0,
          row.findIndex((s) => s.text === "▍"),
        ),
      ).length
      expect(caretCol(t, v)).toBe(5 + 2 + at)
    }
  })
})

describe("the card", () => {
  const W = 60
  const T1 = { path: "/n.md", chips: [], turns: [DONE] }
  const rowsOf = (v: Partial<PillView>, thread: PillView["thread"] = T1) =>
    cardRows(t, thread, { running: null, hl: null, wheres: [["Strain and cool", "Simmering", "n"]], ...v }, W, 0, false)
  const pending = { ...DONE, raw: null, parts: [], cites: [], doneAt: null }
  const pendingThread = { path: "/n.md", chips: [], turns: [pending] }
  test("thinking: the question, a blank, 3 steam rows centred, `asking <model> · N s` centred", () => {
    const out = rowsOf(
      { running: { parts: [], arrivals: [], at: 0, live: false, model: "llama3.2", secs: 2 } },
      pendingThread,
    )
    expect(text(out.rows[0]!)).toBe("› why cloudy?")
    expect(text(out.rows[1]!)).toBe("")
    expect(out.rows.slice(2, 5).every((r) => /[⠀-⣿]/.test(text(r)))).toBe(true)
    expect(text(out.rows[5]!).trim()).toBe("asking llama3.2 · 2 s")
    expect(out.stops).toEqual([])
  })
  test("streaming: the rule's status counts from 1 s: the model alone below it", () => {
    const at = (secs: number) =>
      text(
        rowsOf(
          { running: { parts: ["It"], arrivals: [], at: 0, live: true, model: "llama3.2", secs } },
          pendingThread,
        ).rows.at(-1)!,
      )
    expect(at(0)).toMatch(/llama3\.2 · esc cancel$/)
    expect(at(0)).not.toContain(" 0 s")
    expect(at(1)).toMatch(/llama3\.2 · 1 s · esc cancel$/)
  })
  test("streaming: the text indented 2 with a caret, unverified marks muted superscripts, the rule `<model> · N s · esc cancel`", () => {
    const out = rowsOf(
      { running: { parts: ["It clouds", 1, "."], arrivals: [], at: 0, live: true, model: "llama3.2", secs: 3 } },
      pendingThread,
    )
    expect(text(out.rows[2]!)).toBe("  It clouds¹.▍")
    expect(out.rows[2]!.find((s) => s.text.includes("¹"))!.fg).toBe(t.textMuted)
    expect(text(out.rows.at(-1)!)).toMatch(/^ {2}─+ +llama3\.2 · 3 s · esc cancel$/)
  })
  test("answer: marks glow primary, the selected bold on backgroundElement; rule `↑↓ ⏎ go to · <model>`; a row per cite, `▌` on the selected; stops", () => {
    const out = rowsOf({ hl: [0, 2] })
    const body = out.rows[2]!
    expect(body.find((s) => s.text === "²")).toMatchObject({ fg: t.primary, bg: t.backgroundElement })
    expect(text(out.rows[4]!)).toMatch(/^ {2}─+ +↑↓ ⏎ go to · llama3\.2$/)
    expect(text(out.rows[5]!)).toBe("  ¹ Strain and cool · “do not press the bones”")
    expect(text(out.rows[6]!)).toStartWith("▌ ² Simmering · ")
    expect(out.stops).toEqual([
      { cite: [0, 1], row: 5 },
      { cite: [0, 2], row: 6 },
      { cite: [0, 3], row: 7 },
    ])
  })
  test("a long cite wraps under its text; an answer without marks: the model alone", () => {
    const long = { ...DONE, cites: [{ ...CITES[0]!, quote: "word ".repeat(12).trim() }], parts: ["x", 1] }
    const out = rowsOf({}, { path: "/n.md", chips: [], turns: [long] })
    const i = out.stops[0]!.row
    expect(text(out.rows[i + 1]!)).toMatch(/^ {4}\S/)
    const bare = rowsOf({}, { path: "/n.md", chips: [], turns: [{ ...DONE, parts: ["plain."], cites: [] }] })
    expect(text(bare.rows.at(-1)!)).toMatch(/^ {2}─+ +llama3\.2$/)
  })
  test("error: `✗ ` and the message in error, at most 3 rows, rule `⏎ retry`; exchanges apart by a blank", () => {
    const err = { ...pending, error: "connection refused ".repeat(10) }
    const out = rowsOf({}, { path: "/n.md", chips: [], turns: [DONE, err] })
    const k = out.rows.findIndex((r) => text(r).startsWith("  ✗ "))
    expect(out.rows[k]![1]!.fg).toBe(t.error)
    expect(out.rows.slice(k).filter((r) => text(r).startsWith("    ")).length).toBeLessThanOrEqual(2)
    expect(text(out.rows.at(-1)!)).toMatch(/⏎ retry$/)
    const second = out.rows.findIndex((r, i) => i > 0 && text(r) === "› why cloudy?")
    expect(text(out.rows[second - 1]!)).toBe("")
  })
  test("paragraphs: a blank line in the answer is a blank row between wrapped paragraphs; the cite stops follow", () => {
    const two = { ...DONE, parts: ["First part", 1, ".\n\n  Second\npart", 2, "."] }
    const out = rowsOf({}, { path: "/n.md", chips: [], turns: [two] })
    expect(out.rows.slice(2, 5).map(text)).toEqual(["  First part¹.", "", "  Second part²."])
    expect(text(out.rows[out.stops[0]!.row]!)).toBe("  ¹ Strain and cool · “do not press the bones”")
    expect(out.stops.map((x) => x.row)).toEqual([7, 8, 9])
  })
  test("paragraphs while streaming: a blank row between them, each character inked by its arrival, the caret at the end", () => {
    const arrivals = [
      { len: 3, at: 0 },
      { len: 99, at: 10_000 },
    ]
    const running = { parts: ["One\n\nTwo"], arrivals, at: 0, live: true, model: "m", secs: 1 }
    const out = cardRows(t, pendingThread, { running, hl: null, wheres: [] }, W, 10_000, true)
    expect(out.rows.slice(2, 5).map(text)).toEqual(["  One", "", "  Two▍"])
    // "One" arrived long ago: full ink; "Two" (after the 2 separator characters) just now: not yet
    expect(out.rows[2]!.find((x) => x.text.includes("One"))!.fg).toBe(t.text)
    expect(out.rows[4]!.find((x) => x.text.includes("T"))!.fg).not.toBe(t.text)
  })
  test("cardClock: the card is drawn at `now` only while something on it moves; else a still clock that draws the same", () => {
    const answered = viewOf({ card: true, focus: true, openedAt: 0 })
    expect(cardClock(answered, 2 * INK_MS, true)).toEqual({ now: 2 * INK_MS, motion: true }) // the border inks
    const still = cardClock(answered, 99 * INK_MS, true)
    expect(still).toEqual({ now: 0, motion: false })
    expect(cardClock(answered, 2 * INK_MS, false)).toEqual({ now: 0, motion: false })
    const view = { running: null, hl: null, wheres: [["Strain and cool", "Simmering", "n"]] }
    expect(cardRows(t, answered.thread, view, W, still.now, still.motion)).toEqual(
      cardRows(t, answered.thread, view, W, 99 * INK_MS, true),
    )
    const thinking = viewOf({ card: true, openedAt: -1e9, running: { ...running, at: 0, live: false } })
    expect(cardClock(thinking, 99 * INK_MS, true)).toEqual({ now: 99 * INK_MS, motion: true }) // the steam
  })
  test("cardWindow: pinned to the bottom (null), or from `top`; `below` counts rows under it; cardFoot ` ↓ n more `", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [{ text: String(i) }])
    expect(cardWindow(rows, 4, null)).toMatchObject({ top: 6, below: 0 })
    expect(cardWindow(rows, 4, 2)).toMatchObject({ top: 2, below: 4 })
    expect(cardWindow(rows, 4, 99).top).toBe(6)
    expect(text(cardFoot(t, 4)!)).toBe(" ↓ 4 more ")
    expect(cardFoot(t, 0)).toBeUndefined()
  })
})

/** A note with the shapes a quote must read through. */
const NOTE = [
  "# Pot",
  "",
  "Use [the stock pot](pot.md) for the broth.",
  "",
  "> Skim the foam",
  "> every ten minutes.",
  "",
  "> [!tip] Salt",
  "> Salt late and taste",
  "> before you serve.",
  "",
  "- Keep ~~never~~ boil it",
  "- Salt &amp; pepper",
  "1. [[bones]] and **salt** go in",
  "",
].join("\n")
/** Where `quote` lands in `src`'s Preview or Source at 60 columns, after verifying it as a send would. */
function spotOf(src: string, source: boolean, quote: string) {
  const view = source ? renderSource(src, 60, t) : render(src, 60, t)
  const cite = verifyCites(["x ", 1], [{ n: 1, note: 1, quote }], [{ chip: { path: "/a.md", title: "a" }, src }])
  const line = cite.cites[0]?.line
  if (line === undefined) throw new Error(`not verified: ${quote}`)
  const q = citeSpot(view, source, citeSection(src, line).index, line, quote).quote
  return q && { view, q }
}
/** The text `spotOf`'s quote tints, row by row. */
function landed(src: string, source: boolean, quote: string) {
  const at = spotOf(src, source, quote)
  if (!at) return null
  const { view, q } = at
  return view.plain.slice(q.row, q.endRow + 1).map((row, i) =>
    quoteTint([{ text: row }], row, q.row + i, q, "#123456")
      .filter((sp) => sp.bg === "#123456")
      .map((sp) => sp.text)
      .join(""),
  )
}

describe("list, tint, range, motion", () => {
  const text = (r: { text: string }[]) => r.map((s) => s.text).join("")
  test("pickRows: at most 5, `▌` and bold on backgroundElement for the highlight, `linked from here` muted", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ path: `/${i}`, name: `note ${i}`, linked: i === 0 }))
    const rows = pickRows(t, items, 0, 36)
    expect(rows).toHaveLength(5)
    expect(text(rows[0]!)).toBe("▌ note 0  linked from here")
    expect(rows[0]!.every((s) => s.bg === t.backgroundElement)).toBe(true)
    expect(text(rows[1]!)).toBe("  note 1")
  })
  test("pickRows: a long name is cut so mark, name and the whole hint fit the framed row", () => {
    const rows = pickRows(t, [{ path: "/a", name: "a very long note name indeed", linked: true }], 0, 36)
    expect(text(rows[0]!).endsWith("  linked from here")).toBe(true)
    expect(width(text(rows[0]!))).toBe(36 - 4)
    expect(text(rows[0]!)).toContain("…")
  })
  test("pickRows: the width is a parameter: rows fit a narrower list", () => {
    const rows = pickRows(t, [{ path: "/a", name: "a very long note name indeed", linked: true }], 0, 30)
    expect(width(text(rows[0]!))).toBe(30 - 4)
  })
  test("pickRows: an unlinked name takes the hint's room too: mark and name fill the framed row", () => {
    const long = "a very long note name indeed, longer than the row"
    const rows = pickRows(t, [{ path: "/a", name: long, linked: false }], 0, 36)
    expect(width(text(rows[0]!))).toBe(36 - 4)
    expect(text(rows[0]!)).toBe(`▌ ${long.slice(0, 29)}…`)
    // a short one is not padded out
    expect(text(pickRows(t, [{ path: "/b", name: "short", linked: false }], 0, 36)[0]!)).toBe("▌ short")
  })
  test("tintSpans: the range gets the background, the text and the rest kept", () => {
    const out = tintSpans(
      [
        { text: "abc", fg: "#1" },
        { text: "def", fg: "#2" },
      ],
      2,
      4,
      "#bg",
    )
    expect(out).toEqual([
      { text: "ab", fg: "#1" },
      { text: "c", fg: "#1", bg: "#bg" },
      { text: "d", fg: "#2", bg: "#bg" },
      { text: "ef", fg: "#2" },
    ])
  })
  test("tintSpans: columns are UTF-16 offsets, so a wide character before the quote does not shift it", () => {
    const out = tintSpans([{ text: "漢😀ab" }], 3, 5, "#bg")
    expect(
      out
        .filter((s) => s.bg)
        .map((s) => s.text)
        .join(""),
    ).toBe("ab")
    expect(text(out)).toBe("漢😀ab")
  })
  test("tintBg: backgroundElement mixed toward the background, full at step 3", () => {
    expect(tintBg(t, 3)).toBe(mix(t.backgroundElement, t.background, 0))
    expect(tintBg(t, 0)).toBe(mix(t.backgroundElement, t.background, 1))
  })
  test("citeRange: Preview from the heading to the next; the lead-in from 0; Source from the cite's row", () => {
    const view = {
      headings: [
        { depth: 1, text: "a", line: 4 },
        { depth: 2, text: "b", line: 9 },
      ],
      lines: Array(20),
      srcRow: [0, 1, 2, 3, 5, 6, 7],
    }
    expect(citeRange(view as never, false, 0, 99)).toEqual({ from: 4, to: 9 })
    expect(citeRange(view as never, false, -1, 99)).toEqual({ from: 0, to: 4 })
    expect(citeRange(view as never, false, 1, 99)).toEqual({ from: 9, to: 20 })
    expect(citeRange(view as never, true, 0, 5)).toEqual({ from: 6, to: 9 })
  })
  test("citeSpot: Preview finds a wrapped quote in its section; else the section's first row and null", () => {
    const plain = ["# a", "", "pour it through a", "sieve; do not press", "## b", "do not press"]
    const view = { headings: [{ line: 0 }, { line: 4 }], lines: plain, plain }
    expect(citeSpot(view as never, false, 0, 9, "a sieve; do not")).toEqual({
      from: 0,
      quote: { row: 2, col: 16, endRow: 3, endCol: 13, left: 0 },
    })
    expect(citeSpot(view as never, false, 0, 9, "gone")).toEqual({ from: 0, quote: null })
  })
  test("citeSpot: Source reads past the line numbers; its columns count them again", () => {
    // 10 source lines: a gutter of 2 digits and 2 spaces
    const plain = [" 1  # a", " 2  pour it through a", " 3  sieve; do not press", " 4  ## b"]
    const view = { headings: [{ line: 0 }, { line: 3 }], lines: plain, plain, srcRow: [0, 1, 2, 3, 3, 3, 3, 3, 3, 3] }
    expect(citeSpot(view as never, true, 0, 1, "a sieve; do")).toEqual({
      from: 1,
      quote: { row: 1, col: 20, endRow: 2, endCol: 13, left: 4 },
    })
  })
  test("citeSpot in Preview: a quote through a link, as written or as seen, lands on the link's text", () => {
    expect(landed(NOTE, false, "Use [the stock pot](pot.md) for the broth")).toEqual([
      "use the stock pot for the broth",
    ])
    expect(landed(NOTE, false, "the stock pot for")).toEqual(["the stock pot for"])
  })
  test("citeSpot in Preview: a quote across a callout's or a blockquote's lines lands past the bars", () => {
    const callout = spotOf(NOTE, false, "Salt late and taste before you serve")!
    expect(callout.view.plain[callout.q.row]!.slice(callout.q.col)).toBe("salt late and taste")
    expect(callout.view.plain[callout.q.endRow]!.slice(0, callout.q.endCol)).toBe("▎ before you serve")
    const quote = spotOf(NOTE, false, "Skim the foam every ten minutes.")!
    expect(quote.view.plain[quote.q.row]!.slice(quote.q.col)).toBe("skim the foam")
    expect(quote.view.plain[quote.q.endRow]!.slice(0, quote.q.endCol)).toBe("▎ every ten minutes.")
  })
  test("citeSpot in Preview: struck text, entities and list bullets read as they show", () => {
    expect(landed(NOTE, false, "Keep ~~never~~ boil it")).toEqual(["keep never boil it"])
    expect(landed(NOTE, false, "Salt &amp; pepper")).toEqual(["salt & pepper"])
    expect(landed(NOTE, false, "- Salt & pepper")).toEqual(["salt & pepper"])
  })
  test("citeSpot in Source: the quote as written lands exactly; one that reads otherwise lands on its whole rows", () => {
    expect(landed(NOTE, true, "Keep ~~never~~ boil")).toEqual(["keep ~~never~~ boil"])
    expect(landed(NOTE, true, "bones and salt")).toEqual(["1. [[bones]] and **salt** go in"])
    expect(landed(NOTE, true, "the stock pot for the broth")).toEqual(["use [the stock pot](pot.md) for the broth."])
    expect(landed(NOTE, true, "Salt late and taste before you serve")).toEqual([
      "> salt late and taste",
      "> before you serve.",
    ])
    expect(citeSpot(renderSource(NOTE, 60, t), true, 0, 2, "not in the note").quote).toBeNull()
  })
  test("quoteTint: the first row from the quote's column, the next from its text past the gutter, the last to its end", () => {
    const q = { row: 1, col: 20, endRow: 2, endCol: 13, left: 4 }
    const tinted = (row: string, n: number) =>
      quoteTint([{ text: row }], row, n, q, "#123456")
        .filter((sp) => sp.bg === "#123456")
        .map((sp) => sp.text)
    expect(tinted(" 2  pour it through a", 1)).toEqual(["a"])
    expect(tinted(" 3  sieve; do not press", 2)).toEqual(["sieve; do"])
    expect(tinted(" 1  # a", 0)).toEqual([])
    // a row's indent is not tinted either
    const row = "   indented quote"
    expect(quoteTint([{ text: row }], row, 2, { ...q, left: 0 }, "#123456")[1]).toEqual({
      text: row.slice(3, 13),
      bg: "#123456",
    })
  })
  test("pillMoving: the border inking, a thinking steam, a recent arrival or glow, the tint; else null", () => {
    expect(pillMoving(viewOf({ openedAt: 0 }), INK_MS)).toBe("ink")
    expect(pillMoving(viewOf({ openedAt: 0 }), 10 * INK_MS)).toBeNull()
    const thinking = viewOf({ openedAt: -1e9, running: { ...running, live: false } })
    expect(pillMoving(thinking, 1e6)).toBe("steam")
  })
  test("pillMoving: folded, the tint fades from land.at, not the exchange's doneAt", () => {
    const turns = [{ ...DONE, doneAt: 100 * INK_MS }]
    const base = { focus: false, thread: { path: "/n.md", chips: [], turns } }
    const land = (at: number) => ({ exchange: 0, n: 1, path: "/n.md", at })
    const now = 101 * INK_MS
    expect(pillMoving(viewOf({ ...base, land: land(100 * INK_MS) }), now)).toBe("ink")
    expect(pillMoving(viewOf({ ...base, land: land(0) }), now)).toBeNull()
  })
  test("pillMoving: a recent arrival or a just-finished answer inks", () => {
    const live = { ...running, live: true, arrivals: [{ len: 3, at: 10 * INK_MS }] }
    expect(pillMoving(viewOf({ openedAt: -1e9, running: live }), 11 * INK_MS)).toBe("ink")
    const done = viewOf({
      openedAt: -1e9,
      card: true,
      thread: { path: "/n.md", chips: [], turns: [{ ...DONE, doneAt: 10 * INK_MS }] },
    })
    expect(pillMoving(done, 11 * INK_MS)).toBe("ink")
    expect(pillMoving(done, 50 * INK_MS)).toBeNull()
  })
})
