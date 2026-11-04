// Pictures in notes: the header sniffer (size without decoding), where a target lives, and the cached size read. Never fetches.

import { closeSync, type Dirent, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type FileNode, SCAN_DEPTH, SCAN_LIMIT, skipped } from "./files"

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "svg"
interface ImageSize {
  w: number
  h: number
  format: ImageFormat
}

// How much of a file the sniffer reads.
export const SNIFF_BYTES = 64 * 1024
// Caps: a bigger file or more pixels than this is not drawn.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40_000_000

/** Why a picture cannot show. */
type ImageProblem = "not found" | "remote image" | "outside the folder" | "too large" | "unsupported" | "unreadable"

// Reads past the end give 0, so a truncated header is a zero size, never NaN.
const at = (b: Uint8Array, i: number) => b[i] ?? 0
const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0))
const be16 = (b: Uint8Array, i: number) => (at(b, i) << 8) | at(b, i + 1)
const be32 = (b: Uint8Array, i: number) =>
  ((at(b, i) << 24) | (at(b, i + 1) << 16) | (at(b, i + 2) << 8) | at(b, i + 3)) >>> 0
const le16 = (b: Uint8Array, i: number) => at(b, i) | (at(b, i + 1) << 8)
const le24 = (b: Uint8Array, i: number) => le16(b, i) | (at(b, i + 2) << 16)
const le32 = (b: Uint8Array, i: number) => (le16(b, i) | (le16(b, i + 2) << 16)) >>> 0

const sized = (w: number, h: number, format: ImageFormat): ImageSize | null =>
  w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) ? { w, h, format } : null

function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || !ascii(b, 12, "IHDR")) return null
  return sized(be32(b, 16), be32(b, 20), "png")
}

function gif(b: Uint8Array): ImageSize | null {
  return b.length < 10 ? null : sized(le16(b, 6), le16(b, 8), "gif")
}

// EXIF orientation from the TIFF block in [from, end), or 1.
function exifOrientation(b: Uint8Array, from: number, end: number): number {
  if (from + 8 > end) return 1
  const le = ascii(b, from, "II")
  const u16 = (i: number) => (le ? le16(b, i) : be16(b, i))
  const ifd = from + (le ? le32(b, from + 4) : be32(b, from + 4))
  if (ifd + 2 > end) return 1
  const n = u16(ifd)
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12
    if (e + 12 > end) return 1
    if (u16(e) === 0x0112) return u16(e + 8)
  }
  return 1
}

// SOF0..SOF15 except DHT (c4), JPG (c8), DAC (cc).
const isSOF = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc

// Where a JPEG's frame header says the size is, given orientation: null when it is cut short.
function frame(b: Uint8Array, i: number, orient: number): ImageSize | null {
  if (i + 9 > b.length) return null
  const h = be16(b, i + 5)
  const w = be16(b, i + 7)
  return orient >= 5 && orient <= 8 ? sized(h, w, "jpeg") : sized(w, h, "jpeg")
}

function jpeg(b: Uint8Array): ImageSize | null {
  let i = 2
  let orient = 1
  while (i + 4 <= b.length) {
    const m = at(b, i + 1)
    const len = be16(b, i + 2)
    // A segment length counts its own two bytes; less would never advance.
    if (b[i] !== 0xff || len < 2) return null
    if (m === 0xe1 && ascii(b, i + 4, "Exif\0\0")) orient = exifOrientation(b, i + 10, Math.min(b.length, i + 2 + len))
    if (isSOF(m)) return frame(b, i, orient)
    i += 2 + len
  }
  return null
}

const webpX = (b: Uint8Array) => (b.length < 30 ? null : sized(le24(b, 24) + 1, le24(b, 27) + 1, "webp"))

function webpL(b: Uint8Array) {
  if (b.length < 25 || b[20] !== 0x2f) return null
  const bits = le32(b, 21)
  return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, "webp")
}

function webpLossy(b: Uint8Array) {
  if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
  return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff, "webp")
}

function webp(b: Uint8Array): ImageSize | null {
  if (ascii(b, 12, "VP8X")) return webpX(b)
  if (ascii(b, 12, "VP8L")) return webpL(b)
  return ascii(b, 12, "VP8 ") ? webpLossy(b) : null
}

const px = (v: string | undefined) => (v && /^\s*[\d.]+\s*(px)?\s*$/.test(v) ? Number.parseFloat(v) : Number.NaN)

function svg(b: Uint8Array): ImageSize | null {
  const head = new TextDecoder().decode(b.subarray(0, SNIFF_BYTES))
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0]
  if (!tag) return null
  const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1]
  const w = px(attr("width"))
  const h = px(attr("height"))
  if (w > 0 && h > 0) return sized(Math.round(w), Math.round(h), "svg")
  const vb = attr("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  return vb && vb.length === 4 ? sized(Math.round(vb[2] ?? 0), Math.round(vb[3] ?? 0), "svg") : null
}

/** A picture's pixel size from its first bytes (`SNIFF_BYTES` is plenty), without decoding; null when unknown or broken. */
export function sniffSize(b: Uint8Array): ImageSize | null {
  if (b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) return png(b)
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return gif(b)
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b)
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return webp(b)
  return svg(b)
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"])
export const isImagePath = (p: string) => IMAGE_EXT.has(extname(p).toLowerCase())
/** A target that is never fetched. */
export const isRemoteImage = (t: string) => /^(https?:|data:)/i.test(t.trim())

/** `300` or `300x200` (Obsidian's `|size`); anything else is an alias, null. */
export function parseImageSize(s: string | undefined): { w?: number; h?: number } | null {
  const m = s ? /^\s*(\d{1,5})(?:\s*x\s*(\d{1,5}))?\s*$/.exec(s) : null
  if (!m) return null
  const w = Number(m[1])
  return m[2] ? { w, h: Number(m[2]) } : { w }
}

export interface ImageIO {
  exists(p: string): boolean
  real(p: string): string
}
const fsIO: ImageIO = { exists: existsSync, real: realpathSync }

const inside = (root: string, p: string) => {
  const r = relative(root, p)
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}

/** Image files found by one walk: what is left to examine and the folders already walked. */
interface Walk {
  map: Map<string, string[]>
  left: number
  visited: Set<string>
}

const realOrNull = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Whether a symlink resolves to a file inside `rootReal`; images never leave the root. */
function linkedFileInside(rootReal: string, full: string): boolean {
  const rp = realOrNull(full)
  try {
    return !!rp && inside(rootReal, rp) && statSync(rp).isFile()
  } catch {
    return false
  }
}

function addImage(w: Walk, name: string, full: string) {
  const k = name.toLowerCase()
  w.map.set(k, [...(w.map.get(k) ?? []), full])
}

/** Records one directory entry: folders are walked (links to folders are not), pictures kept. */
function visitEntry(w: Walk, rootReal: string, e: Dirent, full: string, depth: number) {
  if (e.isDirectory()) return walkImages(w, rootReal, full, depth + 1)
  if (!isImagePath(e.name)) return
  if (e.isFile() || (e.isSymbolicLink() && linkedFileInside(rootReal, full))) addImage(w, e.name, full)
}

/** Walks as `scanTree` does (same depth, entry budget and skipped names), but symlinked folders are never entered. */
function walkImages(w: Walk, rootReal: string, dir: string, depth: number) {
  const rp = depth < SCAN_DEPTH ? realOrNull(dir) : null
  if (!rp || w.visited.has(rp)) return
  w.visited.add(rp)
  for (const e of readEntries(dir)) {
    if (skipped(e.name)) continue
    if (--w.left < 0) return
    visitEntry(w, rootReal, e, join(dir, e.name), depth)
  }
}

let treeMemo: { tree: FileNode; map: Map<string, string[]> } | null = null

/** Image files under the tree's root by lowercase basename, shortest path first (one walk per tree). */
const imageTree = (tree: FileNode): Map<string, string[]> => {
  if (treeMemo?.tree === tree) return treeMemo.map
  const w: Walk = { map: new Map(), left: SCAN_LIMIT, visited: new Set() }
  const rootReal = realOrNull(tree.path)
  if (rootReal) walkImages(w, rootReal, tree.path, 0)
  for (const ps of w.map.values()) ps.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
  treeMemo = { tree, map: w.map }
  return w.map
}

/** `p` when it exists and its realpath is inside `rootReal`; "outside" when it exists beyond it; null otherwise. */
function checked(io: ImageIO, rootReal: string, p: string): string | "outside" | null {
  if (!io.exists(p)) return null
  try {
    return inside(rootReal, io.real(p)) ? p : "outside"
  } catch {
    return null
  }
}

const decodeTarget = (t: string) => {
  try {
    return decodeURIComponent(t)
  } catch {
    return t
  }
}

/** A picture found by its file name anywhere in the tree, shortest path first, and still inside the root. */
function byName(io: ImageIO, rootReal: string, tree: FileNode, target: string): string | null {
  const hits = imageTree(tree).get(target.split(/[\\/]/).at(-1)?.toLowerCase() ?? "") ?? []
  return hits.find((p) => checked(io, rootReal, p) === p) ?? null
}

/**
 * Where a picture's target lives: next to the note, from the vault root (else the folder), else by name anywhere in
 * the tree; never outside the root (by realpath), never a URL.
 */
export function resolveImage(
  target: string,
  notePath: string,
  roots: { vault: string | null; root: string },
  tree: FileNode,
  io: ImageIO = fsIO,
): string | { problem: ImageProblem } {
  const t = target.trim()
  if (isRemoteImage(t)) return { problem: "remote image" }
  const decoded = decodeTarget(t)
  const root = roots.vault ?? roots.root
  let rootReal: string
  try {
    rootReal = io.real(root)
  } catch {
    return { problem: "not found" }
  }
  let outside = false
  for (const p of [resolve(dirname(notePath), decoded), resolve(root, decoded)]) {
    const c = checked(io, rootReal, p)
    if (c === "outside") outside = true
    else if (c) return c
  }
  if (outside) return { problem: "outside the folder" }
  return byName(io, rootReal, tree, decoded) ?? { problem: "not found" }
}

type Info = ImageSize | { problem: ImageProblem }
const infoCache = new Map<string, { sig: string; info: Info }>()
const INFO_CAP = 500

function readHead(path: string, size: number): Uint8Array {
  const buf = new Uint8Array(Math.min(size, SNIFF_BYTES))
  const fd = openSync(path, "r")
  try {
    readSync(fd, buf, 0, buf.length, 0)
  } finally {
    closeSync(fd)
  }
  return buf
}

function measure(path: string, size: number): Info {
  if (size > MAX_IMAGE_BYTES) return { problem: "too large" }
  try {
    const s = sniffSize(readHead(path, size))
    if (!s) return { problem: "unsupported" }
    return s.w * s.h > MAX_IMAGE_PIXELS ? { problem: "too large" } : s
  } catch {
    return { problem: "unreadable" }
  }
}

/** A picture file's size (header only), or why it cannot show; cached by path, mtime and size. */
export function imageInfo(path: string): Info {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch {
    return { problem: "not found" }
  }
  if (!st.isFile()) return { problem: "not found" }
  const sig = `${st.mtimeMs}:${st.size}`
  const hit = infoCache.get(path)
  if (hit?.sig === sig) return hit.info
  const info = measure(path, st.size)
  if (infoCache.size >= INFO_CAP) infoCache.delete(infoCache.keys().next().value as string)
  infoCache.set(path, { sig, info })
  return info
}

/** What identifies a file's contents, as `imageInfo` last read it ("" before it has). */
export const imageSig = (path: string) => infoCache.get(path)?.sig ?? ""
