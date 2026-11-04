import { expect, test } from "bun:test"
import { sniffSize } from "../../src/notes/images"

const u8 = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)))
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const be16 = (n: number) => [(n >> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >> 8) & 255]
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]

test("sniffSize: PNG reads IHDR", () => {
  const png = u8([0x89], "PNG\r\n\x1a\n", be32(13), "IHDR", be32(1200), be32(800), [8, 6, 0, 0, 0])
  expect(sniffSize(png)).toEqual({ w: 1200, h: 800, format: "png" })
})

test("sniffSize: GIF reads the logical screen", () => {
  expect(sniffSize(u8("GIF89a", le16(320), le16(200)))).toEqual({ w: 320, h: 200, format: "gif" })
})

test("sniffSize: JPEG reads SOF0, skipping APP segments", () => {
  const jpg = u8([0xff, 0xd8], [0xff, 0xe0], be16(4), [0, 0], [0xff, 0xc0], be16(11), [8], be16(600), be16(900), [3])
  expect(sniffSize(jpg)).toEqual({ w: 900, h: 600, format: "jpeg" })
})

const exifJpeg = (tiff: number[]) => {
  const app1 = [0xff, 0xe1, ...be16(2 + 6 + tiff.length), ...Buffer.from("Exif\0\0", "latin1"), ...tiff]
  return u8([0xff, 0xd8], app1, [0xff, 0xc0], be16(11), [8], be16(600), be16(900), [3])
}

test("sniffSize: JPEG EXIF orientation 6 swaps width and height", () => {
  // APP1 Exif, big-endian TIFF, one IFD entry: 0x0112 (orientation) SHORT 1 = 6
  const tiff = [
    ...[..."MM"].map((c) => c.charCodeAt(0)),
    0,
    42,
    ...be32(8),
    ...be16(1),
    ...be16(0x0112),
    ...be16(3),
    ...be32(1),
    ...be16(6),
    0,
    0,
    ...be32(0),
  ]
  expect(sniffSize(exifJpeg(tiff))).toEqual({ w: 600, h: 900, format: "jpeg" })
})

test("sniffSize: JPEG EXIF with an IFD offset past the block keeps the stored size", () => {
  const tiff = [...[..."MM"].map((c) => c.charCodeAt(0)), 0, 42, ...be32(0xfffffff0), 0, 0, 0, 0]
  expect(sniffSize(exifJpeg(tiff))).toEqual({ w: 900, h: 600, format: "jpeg" })
})

test("sniffSize: JPEG segment lengths of 0 or 1 end the scan instead of looping", () => {
  expect(sniffSize(u8([0xff, 0xd8], [0xff, 0xe0], be16(0), [0, 0, 0, 0, 0, 0]))).toBeNull()
  expect(sniffSize(u8([0xff, 0xd8], [0xff, 0xe0], be16(1), [0, 0, 0, 0, 0, 0]))).toBeNull()
})

test("sniffSize: WebP VP8X, VP8L and VP8", () => {
  expect(sniffSize(u8("RIFF", [0, 0, 0, 0], "WEBPVP8X", [10, 0, 0, 0], [0, 0, 0, 0], le24(639), le24(479)))).toEqual({
    w: 640,
    h: 480,
    format: "webp",
  })
  // VP8L: 14-bit (w-1), 14-bit (h-1) after the 0x2f signature; 99 and 49 stored mean 100 x 50
  const w = 99
  const h = 49
  const bits = w | (h << 14)
  const l = u8(
    "RIFF",
    [0, 0, 0, 0],
    "WEBPVP8L",
    [0, 0, 0, 0],
    [0x2f],
    [bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255],
  )
  expect(sniffSize(l)).toEqual({ w: 100, h: 50, format: "webp" })
  expect(
    sniffSize(u8("RIFF", [0, 0, 0, 0], "WEBPVP8 ", [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(300), le16(150))),
  ).toEqual({
    w: 300,
    h: 150,
    format: "webp",
  })
})

test("sniffSize: SVG width/height, else viewBox; units other than px ignored", () => {
  expect(
    sniffSize(u8(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">`)),
  ).toEqual({
    w: 120,
    h: 60,
    format: "svg",
  })
  expect(sniffSize(u8(`<svg viewBox="0 0 400 100" width="100%">`))).toEqual({ w: 400, h: 100, format: "svg" })
})

test("sniffSize: unknown, truncated and zero sizes are null", () => {
  expect(sniffSize(u8("hello"))).toBeNull()
  expect(sniffSize(u8([0x89], "PNG\r\n\x1a\n"))).toBeNull()
  expect(sniffSize(u8("GIF89a", le16(0), le16(10)))).toBeNull()
})

test("sniffSize: every prefix of every format is null or a size, never a throw", () => {
  const samples = [
    u8([0x89], "PNG\r\n\x1a\n", be32(13), "IHDR", be32(12), be32(8)),
    u8("GIF89a", le16(3), le16(2)),
    exifJpeg([
      ...[..."II"].map((c) => c.charCodeAt(0)),
      42,
      0,
      8,
      0,
      0,
      0,
      1,
      0,
      0x12,
      0x01,
      3,
      0,
      1,
      0,
      0,
      0,
      6,
      0,
      0,
      0,
    ]),
    u8("RIFF", [0, 0, 0, 0], "WEBPVP8X", [10, 0, 0, 0], [0, 0, 0, 0], le24(9), le24(9)),
    u8(`<svg width="5" height="5">`),
  ]
  for (const s of samples) for (let n = 0; n <= s.length; n++) sniffSize(s.subarray(0, n))
})
