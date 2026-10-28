import { expect, test } from "bun:test"
import { capsOf } from "../scripts/cinema"

test("capsOf: the caps a storyboard key presses, arrows as the caption's arrow caps", () => {
  expect(capsOf("C-p")).toEqual(["ctrl", "p"])
  expect(capsOf("enter")).toEqual(["⏎"])
  expect(capsOf("down")).toEqual(["↓"])
  expect(capsOf("left")).toEqual(["←"])
  expect(capsOf("t")).toEqual(["t"])
})
