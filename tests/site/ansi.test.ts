import { expect, test } from "bun:test"
import { Screen } from "../../site/src/scripts/ansi"

test("Screen: newline moves down, carriage return to column 0, and cells past the edge are dropped", () => {
  const s = new Screen(3, 2)
  s.write("ab\r\nxyzw\r\nq")
  expect(s.ch.join("")).toBe("ab xyz")
  expect([s.x, s.y]).toEqual([1, 2])
})

test("Screen: SGR flags accumulate, 0 resets, and the colour pair survives a flag", () => {
  const s = new Screen(4, 1)
  s.write("\x1b[1;3;4;9ma\x1b[38;2;1;2;3m\x1b[48;2;4;5;6mb\x1b[0mc\x1b[m")
  expect([s.at[0], s.at[1], s.at[2]]).toEqual([15, 15, 0])
  expect([s.fg[1], s.bg[1], s.fg[2], s.bg[2]]).toEqual(["1,2,3", "4,5,6", null, null])
})

test("Screen: cursor position defaults missing and zero parameters to 1, and ignored sequences change nothing", () => {
  const s = new Screen(4, 3)
  s.write("\x1b[3;4H\x1b[;2H\x1b[0;0H\x1b[?25l\x1b[K\x1b[1Jx")
  expect(s.ch[0]).toBe("x")
  s.write("\x1b[2;3H")
  expect([s.x, s.y]).toEqual([2, 1])
  s.write("\x1b[;2H")
  expect([s.x, s.y]).toEqual([1, 0])
})
