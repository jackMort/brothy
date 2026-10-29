import { expect, test } from "bun:test"
import { PEEK_MIN_W, POPUP_W, innerWidth, paneWidth, popupWidth, splitWidth } from "../../src/ui/geometry"
import { switchSplit } from "../../src/notes/peek"
import { themeSplit } from "../../src/theme/themepick"

test("popupWidth: the usual 70 columns, less on a narrow screen", () => {
  expect(popupWidth(120)).toBe(POPUP_W)
  expect(popupWidth(60)).toBe(58)
  expect(popupWidth(120, 52)).toBe(52)
  expect(popupWidth(40, 52)).toBe(38)
})

test("splitWidth: W − 12, up to 116", () => {
  expect(splitWidth(PEEK_MIN_W)).toBe(88)
  expect(splitWidth(140)).toBe(116)
  expect(splitWidth(200)).toBe(116)
})

test("innerWidth and paneWidth: Overlay's padding, then the divider and the pane's padding", () => {
  expect(innerWidth(70)).toBe(68)
  expect(paneWidth(116 - 2, 41)).toBe(66)
})

test("switcher: popupWidth below PEEK_MIN_W, splitWidth from it (as the theme picker)", () => {
  for (const W of [PEEK_MIN_W - 1, PEEK_MIN_W, 120, 200]) {
    expect(switchSplit(W).width).toBe(themeSplit(W, 40, 16).split ? splitWidth(W) : popupWidth(W))
  }
})
