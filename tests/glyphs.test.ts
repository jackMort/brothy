import { expect, test } from "bun:test"
import { superscript } from "../src/text"

test("superscript writes digits as superscripts", () => {
  expect(superscript(1)).toBe("¹")
  expect(superscript(3)).toBe("³")
  expect(superscript(12)).toBe("¹²")
})
