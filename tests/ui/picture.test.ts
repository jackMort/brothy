import { expect, test } from "bun:test"
import { halfBlocks, pictureFit, pictureTitle } from "../../src/ui/picture"

test("pictureFit: aspect kept, centred, upscaled to fill", () => {
  expect(pictureFit({ w: 400, h: 200 }, 60, 20, { w: 10, h: 20 })).toEqual({ cols: 60, rows: 15, left: 0, top: 2 })
  expect(pictureFit({ w: 100, h: 400 }, 60, 20, { w: 10, h: 20 })).toEqual({ cols: 10, rows: 20, left: 25, top: 0 })
  expect(pictureFit({ w: 1, h: 1 }, 40, 10, { w: 8, h: 16 })).toEqual({ cols: 20, rows: 10, left: 10, top: 0 })
})

test("pictureTitle drops the path, then the size", () => {
  const p = { alt: "Plan", size: { w: 1200, h: 800 } }
  expect(pictureTitle(p, "img/plan.png", 80)).toBe("Plan · 1200×800 · img/plan.png")
  expect(pictureTitle(p, "img/plan.png", 18)).toBe("Plan · 1200×800")
  expect(pictureTitle(p, "img/plan.png", 6)).toBe("Plan")
  expect(pictureTitle(p, "img/plan.png", 3)).toBe("Pl…")
  expect(pictureTitle({ alt: "Gone" }, "a.png", 40)).toBe("Gone · a.png")
})

test("halfBlocks: ▀ with the top pixel as fg and the bottom as bg; transparent shows bg", () => {
  const px = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0]) // 1×2: red over transparent
  expect(halfBlocks(px, 1, 2, "#101010")).toEqual([[{ text: "▀", fg: "#ff0000", bg: "#101010" }]])
})

test("halfBlocks: an odd last pixel row sits over the background, alpha mixes over it", () => {
  const px = new Uint8Array([0, 0, 0, 128]) // 1×1: half-black
  expect(halfBlocks(px, 1, 1, "#ffffff")[0]![0]).toEqual({ text: "▀", fg: "#7f7f7f", bg: "#ffffff" })
})
