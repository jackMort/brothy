// The picture sheet's pure side: the image fitted into the sheet, its title, and the half-block drawing for terminals
// that show no images. Never reads files or state.
import { hexOf, rgb } from "../graph/canvas"
import type { Span } from "../lib/spans"
import { truncate, width } from "../lib/text"
import type { Pic } from "../markdown/render"

/** Where the picture sits in the sheet's body: its box in cells and the cells left and above it. */
export interface PictureFit {
  cols: number
  rows: number
  left: number
  top: number
}

/** `size` fitted into `cols × rows` cells of `cell` pixels: aspect kept, centred, and upscaled when small (the sheet is for looking). */
export function pictureFit(
  size: { w: number; h: number },
  cols: number,
  rows: number,
  cell: { w: number; h: number },
): PictureFit {
  const scale = Math.min((cols * cell.w) / size.w, (rows * cell.h) / size.h)
  const c = Math.max(1, Math.min(cols, Math.round((size.w * scale) / cell.w)))
  const r = Math.max(1, Math.min(rows, Math.round((size.h * scale) / cell.h)))
  return { cols: c, rows: r, left: Math.floor((cols - c) / 2), top: Math.floor((rows - r) / 2) }
}

/** `alt · 1200×800 · img/plan.png` within `room` columns: the path goes first, then the size, then the alt is cut. */
export function pictureTitle(p: Pick<Pic, "alt" | "size">, path: string, room: number): string {
  const size = p.size ? `${p.size.w}×${p.size.h}` : ""
  for (const parts of [[p.alt, size, path], [p.alt, size], [p.alt]]) {
    const s = parts.filter(Boolean).join(" · ")
    if (width(s) <= room) return s
  }
  return truncate(p.alt, room)
}

/** The pixel at byte `i` over `bg`. */
function over(px: Uint8Array, i: number, bg: readonly number[]): string {
  const a = (px[i + 3] ?? 0) / 255
  return hexOf([0, 1, 2].map((k) => Math.round((px[i + k] ?? 0) * a + bg[k]! * (1 - a))))
}

/** `▀` per cell: the upper pixel as foreground, the one under it as background, both over `bg` (a hex colour). */
export function halfBlocks(rgba: Uint8Array, w: number, h: number, bg: string): Span[][] {
  const base = rgb(bg)
  const out: Span[][] = []
  for (let y = 0; y < h; y += 2) {
    const row: Span[] = []
    for (let x = 0; x < w; x++) {
      const top = (y * w + x) * 4
      row.push({ text: "▀", fg: over(rgba, top, base), bg: y + 1 < h ? over(rgba, top + w * 4, base) : bg })
    }
    out.push(row)
  }
  return out
}
