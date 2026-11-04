// Pictures in notes, the impure side: which mode shows, the cell size, and the decoded images (one NativeImage per
// file, box and background, least recently used dropped past 32 MB and disposed). Decodes off the render, one at a
// time, a macrotask apart so a frame can paint between two.

import { readFileSync } from "node:fs"
import { NativeImage } from "@opentui/core"
import type { GraphTerm } from "../graph/sheet"
import { type ImageFormat, SNIFF_BYTES, sniffSize } from "../notes/images"
import type { PicturesPref } from "../system/config"
import { ensureSvg, svgRaster } from "./svg"

const PICTURE_CACHE_BYTES = 32 * 1024 * 1024

/** Text when asked for, once pixels failed this run, or where the terminal shows no images; else pixels. */
export const pictureMode = (pref: PicturesPref, term: Pick<GraphTerm, "pixels">, failed: boolean): "pixels" | "text" =>
  pref !== "text" && !failed && term.pixels ? "pixels" : "text"

/** A cell in whole pixels (herdr reports fractions such as 9.1 × 20). */
export const cellOf = (term: GraphTerm) => ({
  w: Math.max(1, Math.round(term.cellW)),
  h: Math.max(1, Math.round(term.cellH)),
})

type Bg = [number, number, number]
export type Decoder = (bytes: Uint8Array, format: ImageFormat, w: number, h: number) => NativeImage

/** Decode, fit to exactly `w × h` pixels, flattened onto `bg` when one is given. Every intermediate is disposed. */
function decodePicture(bg: Bg | null): Decoder {
  return (bytes, format, w, h) => {
    const src = format === "svg" ? svgRaster(bytes, w) : NativeImage.decode(bytes)
    let fit: NativeImage | undefined
    let base: NativeImage | undefined
    try {
      fit = src.resize({ width: w, height: h })
      if (!bg) {
        const out = fit
        fit = undefined
        return out
      }
      base = NativeImage.fromRgba(solid(w, h, bg), w, h)
      return base.composite(fit)
    } finally {
      src.dispose()
      fit?.dispose()
      base?.dispose()
    }
  }
}

const solid = (w: number, h: number, [r, g, b]: Bg) => {
  const px = new Uint8Array(w * h * 4)
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = 255
  }
  return px
}

interface Entry {
  img: NativeImage | null
  bytes: number
}

export class PictureCache {
  private entries = new Map<string, Entry>()
  private queue: (() => Promise<void>)[] = []
  private pending = new Set<string>()
  private busy = false
  private total = 0
  /** Bumped by `clear()`: a job that started before it must not put anything into the emptied cache. */
  private gen = 0
  constructor(
    private cap = PICTURE_CACHE_BYTES,
    private decode?: Decoder,
    private read: (path: string) => Uint8Array = (p) => readFileSync(p),
  ) {}

  /** The image for `key`: undefined while not decoded, null once it failed. Touches it (most recently used). */
  get(key: string): NativeImage | null | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    this.entries.delete(key)
    this.entries.set(key, e)
    return e.img
  }

  failed = (key: string) => this.entries.get(key)?.img === null

  /** Ask for `key` decoded at `w × h`; `done` runs once it lands (or fails). Asking again while queued does nothing. */
  want(key: string, path: string, w: number, h: number, bg: Bg | null, done: () => void) {
    if (this.entries.has(key) || this.pending.has(key)) return
    this.pending.add(key)
    this.queue.push(async () => {
      const gen = this.gen
      const img = await this.make(path, w, h, bg)
      if (gen !== this.gen) {
        img?.dispose()
        return
      }
      this.pending.delete(key)
      this.put(key, img, img ? w * h * 4 : 0)
      done()
    })
    this.pump()
  }

  /** The decoded picture, or null for any failure (unreadable, unknown format, a decoder that throws). Never throws. */
  private async make(path: string, w: number, h: number, bg: Bg | null): Promise<NativeImage | null> {
    try {
      const bytes = this.read(path)
      const format = sniffSize(bytes.subarray(0, SNIFF_BYTES))?.format
      if (!format) return null
      if (format === "svg") await ensureSvg()
      return (this.decode ?? decodePicture(bg))(bytes, format, w, h)
    } catch {
      return null
    }
  }

  private pump() {
    if (this.busy) return
    const next = this.queue.shift()
    if (!next) return
    this.busy = true
    setImmediate(async () => {
      try {
        await next()
      } finally {
        this.busy = false
        this.pump()
      }
    })
  }

  private put(key: string, img: NativeImage | null, bytes: number) {
    this.entries.set(key, { img, bytes })
    this.total += bytes
    for (const [k, e] of this.entries) {
      if (this.total <= this.cap || k === key) break
      e.img?.dispose()
      this.total -= e.bytes
      this.entries.delete(k)
    }
  }

  clear() {
    this.gen++
    for (const e of this.entries.values()) e.img?.dispose()
    this.entries.clear()
    this.queue = []
    this.pending.clear()
    this.total = 0
  }
}
