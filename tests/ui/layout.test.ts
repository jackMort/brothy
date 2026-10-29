import { expect, test } from "bun:test"
import { DRAWER_BELOW, layout, MEASURE } from "../../src/ui/layout"
import { ZEN_DEFAULTS } from "../../src/ui/zen"

type State = Parameters<typeof layout>[2]
const base: State = { hidden: false, drawerOpen: false, zen: false, source: false, zenCfg: ZEN_DEFAULTS, wide: false, minimap: false, openPath: "/n.md" }
const at = (W: number, H: number, patch: Partial<State> = {}) => layout(W, H, { ...base, ...patch })

test("wide enough, the panel is a column left of the measure, centred in what is left", () => {
  const L = at(120, 40)
  expect(L).toMatchObject({
    zen: false,
    mode: "inline",
    shown: true,
    inline: true,
    SW: 32,
    DW: 40,
    PNW: 32,
    gap: 1,
    bodyH: 36,
    areaW: 85,
    CW: MEASURE,
    CH: 36,
    padL: 2,
    mini: false,
    PH: 16,
  })
})

test("a hidden panel gives the document the whole width; `wide` drops the measure for a 2-column margin", () => {
  expect(at(120, 40, { hidden: true })).toMatchObject({ shown: false, inline: false, areaW: 118, CW: 80, padL: 19 })
  expect(at(120, 40, { hidden: true, wide: true })).toMatchObject({ CW: 114, padL: 2 })
  expect(at(120, 40, { wide: true })).toMatchObject({ areaW: 85, CW: 81, padL: 2 })
})

test("below DRAWER_BELOW the panel is a drawer: shown only while open, and the document lays out without it", () => {
  const closed = at(DRAWER_BELOW - 10, 30)
  expect(closed).toMatchObject({ mode: "drawer", shown: false, inline: false, SW: 24, DW: 40, PNW: 40, areaW: 88, CW: 80, padL: 4 })
  const open = at(DRAWER_BELOW - 10, 30, { drawerOpen: true })
  expect(open).toMatchObject({ mode: "drawer", shown: true, inline: false, areaW: 88, CW: 80, padL: 4 })
  expect(at(DRAWER_BELOW, 30).mode).toBe("inline")
  // `hidden` is the inline panel's switch; it does not close an open drawer
  expect(at(60, 30, { drawerOpen: true, hidden: true }).shown).toBe(true)
})

test("the drawer and panel widths stay within their bounds", () => {
  expect(at(200, 40)).toMatchObject({ SW: 40, DW: 40 })
  expect(at(40, 20)).toMatchObject({ SW: 24, DW: 28 })
  expect(at(30, 20).DW).toBe(22) // never wider than the screen less 8
})

test("the gap row needs 28 rows; the body never drops below 4 rows and the find list below 1", () => {
  expect(at(120, 28)).toMatchObject({ gap: 1, bodyH: 24 })
  expect(at(120, 27)).toMatchObject({ gap: 0, bodyH: 24 })
  expect(at(120, 6)).toMatchObject({ gap: 0, bodyH: 4, CH: 4, PH: 1 })
  expect(at(120, 10).PH).toBe(2)
})

test("the text column never narrows below 20 and its margin never goes negative", () => {
  expect(at(30, 20)).toMatchObject({ areaW: 28, CW: 24, padL: 2 })
  expect(at(20, 20)).toMatchObject({ areaW: 18, CW: 20, padL: 0 })
})

test("zen drops the panel and wraps at its own measure; with Source shown it is not zen", () => {
  expect(at(120, 40, { zen: true })).toMatchObject({ zen: true, shown: false, inline: false, areaW: 118, CW: ZEN_DEFAULTS.measure, padL: 23 })
  expect(at(120, 40, { zen: true, zenCfg: { ...ZEN_DEFAULTS, measure: "full" } }).CW).toBe(114)
  expect(at(120, 40, { zen: true, source: true })).toMatchObject({ zen: false, shown: true, CW: 80 })
  expect(at(120, 40, { zen: true, minimap: true }).mini).toBe(false)
})

test("the welcome page (no note open) has the whole width: no panel, drawer or minimap", () => {
  expect(at(120, 40, { openPath: null, minimap: true })).toMatchObject({ shown: false, inline: false, areaW: 118, mini: false })
  expect(at(60, 20, { openPath: null, drawerOpen: true }).shown).toBe(false)
})

test("the minimap needs MINI_MIN_W columns; the text keeps its column until it no longer fits left of it", () => {
  expect(at(109, 40, { minimap: true }).mini).toBe(false)
  // 120: room enough, nothing moves
  expect(at(120, 40, { minimap: true })).toMatchObject({ mini: true, CW: 80, padL: 2 })
  // 110 with the panel: the measure gives up a column, the left margin stays
  expect(at(110, 40)).toMatchObject({ SW: 30, areaW: 77, CW: 73, padL: 2 })
  expect(at(110, 40, { minimap: true })).toMatchObject({ mini: true, CW: 72, padL: 2 })
  // without the panel the centred column already clears it
  expect(at(120, 40, { minimap: true, hidden: true })).toMatchObject({ CW: 80, padL: 19 })
})
