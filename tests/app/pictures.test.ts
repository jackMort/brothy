import { expect, test } from "bun:test"
import { deflateSync } from "node:zlib"
import type { NativeImage } from "@opentui/core"
import { cellOf, PictureCache, pictureMode } from "../../src/app/pictures"

test("pictureMode: text when asked, after a failure, or where no images show", () => {
  expect(pictureMode("auto", { pixels: true }, false)).toBe("pixels")
  expect(pictureMode("auto", { pixels: false }, false)).toBe("text")
  expect(pictureMode("pixels", { pixels: false }, false)).toBe("text")
  expect(pictureMode("text", { pixels: true }, false)).toBe("text")
  expect(pictureMode("auto", { pixels: true }, true)).toBe("text")
})

test("cellOf rounds herdr's fractional cells", () => {
  expect(cellOf({ pixels: true, mux: true, cellW: 9.1, cellH: 20.4 })).toEqual({ w: 9, h: 20 })
  expect(cellOf({ pixels: true, mux: false, cellW: 0.2, cellH: 0 })).toEqual({ w: 1, h: 1 })
})

// A PNG made from own pixels (8-bit RGBA).
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (b: Uint8Array) => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Uint8Array) => {
  const body = new Uint8Array([...Buffer.from(type, "latin1"), ...data])
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set(body, 4)
  dv.setUint32(8 + data.length, crc(body))
  return out
}
const makePng = (w: number, h: number, rgba: number[]) => {
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const rows: number[] = []
  for (let y = 0; y < h; y++) rows.push(0, ...rgba.slice(y * w * 4, (y + 1) * w * 4))
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(Uint8Array.from(rows)))),
    chunk("IEND", new Uint8Array()),
  ]
  return Uint8Array.from(parts.flatMap((p) => [...p]))
}
const PNG = makePng(1, 1, [200, 100, 50, 255])
const CLEAR_PNG = makePng(1, 1, [0, 0, 0, 0])
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="10" height="10" fill="red"/><rect x="10" width="10" height="10" fill="blue"/></svg>',
)

/** Poll for a condition (a decode lands a macrotask or more later), bounded. */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(5)
  expect(cond()).toBe(true)
}

const fake = (w: number, h: number) => {
  let disposed = false
  return {
    width: w,
    height: h,
    dispose: () => {
      disposed = true
    },
    get gone() {
      return disposed
    },
  } as unknown as NativeImage & { gone: boolean }
}

test("PictureCache: decodes once per key, evicts the oldest past the cap and disposes it", async () => {
  const made: (NativeImage & { gone: boolean })[] = []
  const cache = new PictureCache(
    100 * 100 * 4 * 2,
    (_b, _f, w, h) => {
      const img = fake(w, h)
      made.push(img)
      return img
    },
    () => PNG,
  )
  let done = 0
  cache.want("a", "/a.png", 100, 100, null, () => done++)
  cache.want("a", "/a.png", 100, 100, null, () => done++)
  expect(cache.get("a")).toBeUndefined()
  await until(() => done === 1)
  expect(cache.get("a")).toBe(made[0]!)
  cache.want("b", "/b.png", 100, 100, null, () => done++)
  cache.want("c", "/c.png", 100, 100, null, () => done++)
  await until(() => done === 3)
  expect(made[0]!.gone).toBe(true)
  expect(cache.get("a")).toBeUndefined()
  expect(made).toHaveLength(3)
})

test("PictureCache: decodes yield to the event loop between jobs", async () => {
  const cache = new PictureCache(
    1e9,
    (_b, _f, w, h) => fake(w, h),
    () => PNG,
  )
  let ticked = false
  const done: string[] = []
  for (const k of ["a", "b", "c"]) cache.want(k, `/${k}.png`, 4, 4, null, () => done.push(k + (ticked ? "!" : "")))
  // a frame's worth of other work, queued behind the first job: it must run before the last decode
  setImmediate(() => {
    ticked = true
  })
  await until(() => done.length === 3)
  expect(done.some((d) => d.endsWith("!"))).toBe(true)
})

test("PictureCache: a decode that throws is remembered as failed, never retried", async () => {
  let calls = 0
  const cache = new PictureCache(
    1e9,
    () => {
      calls++
      throw new Error("bad")
    },
    () => PNG,
  )
  let done = 0
  cache.want("x", "/x.png", 10, 10, null, () => done++)
  await until(() => done === 1)
  cache.want("x", "/x.png", 10, 10, null, () => done++)
  await Bun.sleep(20)
  expect(cache.get("x")).toBeNull()
  expect(cache.failed("x")).toBe(true)
  expect(calls).toBe(1)
  expect(done).toBe(1)
})

test("PictureCache: an unknown format, or a read that throws, is a failure", async () => {
  let done = 0
  const bad = new PictureCache(
    1e9,
    (_b, _f, w, h) => fake(w, h),
    () => new Uint8Array([1, 2, 3]),
  )
  bad.want("g", "/g", 4, 4, null, () => done++)
  const gone = new PictureCache(1e9, undefined, () => {
    throw new Error("ENOENT")
  })
  gone.want("n", "/n", 4, 4, null, () => done++)
  await until(() => done === 2)
  expect(bad.failed("g")).toBe(true)
  expect(gone.failed("n")).toBe(true)
})

test("PictureCache: a clear while a job is running disposes its image and skips done", async () => {
  const made: (NativeImage & { gone: boolean })[] = []
  let done = 0
  let cache!: PictureCache
  cache = new PictureCache(
    1e9,
    (_b, _f, w, h) => {
      const img = fake(w, h)
      made.push(img)
      return img
    },
    () => {
      cache.clear() // the app unmounts while the job is under way
      return SVG // an SVG waits for the renderer to load
    },
  )
  cache.want("s", "/s.svg", 4, 4, null, () => done++)
  await until(() => made.length === 1)
  await Bun.sleep(20)
  expect(made[0]!.gone).toBe(true)
  expect(done).toBe(0)
  expect(cache.get("s")).toBeUndefined()
})

const px = (img: NativeImage) => [...img.raw().data.subarray(0, 4)]

test("real decoder: a PNG comes out at exactly the requested size", async () => {
  const cache = new PictureCache(1e9, undefined, () => PNG)
  cache.want("p", "/p.png", 7, 3, null, () => {})
  await until(() => cache.get("p") !== undefined)
  const img = cache.get("p")!
  expect([img.width, img.height]).toEqual([7, 3])
  expect(px(img)).toEqual([200, 100, 50, 255])
  img.dispose()
})

test("real decoder: truncated, garbage and empty bytes fail without throwing", async () => {
  for (const bytes of [PNG.subarray(0, 40), new Uint8Array(200).fill(7), new Uint8Array()]) {
    const cache = new PictureCache(1e9, undefined, () => bytes)
    cache.want("x", "/x", 4, 4, null, () => {})
    await until(() => cache.get("x") !== undefined)
    expect(cache.failed("x")).toBe(true)
  }
})

test("real decoder: an SVG is drawn at exactly the requested size", async () => {
  const cache = new PictureCache(1e9, undefined, () => SVG)
  cache.want("v", "/v.svg", 20, 10, null, () => {})
  await until(() => cache.get("v") !== undefined)
  const img = cache.get("v")!
  expect([img.width, img.height]).toEqual([20, 10])
  const row = img.raw().data
  expect([...row.subarray(0, 4)]).toEqual([255, 0, 0, 255])
  expect([...row.subarray(19 * 4, 19 * 4 + 4)]).toEqual([0, 0, 255, 255])
  img.dispose()
})

test("real decoder: an SVG whose aspect differs from the box still ends up the box's size", async () => {
  const cache = new PictureCache(1e9, undefined, () => SVG)
  cache.want("v", "/v.svg", 10, 10, null, () => {})
  await until(() => cache.get("v") !== undefined)
  expect([cache.get("v")!.width, cache.get("v")!.height]).toEqual([10, 10])
})

test("real decoder: bg flattens a transparent pixel onto the colour; null leaves it clear", async () => {
  const flat = new PictureCache(1e9, undefined, () => CLEAR_PNG)
  flat.want("f", "/f.png", 2, 2, [10, 20, 30], () => {})
  const clear = new PictureCache(1e9, undefined, () => CLEAR_PNG)
  clear.want("c", "/c.png", 2, 2, null, () => {})
  await until(() => flat.get("f") !== undefined && clear.get("c") !== undefined)
  expect(px(flat.get("f")!)).toEqual([10, 20, 30, 255])
  expect(px(clear.get("c")!)[3]).toBe(0)
})
