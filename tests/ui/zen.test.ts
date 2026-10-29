import { describe, expect, test } from "bun:test"
import { mix } from "../../src/theme/theme"
import { brothy } from "../helpers/theme"
import { GHOST_HOLD, HINT_HOLD, fadeStep } from "../../src/ui/status"
import { ZEN_DEFAULTS, ZEN_ROWS, dimSpans, headingPath, minutesLeft, normalizeZen, pageSlice, pickZen, prompterRate, sectionAt, sectionRanges, typewriterTop, wordSuffix, zenAdjust, zenRows } from "../../src/ui/zen"

describe("normalizeZen", () => {
  test("no config gives the defaults", () => {
    expect(normalizeZen(undefined)).toEqual({
      flow: "scroll",
      spotlight: true,
      typewriter: true,
      ghost: true,
      prompter: false,
      wpm: 220,
      measure: 72,
    })
  })
  for (const bad of [null, 5, "x", [1], true]) {
    test(`non-object ${JSON.stringify(bad)} gives the defaults`, () => expect(normalizeZen(bad)).toEqual(ZEN_DEFAULTS))
  }
  test("keeps valid fields and falls back per field", () => {
    expect(normalizeZen({ flow: "pages", spotlight: "yes", ghost: false, wpm: "fast", measure: 80 })).toEqual({
      ...ZEN_DEFAULTS,
      flow: "pages",
      ghost: false,
      measure: 80,
    })
  })
  test("rounds and clamps numbers", () => {
    expect(normalizeZen({ wpm: 9999, measure: 10 })).toMatchObject({ wpm: 400, measure: 60 })
    expect(normalizeZen({ wpm: 50, measure: 500 })).toMatchObject({ wpm: 120, measure: 100 })
    expect(normalizeZen({ wpm: 221.6, measure: 72.4 })).toMatchObject({ wpm: 222, measure: 72 })
    expect(normalizeZen({ wpm: NaN, measure: Infinity })).toMatchObject({ wpm: 220, measure: 72 })
  })
  test("an unknown flow falls back to scroll", () => expect(normalizeZen({ flow: "spiral" }).flow).toBe("scroll"))
})

describe("pickZen", () => {
  test("returns only the valid fields", () => {
    expect(pickZen({ flow: "x", typewriter: false, bogus: 1 })).toEqual({ typewriter: false })
  })
  test("non-objects give nothing", () => {
    for (const v of [null, [], 3, "s", undefined]) expect(pickZen(v)).toEqual({})
  })
})

describe("settings rows", () => {
  test("one row per setting, in popup order", () => {
    expect(zenRows(ZEN_DEFAULTS).map((r) => r.id)).toEqual([...ZEN_ROWS])
    expect(zenRows(ZEN_DEFAULTS).map((r) => r.value)).toEqual(["◀ scroll ▶", "on", "on", "on", "off · ◀ 220 wpm ▶", "◀ 72 ▶"])
    expect(zenRows(ZEN_DEFAULTS).map((r) => r.label)).toEqual(["Flow", "Spotlight", "Typewriter", "Ghost chrome", "Teleprompter", "Measure"])
  })
  test("pages greys out the scroll-only aids", () => {
    const rows = zenRows({ ...ZEN_DEFAULTS, flow: "pages" })
    expect(rows.filter((r) => r.disabled).map((r) => r.id)).toEqual(["spotlight", "typewriter", "prompter"])
    expect(rows[0]!.value).toBe("◀ pages ▶")
  })
  test("space toggles, arrows adjust", () => {
    const c = ZEN_DEFAULTS
    expect(zenAdjust(c, "flow", 0).flow).toBe("pages")
    expect(zenAdjust(c, "flow", -1).flow).toBe("pages")
    expect(zenAdjust(c, "spotlight", 0).spotlight).toBe(false)
    expect(zenAdjust(c, "ghost", 1).ghost).toBe(false)
    expect(zenAdjust(c, "prompter", 0).prompter).toBe(true)
    expect(zenAdjust(c, "prompter", 1)).toEqual({ ...c, wpm: 240 })
    expect(zenAdjust(c, "measure", -1).measure).toBe(68)
    expect(zenAdjust(c, "measure", 0)).toEqual(c)
  })
  test("measure dial goes 100 → full → 100", () => {
    const at = (m: number | "full") => ({ ...ZEN_DEFAULTS, measure: m })
    expect(zenAdjust(at(100), "measure", 1).measure).toBe("full")
    expect(zenAdjust(at("full"), "measure", 1).measure).toBe("full")
    expect(zenAdjust(at("full"), "measure", -1).measure).toBe(100)
    expect(zenAdjust(at("full"), "measure", 0)).toEqual(at("full"))
    expect(zenRows(at("full")).find((r) => r.id === "measure")!.value).toBe("◀ full ▶")
  })
  test("normalize keeps full, rejects other strings", () => {
    expect(normalizeZen({ measure: "full" }).measure).toBe("full")
    expect(normalizeZen({ measure: "wide" }).measure).toBe(72)
  })
  test("adjusting stops at the limits", () => {
    expect(zenAdjust({ ...ZEN_DEFAULTS, wpm: 400 }, "prompter", 1).wpm).toBe(400)
    expect(zenAdjust({ ...ZEN_DEFAULTS, measure: 60 }, "measure", -1).measure).toBe(60)
  })
})

describe("sectionRanges", () => {
  test("each heading starts a section; the preamble is its own", () => {
    expect(sectionRanges([3, 10], 15)).toEqual([[0, 3], [3, 10], [10, 15]])
  })
  test("a heading on line 0 means no preamble", () => expect(sectionRanges([0, 5], 8)).toEqual([[0, 5], [5, 8]]))
  test("no headings: one section", () => expect(sectionRanges([], 7)).toEqual([[0, 7]]))
  test("empty document: one empty section", () => expect(sectionRanges([], 0)).toEqual([[0, 0]]))
  test("ignores duplicate headings and ones past the end", () => {
    expect(sectionRanges([2, 2, 9], 5)).toEqual([[0, 2], [2, 5]])
  })
})

describe("sectionAt", () => {
  const r = sectionRanges([3, 10], 15)
  test("finds the section holding a line", () => {
    expect([0, 2, 3, 9, 10, 14].map((l) => sectionAt(r, l))).toEqual([0, 0, 1, 1, 2, 2])
  })
  test("clamps lines outside the document", () => {
    expect(sectionAt(r, -4)).toBe(0)
    expect(sectionAt(r, 99)).toBe(2)
  })
})

describe("typewriterTop", () => {
  test("puts the reading line on the middle row", () => {
    expect(typewriterTop(20, 26)).toBe(7)
    expect(typewriterTop(5, 1)).toBe(5)
    expect(typewriterTop(5, 2)).toBe(4)
  })
  test("is negative near the top (rendered as blank padding)", () => expect(typewriterTop(0, 26)).toBe(-13))
})

describe("pageSlice", () => {
  test("centers a short section; offset is ignored", () => {
    expect(pageSlice([10, 14], 20, 0)).toEqual({ top: 10, pad: 8 })
    expect(pageSlice([10, 14], 20, 3)).toEqual({ top: 10, pad: 8 })
  })
  test("a tall section scrolls by offset, clamped to its last screen", () => {
    expect(pageSlice([0, 50], 20, 0)).toEqual({ top: 0, pad: 0 })
    expect(pageSlice([0, 50], 20, 12)).toEqual({ top: 12, pad: 0 })
    expect(pageSlice([0, 50], 20, 99)).toEqual({ top: 30, pad: 0 })
    expect(pageSlice([0, 50], 20, -5)).toEqual({ top: 0, pad: 0 })
  })
  test("an exact fit has no padding", () => expect(pageSlice([5, 25], 20, 3)).toEqual({ top: 5, pad: 0 }))
  test("an empty section is all padding", () => expect(pageSlice([0, 0], 10, 0)).toEqual({ top: 0, pad: 5 }))
})

describe("headingPath", () => {
  const hs = [
    { depth: 1, text: "A" },
    { depth: 2, text: "B" },
    { depth: 3, text: "C" },
    { depth: 2, text: "D" },
  ]
  test("walks up to the shallower ancestors", () => {
    expect(headingPath(hs, 2)).toEqual(["A", "B", "C"])
    expect(headingPath(hs, 3)).toEqual(["A", "D"])
  })
  test("before the first heading there is no path", () => expect(headingPath(hs, -1)).toEqual([]))
  test("an index past the end uses the last heading", () => expect(headingPath(hs, 99)).toEqual(["A", "D"]))
  test("works without a level-1 heading", () => {
    expect(headingPath([{ depth: 2, text: "X" }, { depth: 3, text: "Y" }], 1)).toEqual(["X", "Y"])
  })
})

describe("dimSpans", () => {
  const t = brothy
  test("mixes fg (and bg) toward the background, keeping text and attributes", () => {
    const out = dimSpans(
      [{ text: "a", fg: "#ffffff", attr: 1 }, { text: "b" }, { text: "c", fg: "#000000", bg: "#ffffff" }],
      t,
      0.6,
    )
    expect(out).toEqual([
      { text: "a", fg: mix("#ffffff", t.background, 0.6), attr: 1 },
      { text: "b", fg: mix(t.text, t.background, 0.6) },
      { text: "c", fg: mix("#000000", t.background, 0.6), bg: mix("#ffffff", t.background, 0.6) },
    ])
  })
  test("amount 0 keeps the colors", () => {
    expect(dimSpans([{ text: "a", fg: "#123456" }], t, 0)).toEqual([{ text: "a", fg: "#123456" }])
  })
})

describe("reading time", () => {
  test("wordSuffix counts words (tokens with a letter or digit) from each line to the end", () => {
    expect(wordSuffix(["one two", "", "│ three │", "4 five"])).toEqual([5, 3, 3, 2, 0])
  })
  test("minutesLeft rounds up at 230 wpm", () => {
    const suffix = wordSuffix(Array.from({ length: 10 }, () => "word ".repeat(46).trim())) // 460 words
    expect(minutesLeft(suffix, 0)).toBe(2)
    expect(minutesLeft(suffix, 5)).toBe(1)
    expect(minutesLeft(suffix, 9)).toBe(1)
    expect(minutesLeft(suffix, 10)).toBe(0)
    expect(minutesLeft(suffix, 99)).toBe(0)
    expect(minutesLeft(suffix, -3)).toBe(2)
  })
})

describe("prompterRate", () => {
  test("lines per second = words per second / average words per non-blank line", () => {
    expect(prompterRate(["a b c d", "", "e f g h"], 240)).toBeCloseTo(1)
    expect(prompterRate(["a", "b c d"], 120)).toBeCloseTo(1)
  })
  test("counts at least one word per line", () => {
    expect(prompterRate(["", ""], 120)).toBeCloseTo(2)
    expect(prompterRate([], 120)).toBeCloseTo(2)
    expect(prompterRate(["───", "────"], 120)).toBeCloseTo(2)
  })
})

describe("fadeStep", () => {
  test("full for the hold, then four fading steps, then hidden", () => {
    expect([0, 1499, GHOST_HOLD, 1619, 1620, 1860, 1979, 1980].map((e) => fadeStep(e))).toEqual([0, 0, 1, 1, 2, 4, 4, null])
  })
  test("a custom hold shifts the steps", () => {
    expect([1999, HINT_HOLD, 2119, 2120, 2479, 2480].map((e) => fadeStep(e, HINT_HOLD))).toEqual([0, 1, 1, 2, 4, null])
  })
  test("a clock that went backwards counts as fresh", () => expect(fadeStep(-50)).toBe(0))
})
