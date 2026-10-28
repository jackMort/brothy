import { expect, test } from "bun:test"
import { capsOf, wallpaperUrl } from "../scripts/cinema"

test("capsOf: the caps a storyboard key presses, arrows as the caption's arrow caps", () => {
  expect(capsOf("C-p")).toEqual(["ctrl", "p"])
  expect(capsOf("enter")).toEqual(["⏎"])
  expect(capsOf("down")).toEqual(["↓"])
  expect(capsOf("left")).toEqual(["←"])
  expect(capsOf("t")).toEqual(["t"])
})

test("wallpaperUrl: from BROTHY_WALLPAPER when the file is there, else null", () => {
  expect(wallpaperUrl({}, () => true)).toBeNull()
  expect(wallpaperUrl({ BROTHY_WALLPAPER: "  " }, () => true)).toBeNull()
  expect(wallpaperUrl({ BROTHY_WALLPAPER: "/w/a b.jpg" }, () => true)).toBe("file:///w/a%20b.jpg")
  expect(wallpaperUrl({ BROTHY_WALLPAPER: "/w/a.jpg" }, () => false)).toBeNull()
})
