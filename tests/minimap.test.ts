import { expect, test } from "bun:test"
import { MINI_COLS, MINI_W, miniCells, miniColors, miniInk, miniJump } from "../src/minimap"
import { contrast, themes } from "../src/theme"

test("the minimap is a gap, two braille cells and the find lane", () => {
  expect(MINI_COLS).toBe(2)
  expect(MINI_W).toBe(4)
})

test("miniInk: one dot per line and per textW/4 slice; code rows are solid; blank and rule rows have none", () => {
  // textW 8 → 4 dot columns of 2 text columns; 4 lines = one cell row
  const ink = miniInk(["ab", "    ab", "━━━━━━━━", "x"], [false, false, false, true], 8, 10)
  expect(ink.rows).toBe(1)
  expect(ink.scale).toBe(1)
  expect(ink.bits[0]).toBe(0x01 | 0x40 | 0x80) // "ab": slice 0, row 0 left; code row 3: both dots; the rule: nothing
  expect(ink.bits[1]).toBe(0x02 | 0x40 | 0x80) // "    ab": slice 2 → cell 1, row 1 left; code row 3: both dots
})

test("miniInk: columns go by display width, so wide characters ink as far as they reach", () => {
  // textW 8 → dot columns of 2 cells: 4 CJK characters fill all 8 cells; a ZWJ emoji family is one 2-cell grapheme
  const ink = miniInk(["漢字漢字", "  👨‍👩‍👧", "é".normalize("NFD").repeat(6)], [false, false, false], 8, 10)
  expect(ink.bits[0]! & 0x09).toBe(0x09) // row 0: both dots of cell 0 …
  expect(ink.bits[1]! & 0x09).toBe(0x09) // … and of cell 1
  expect(ink.bits[0]! & 0x12).toBe(0x10) // row 1: cells 2–3 only (dot column 1)
  expect(ink.bits[1]! & 0x12).toBe(0)
  expect(ink.bits[0]! & 0x24).toBe(0x24) // row 2: 6 cells of e + combining acute → dot columns 0–2
  expect(ink.bits[1]! & 0x24).toBe(0x04)
})

test("miniInk: a note longer than 4 rows per cell scales so the whole note fits", () => {
  const ink = miniInk(Array.from({ length: 100 }, () => "text"), Array(100).fill(false), 80, 10)
  expect(ink.scale).toBe(3)
  expect(ink.rows).toBeLessThanOrEqual(10)
})

test("miniInk: 20 000 lines still fit in the rows given", () => {
  const n = 20_000
  const ink = miniInk(Array.from({ length: n }, (_, i) => (i % 7 ? "some words here" : "")), Array(n).fill(false), 80, 30)
  expect(ink.rows).toBeLessThanOrEqual(30)
  expect(ink.scale).toBe(Math.ceil(n / 120))
})

test("miniCells: headings beat the viewport band; the band marks the rows on screen; empty cells are spaces", () => {
  const ink = miniInk(Array.from({ length: 16 }, () => "word"), Array(16).fill(false), 8, 10)
  const cells = miniCells(ink, { top: 4, h: 8, heads: [0, 8], hits: [], total: 16, lane: false })
  expect(cells.map((r) => r[0]!.kind)).toEqual(["head", "view", "head", "rest"])
  expect(cells.map((r) => r[0]!.band)).toEqual([false, true, true, false])
  expect(cells[0]).toHaveLength(MINI_COLS)
  expect(cells[0]![1]!.ch).toBe(" ") // "word" is 4 of 8 columns: the second cell has no ink
})

test("miniCells: during a find the lane puts one dot per match line at its row", () => {
  const ink = miniInk(Array.from({ length: 16 }, () => "word"), Array(16).fill(false), 8, 10)
  const cells = miniCells(ink, { top: 0, h: 4, heads: [], hits: [1, 3, 9], total: 16, lane: true })
  const lane = cells.map((r) => r[MINI_COLS]!)
  expect(lane.map((c) => c.kind)).toEqual(["lane", "lane", "lane", "lane"])
  expect(lane.map((c) => c.ch)).toEqual([String.fromCharCode(0x2800 + (0x02 | 0x40)), " ", String.fromCharCode(0x2800 + 0x02), " "])
  expect(lane.map((c) => c.band)).toEqual([true, false, false, false])
})

test("miniJump centres the clicked cell's first line, clamped", () => {
  const ink = miniInk(Array.from({ length: 400 }, () => "x"), Array(400).fill(false), 8, 20) // scale 5 → 20 lines per row
  expect(miniJump(10, ink, 30, 370)).toBe(200 - 15)
  expect(miniJump(0, ink, 30, 370)).toBe(0)
  expect(miniJump(99, ink, 30, 370)).toBe(370)
})

test("minimap colours are theme roles; on-screen dots and the lane read on the band in every theme", () => {
  for (const t of themes) {
    const c = miniColors(t)
    expect(c).toEqual({ head: t.primary, view: t.textMuted, rest: t.borderSubtle, lane: t.secondary })
    expect(contrast(c.view, t.backgroundElement), t.name).toBeGreaterThanOrEqual(3)
    expect(contrast(c.lane, t.backgroundElement), t.name).toBeGreaterThanOrEqual(3)
  }
})
