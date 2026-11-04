import { expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { NativeImage } from "@opentui/core"
import { createTerminalCapabilities } from "@opentui/core/testing"
import {
  type Cell,
  cellOf,
  PictureCache,
  picKey,
  pictureFiles,
  pictureLayout,
  pictureMode,
  picWindow,
  reservedRows,
  watchCell,
} from "../../src/app/pictures"
import { scanTree } from "../../src/notes/files"
import { STDIN } from "../../src/notes/workspace"
import { makePng } from "../helpers/png"
import { makeTmp } from "../helpers/tmp"

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
  // the next render does not draw it
  cache.frame()
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

test("PictureCache: a picture touched on every render survives eviction past the cap", async () => {
  const cache = new PictureCache(
    100 * 100 * 4 * 2,
    (_b, _f, w, h) => fake(w, h),
    () => PNG,
  )
  let done = 0
  cache.want("seen", "/a.png", 100, 100, null, () => done++)
  cache.want("old", "/b.png", 100, 100, null, () => done++)
  await until(() => done === 2)
  const seen = cache.get("seen") as NativeImage & { gone: boolean }
  cache.want("new", "/c.png", 100, 100, null, () => done++)
  await until(() => done === 3)
  expect(cache.get("seen")).toBe(seen)
  expect(seen.gone).toBe(false)
  expect(cache.get("old")).toBeUndefined()
})

test("PictureCache: nothing touched in the current frame is evicted, whatever it totals; the cap comes back after", async () => {
  const cache = new PictureCache(
    100 * 100 * 4 * 2,
    (_b, _f, w, h) => fake(w, h),
    () => PNG,
  )
  let done = 0
  const keys = ["a", "b", "c", "d"]
  // one frame draws all four (twice the cap), each as it lands: a landing in the same frame evicts none of them
  cache.frame()
  for (const k of keys) cache.want(k, `/${k}.png`, 100, 100, null, () => (cache.get(k), done++))
  await until(() => done === 4)
  const imgs = keys.map((k) => cache.get(k) as NativeImage & { gone: boolean })
  cache.want("e", "/e.png", 100, 100, null, () => done++)
  await until(() => done === 5)
  expect(imgs.every((i) => i && !i.gone)).toBe(true)
  // the next frame draws only e and a: the rest go on the next landing, down to the cap
  cache.frame()
  cache.get("e")
  cache.get("a")
  cache.want("f", "/f.png", 100, 100, null, () => done++)
  await until(() => done === 6)
  expect(cache.get("b")).toBeUndefined()
  expect(cache.get("c")).toBeUndefined()
  expect(cache.get("d")).toBeUndefined()
  expect(imgs.map((i) => i.gone)).toEqual([false, true, true, true])
  expect(cache.get("f")).toBeDefined()
})

test("PictureCache: a done that throws leaves the queue running", async () => {
  const cache = new PictureCache(
    1e9,
    (_b, _f, w, h) => fake(w, h),
    () => PNG,
  )
  let done = 0
  cache.want("a", "/a.png", 1, 1, null, () => {
    throw new Error("no")
  })
  cache.want("b", "/b.png", 1, 1, null, () => done++)
  await until(() => done === 1)
  expect(cache.get("a")).toBeDefined()
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

const CELL: Cell = { w: 10, h: 20 }
const PIC = { id: 0, line: 10, rows: 5, cols: 20, left: 3, src: "a.png", alt: "a" }

test("picWindow: the rows on screen and the source pixels they show", () => {
  expect(picWindow(PIC, 0, 26, CELL)).toEqual({ y: 10, rows: 5, crop: { left: 0, top: 0, width: 200, height: 100 } })
  expect(picWindow(PIC, 12, 26, CELL)).toEqual({ y: 0, rows: 3, crop: { left: 0, top: 40, width: 200, height: 60 } })
  expect(picWindow(PIC, 0, 12, CELL)).toEqual({ y: 10, rows: 2, crop: { left: 0, top: 0, width: 200, height: 40 } })
  // taller than the window: the middle
  expect(picWindow(PIC, 11, 2, CELL)).toEqual({ y: 0, rows: 2, crop: { left: 0, top: 20, width: 200, height: 40 } })
})

test("picWindow: only the lines inside lo..hi, for a page", () => {
  // PIC sits on lines 10..14: a page that starts at 12 shows its last three rows, one that ends at 12 its first two
  expect(picWindow(PIC, 0, 26, CELL, 12)).toEqual({
    y: 12,
    rows: 3,
    crop: { left: 0, top: 40, width: 200, height: 60 },
  })
  expect(picWindow(PIC, 0, 26, CELL, 0, 12)).toEqual({
    y: 10,
    rows: 2,
    crop: { left: 0, top: 0, width: 200, height: 40 },
  })
  expect(picWindow(PIC, 0, 26, CELL, 15)).toBeNull()
})

test("picWindow: nothing above, below, or for a placeholder", () => {
  expect(picWindow(PIC, 15, 26, CELL)).toBeNull()
  expect(picWindow(PIC, 0, 10, CELL)).toBeNull()
  expect(picWindow({ ...PIC, rows: 0 }, 0, 26, CELL)).toBeNull()
})

test("picKey: another cell size, box, theme or background is another image", () => {
  const key = picKey("/a.png", PIC, CELL, "brothy", false)
  expect(key).toBe("/a.png##20x5#10x20#brothy#o")
  expect(picKey("/a.png", PIC, { w: 9, h: 20 }, "brothy", false)).not.toBe(key)
  expect(picKey("/a.png", { ...PIC, cols: 21 }, CELL, "brothy", false)).not.toBe(key)
  expect(picKey("/a.png", PIC, CELL, "tokyonight", false)).not.toBe(key)
  expect(picKey("/a.png", PIC, CELL, "brothy", true)).not.toBe(key)
})

test("reservedRows: never the caption or a placeholder", () => {
  const view = {
    lines: Array.from({ length: 5 }, () => ({ spans: [] })),
    headings: [],
    plain: [],
    pics: [
      { ...PIC, id: 0, line: 1, rows: 2 },
      { ...PIC, id: 1, line: 4, rows: 0 },
    ],
  }
  expect(reservedRows(view)).toEqual([false, true, true, false, false])
})

const KITTY = { terminalWidth: 100, terminalHeight: 30, resolution: null } as const
const kitty = createTerminalCapabilities({ kitty_graphics: true })
const sixel = createTerminalCapabilities({ sixel: true })
const state = { pictures: "auto", picFailed: false, noCell: false, cell: null } as const

test("pictureLayout: with no resolution yet the last cell stands in, for kitty and for sixel", () => {
  const last = { w: 9, h: 18 }
  expect(pictureLayout(state, { ...KITTY, capabilities: kitty }, last)).toEqual({ mode: "pixels", cell: last })
  expect(pictureLayout(state, { ...KITTY, capabilities: sixel }, last)).toEqual({ mode: "pixels", cell: last })
  expect(pictureLayout({ ...state, cell: CELL }, { ...KITTY, capabilities: kitty }, last).cell).toEqual(CELL)
})

test("pictureLayout: text once the wait ended, after a failure, as asked, or with no images", () => {
  const r = { ...KITTY, capabilities: kitty }
  expect(pictureLayout({ ...state, noCell: true }, r, CELL).mode).toBe("text")
  expect(pictureLayout({ ...state, picFailed: true }, r, CELL).mode).toBe("text")
  expect(pictureLayout({ ...state, pictures: "text" }, r, CELL).mode).toBe("text")
  expect(pictureLayout(state, { ...r, capabilities: createTerminalCapabilities() }, CELL).mode).toBe("text")
})

/** A store and renderer for `watchCell`, without an app. */
const cellRig = (resolution: { width: number; height: number } | null) => {
  const ui = { current: { cell: null as Cell | null, noCell: false } }
  const renderer = { ...KITTY, capabilities: kitty, resolution }
  const sets: object[] = []
  const set = (patch: object) => {
    sets.push(patch)
    Object.assign(ui.current, patch)
  }
  const rig = { ui, set, renderer, timers: { current: {} }, lastCell: { current: { w: 8, h: 16 } } }
  return { ...rig, sets, watch: watchCell(rig) }
}

test("watchCell: rounds the resolution through cellOf and sets it once, whatever the polls", () => {
  const r = cellRig({ width: 910, height: 600 })
  r.watch.poll()
  r.watch.poll()
  r.watch.resized()
  expect(r.sets).toEqual([{ cell: { w: 9, h: 20 }, noCell: false }])
  expect(r.lastCell.current).toEqual({ w: 9, h: 20 })
})

test("watchCell: a resize clears the cell and keeps the last one for the layout", () => {
  const r = cellRig({ width: 1000, height: 600 })
  r.watch.poll()
  r.renderer.resolution = null as never
  r.watch.resized()
  clearTimeout((r.timers.current as { cell?: ReturnType<typeof setTimeout> }).cell)
  expect(r.ui.current.cell).toBeNull()
  expect(r.lastCell.current).toEqual(CELL)
})

test("pictureFiles: a piped document stands in the folder; a target that is no picture is null; remote is a problem", () => {
  const d = makeTmp("brothy-pics-")
  writeFileSync(join(d, "a.png"), PNG)
  const tree = scanTree(d)
  const piped = pictureFiles(STDIN, d, tree)
  expect(piped.info("a.png")).toEqual({ w: 1, h: 1 })
  expect(piped.file("a.png")).toBe(join(d, "a.png"))
  expect(piped.info("other.md")).toBeNull()
  expect(piped.info("https://x.example/a")).toEqual({ problem: "remote image" })
  expect(piped.info("gone.png")).toEqual({ problem: "not found" })
  expect(piped.file("gone.png")).toBeNull()
  rmSync(d, { recursive: true })
})
