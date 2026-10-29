import { expect, test } from "bun:test"
import { erase, typed } from "../../src/app/input"

const key = (sequence: string, mods: { ctrl?: boolean; meta?: boolean } = {}) => ({
  sequence,
  ctrl: false,
  meta: false,
  ...mods,
})

test("a printable key types its sequence, pasted text and non-ASCII included", () => {
  expect(typed(key("a"))).toBe("a")
  expect(typed(key("?"))).toBe("?")
  expect(typed(key(" "))).toBe(" ")
  expect(typed(key("żółw"))).toBe("żółw")
  expect(typed(key("🍜"))).toBe("🍜")
})

test("control characters, ctrl, meta and an empty sequence type nothing", () => {
  expect(typed(key(""))).toBeNull()
  expect(typed(key("\r"))).toBeNull()
  expect(typed(key("\x1b"))).toBeNull()
  expect(typed(key("\x7f"))).toBeNull()
  expect(typed(key("a\tb"))).toBeNull()
  expect(typed(key("p", { ctrl: true }))).toBeNull()
  expect(typed(key("x", { meta: true }))).toBeNull()
})

test("erase drops the last code point, a surrogate pair whole", () => {
  expect(erase("abc")).toBe("ab")
  expect(erase("")).toBe("")
  expect(erase("ramen 🍜")).toBe("ramen ")
  expect(erase("żó")).toBe("ż")
})
