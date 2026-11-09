import { describe, expect, test } from "bun:test"
import type { Exchange, Thread } from "../../src/ai/thread"
import { MIN_H, MIN_W } from "../../src/app/store"
import { INK_MS } from "../../src/ui/chrome"
import { type LayoutState, layout } from "../../src/ui/layout"
import { charInk, chatStage, inkStep, pillGeo, steamTick } from "../../src/ui/pill"
import { STEAM_MS, STILL_TICK } from "../../src/ui/welcome"
import { ZEN_DEFAULTS } from "../../src/ui/zen"

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
