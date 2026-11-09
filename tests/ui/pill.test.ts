import { describe, expect, test } from "bun:test"
import type { Exchange, Thread } from "../../src/ai/thread"
import { MIN_H, MIN_W } from "../../src/app/store"
import { width } from "../../src/lib/text"
import { INK_MS } from "../../src/ui/chrome"
import { type LayoutState, layout } from "../../src/ui/layout"
import {
  caretCol,
  charInk,
  chatStage,
  chipRow,
  frameRows,
  inkStep,
  inputSpans,
  type PillView,
  pillBorder,
  pillGeo,
  pillRow,
  sizeFoot,
  steamTick,
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
      expect(g.w).toBe(Math.min(72, L.CW))
      expect(g.x).toBe(Math.floor((L.CW - g.w) / 2))
      expect(g.top).toBe(L.CH - 3)
      expect(g.cardMax).toBe(L.CH - 5)
    }
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
  test("charInk: a character's step is its arrival's; past the log, full", () => {
    const log = [
      { len: 5, at: 0 },
      { len: 9, at: 2 * INK_MS },
    ]
    expect(charInk(log, 2, 2 * INK_MS, true)).toBe(2)
    expect(charInk(log, 7, 2 * INK_MS, true)).toBe(0)
    expect(charInk(log, 20, 0, true)).toBe(3)
    expect(charInk(log, 7, 0, false)).toBe(3)
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
