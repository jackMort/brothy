// Pictures in notes: the header sniffer (size without decoding). Pure. Never fetches.

type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "svg"
interface ImageSize {
  w: number
  h: number
  format: ImageFormat
}

// How much of a file the sniffer reads.
const SNIFF_BYTES = 64 * 1024

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
