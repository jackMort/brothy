// Pictures in notes, the impure side: which mode shows, the cell size, where each picture lives and which part of it
// is on screen, and the decoded images (one NativeImage per file, box and background, least recently used dropped past
// 32 MB and disposed). Decodes off the render, one at a time, a macrotask apart so a frame can paint between two.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type CliRenderer, NativeImage } from "@opentui/core"
import { type GraphTerm, graphTerm } from "../graph/sheet"
import type { Pic, PictureOpts, Rendered } from "../markdown/render"
import { type FileNode, findVault } from "../notes/files"
import {
  type ImageFormat,
  imageInfo,
  imageSig,
  isImagePath,
  isRemoteImage,
  resolveImage,
  SNIFF_BYTES,
  sniffSize,
} from "../notes/images"
import { STDIN } from "../notes/workspace"
import type { PicturesPref } from "../system/config"
import { ensureSvg, svgRaster } from "./svg"

const PICTURE_CACHE_BYTES = 32 * 1024 * 1024

/** A cell in whole pixels. */
export type Cell = { w: number; h: number }
/** Laid out with this until the terminal says otherwise. */
export const DEFAULT_CELL: Cell = { w: 8, h: 16 }
/** What the picture code reads from the renderer. */
export type PictureTerminal = Pick<CliRenderer, "capabilities" | "resolution" | "terminalWidth" | "terminalHeight">
/** After a resize or an unknown start: looks for the resolution this often, this many times (then pixels are off). */
const CELL_POLL_MS = 100
const CELL_TRIES = 10

/** Text when asked for, once pixels failed this run, or where the terminal shows no images; else pixels. */
export const pictureMode = (pref: PicturesPref, term: Pick<GraphTerm, "pixels">, failed: boolean): "pixels" | "text" =>
  pref !== "text" && !failed && term.pixels ? "pixels" : "text"

/** A cell in whole pixels (herdr reports fractions such as 9.1 × 20). */
export const cellOf = (term: GraphTerm) => ({
  w: Math.max(1, Math.round(term.cellW)),
  h: Math.max(1, Math.round(term.cellH)),
})

/** The terminal as a layout sees it: the resolution stands in from `last` while unknown (sixel needs one, kitty doesn't). */
const termOf = (r: PictureTerminal, last: Cell) =>
  graphTerm(
    r.capabilities,
    r.resolution ?? { width: last.w * r.terminalWidth, height: last.h * r.terminalHeight },
    r.terminalWidth,
    r.terminalHeight,
  )

/** How the document is laid out now: text once the wait for a resolution ended (`noCell`), else by capability; the last cell known. */
export function pictureLayout(
  s: { pictures: PicturesPref; picFailed: boolean; noCell: boolean; cell: Cell | null },
  r: PictureTerminal,
  last: Cell,
) {
  return { mode: pictureMode(s.pictures, termOf(r, last), s.picFailed || s.noCell), cell: s.cell ?? last }
}

/** What `watchCell` works on: the app context's part of it. */
interface CellDeps {
  ui: { current: { cell: Cell | null; noCell: boolean } }
  set: (patch: { cell?: Cell | null; noCell?: boolean }) => void
  renderer: PictureTerminal
  timers: { current: { cell?: ReturnType<typeof setTimeout> } }
  lastCell: { current: Cell }
}

/**
 * Keeps `cell` on what the renderer knows. OpenTUI drops the resolution on a resize and has no event for it landing:
 * `read` takes it when it's there, `poll` looks for a second, `resized` also clears the cell until it lands.
 */
export function watchCell({ ui, set, renderer, timers, lastCell }: CellDeps) {
  const read = () => {
    const res = renderer.resolution
    if (!res) return false
    const cell = cellOf(graphTerm(renderer.capabilities, res, renderer.terminalWidth, renderer.terminalHeight))
    lastCell.current = cell
    const s = ui.current
    if (s.noCell || s.cell?.w !== cell.w || s.cell.h !== cell.h) set({ cell, noCell: false })
    return true
  }
  const poll = (left = CELL_TRIES) => {
    clearTimeout(timers.current.cell)
    if (read() || !termOf(renderer, lastCell.current).pixels) return
    if (left === 0) return set({ noCell: true })
    timers.current.cell = setTimeout(() => poll(left - 1), CELL_POLL_MS)
  }
  const resized = () => {
    if (!renderer.resolution && ui.current.cell) set({ cell: null })
    poll()
  }
  return { read, poll, resized }
}

/**
 * Where a note's pictures live: the layout's size lookup (`info`, null for a target that isn't a picture) and the file
 * each target resolved to. A piped document has no folder of its own: it stands in the workspace folder.
 */
export function pictureFiles(openPath: string | null, root: string, tree: FileNode) {
  const note = openPath && openPath !== STDIN ? openPath : join(root, STDIN)
  const roots = { vault: findVault(dirname(note)), root }
  const files = new Map<string, string>()
  const info: PictureOpts["info"] = (src) => {
    if (!isImagePath(src.split(/[?#]/)[0]!) && !isRemoteImage(src)) return null
    const file = resolveImage(src, note, roots, tree)
    if (typeof file !== "string") return file
    files.set(src, file)
    const size = imageInfo(file)
    return "problem" in size ? size : { w: size.w, h: size.h }
  }
  return { info, file: (src: string) => files.get(src) ?? null }
}
/** What `pictureFiles` returns. */
export type PictureFiles = ReturnType<typeof pictureFiles>

/** One decoded image per file contents, box, cell size, background: `path#sig#cols×rows#cell#theme#t|o`. */
export const picKey = (path: string, p: Pic, cell: Cell, theme: string, transparent: boolean) =>
  `${path}#${imageSig(path)}#${p.cols}x${p.rows}#${cell.w}x${cell.h}#${theme}#${transparent ? "t" : "o"}`

/**
 * The part of `p` in the `rows` rows from `top`, null when none is: where it sits from the first row, how many rows it
 * takes and the source pixels those rows show. Zen shows only lines `lo..hi` of the note (a page, the note's ends).
 */
export function picWindow(p: Pic, top: number, rows: number, cell: Cell, lo = 0, hi = Number.POSITIVE_INFINITY) {
  const from = Math.max(0, top - p.line, lo - p.line)
  const to = Math.min(p.rows, top + rows - p.line, hi - p.line)
  if (from >= to) return null
  return {
    y: p.line + from - top,
    rows: to - from,
    crop: { left: 0, top: from * cell.h, width: p.cols * cell.w, height: (to - from) * cell.h },
  }
}

/** Which rows are a picture's reserved rows (not its caption or a placeholder row). */
export function reservedRows(view: Rendered): boolean[] {
  const rows = Array<boolean>(view.lines.length).fill(false)
  for (const p of view.pics ?? []) rows.fill(true, p.line, p.line + p.rows)
  return rows
}

type Bg = readonly [number, number, number]
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

  /** Ask for `key` decoded at `w × h`; `done` runs once it lands (or fails), and may not throw. Asking again while queued does nothing. */
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
      try {
        done()
      } catch {
        // the picture landed; the queue goes on
      }
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
