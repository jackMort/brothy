import { expect, test } from "bun:test"
import type { NativeImage } from "@opentui/core"
import { imageFor, releaseImage } from "../../src/app/graph"
import type { GraphImage } from "../../src/app/store"

test("imageFor: one image per raster, the one before released; a failure is reported once, after the render, as null", async () => {
  const made: { disposed: boolean; dispose(): void }[] = []
  const make = () => {
    const img = {
      disposed: false,
      dispose() {
        this.disposed = true
      },
    }
    made.push(img)
    return img as unknown as NativeImage
  }
  let failed = 0
  const fail = () => void failed++
  const ref: { current: GraphImage } = { current: { px: null, img: null } }
  const a = { px: new Uint8Array(4), w: 1, h: 1 }
  expect(imageFor(ref, a, fail, make)).toBe(made[0] as unknown as NativeImage)
  expect(imageFor(ref, a, fail, make)).toBe(made[0] as unknown as NativeImage)
  expect(made).toHaveLength(1)
  imageFor(ref, { ...a, px: new Uint8Array(4) }, fail, make)
  expect(made[0]!.disposed).toBe(true)
  expect(imageFor(ref, null, fail, make)).toBeNull()
  expect(made[1]!.disposed).toBe(true)
  releaseImage(ref)
  expect(ref.current).toEqual({ px: null, img: null })
  const boom = () => {
    throw new Error("no image")
  }
  expect(imageFor(ref, a, fail, boom)).toBeNull()
  expect(failed).toBe(0)
  await Promise.resolve()
  expect(failed).toBe(1)
})
