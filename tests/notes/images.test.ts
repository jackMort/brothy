import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { scanTree } from "../../src/notes/files"
import { imageInfo, isImagePath, parseImageSize, resolveImage, sniffSize } from "../../src/notes/images"
import { useTmp } from "../helpers/tmp"

const tmpDir = useTmp("brothy-img-")

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

test("isImagePath and parseImageSize", () => {
  expect(isImagePath("a/b.PNG")).toBe(true)
  expect(isImagePath("note.md")).toBe(false)
  expect(parseImageSize("300")).toEqual({ w: 300 })
  expect(parseImageSize("300x200")).toEqual({ w: 300, h: 200 })
  expect(parseImageSize("alias")).toBeNull()
  expect(parseImageSize(undefined)).toBeNull()
})

test("resolveImage: next to the note, then the vault root, then by name, shortest path first", () => {
  const root = tmpDir()
  mkdirSync(join(root, ".obsidian"))
  mkdirSync(join(root, "notes/deep/er"), { recursive: true })
  mkdirSync(join(root, "assets"))
  for (const f of ["notes/near.png", "assets/top.png", "notes/deep/er/Pic.png", "notes/deep/pic.png"])
    writeFileSync(join(root, f), "x")
  writeFileSync(join(root, "notes/n.md"), "# n")
  const tree = scanTree(root)
  const note = join(root, "notes/n.md")
  const roots = { vault: root, root }
  expect(resolveImage("near.png", note, roots, tree)).toBe(join(root, "notes/near.png"))
  expect(resolveImage("assets/top.png", note, roots, tree)).toBe(join(root, "assets/top.png"))
  expect(resolveImage("PIC.png", note, roots, tree)).toBe(join(root, "notes/deep/pic.png"))
  expect(resolveImage("gone.png", note, roots, tree)).toEqual({ problem: "not found" })
  expect(resolveImage("https://x.io/a.png", note, roots, tree)).toEqual({ problem: "remote image" })
  expect(resolveImage("data:image/png;base64,AAAA", note, roots, tree)).toEqual({ problem: "remote image" })
})

test("resolveImage: never outside the root, through .. or a symlink", () => {
  const outer = tmpDir()
  const root = join(outer, "vault")
  mkdirSync(root)
  writeFileSync(join(outer, "secret.png"), "x")
  writeFileSync(join(root, "n.md"), "# n")
  symlinkSync(join(outer, "secret.png"), join(root, "link.png"))
  symlinkSync(outer, join(root, "dir"))
  const tree = scanTree(root)
  const note = join(root, "n.md")
  const outside = { problem: "outside the folder" as const }
  expect(resolveImage("../secret.png", note, { vault: null, root }, tree)).toEqual(outside)
  expect(resolveImage("link.png", note, { vault: null, root }, tree)).toEqual(outside)
  expect(resolveImage("dir/secret.png", note, { vault: null, root }, tree)).toEqual(outside)
  expect(resolveImage(join(outer, "secret.png"), note, { vault: null, root }, tree)).toEqual(outside)
})

test("resolveImage: a lookup by name skips dot folders and node_modules, and never returns a link out of the root", () => {
  const outer = tmpDir()
  const root = join(outer, "vault")
  for (const d of [".hidden", "node_modules/x", "a"]) mkdirSync(join(root, d), { recursive: true })
  mkdirSync(join(outer, "away"))
  for (const f of [".hidden/h.png", "node_modules/x/m.png"]) writeFileSync(join(root, f), "x")
  writeFileSync(join(outer, "away/e.png"), "x")
  symlinkSync(join(outer, "away/e.png"), join(root, "a/e.png"))
  symlinkSync(join(outer, "away"), join(root, "a/away"))
  writeFileSync(join(root, "n.md"), "# n")
  const tree = scanTree(root)
  for (const name of ["h.png", "m.png", "e.png"])
    expect(resolveImage(name, join(root, "n.md"), { vault: null, root }, tree)).toEqual({ problem: "not found" })
})

test("resolveImage: a lookup by name follows a link that stays inside the root", () => {
  const root = tmpDir()
  mkdirSync(join(root, "a"))
  writeFileSync(join(root, "real.png"), "x")
  symlinkSync(join(root, "real.png"), join(root, "a/alias.png"))
  writeFileSync(join(root, "n.md"), "# n")
  const tree = scanTree(root)
  expect(resolveImage("alias.png", join(root, "n.md"), { vault: null, root }, tree)).toBe(join(root, "a/alias.png"))
})

test("imageInfo: size, too large by pixels, unsupported, unreadable; cached until mtime changes", () => {
  const root = tmpDir()
  const p = join(root, "a.png")
  const png = (w: number, h: number) =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from("IHDR"),
      Buffer.from([
        w >>> 24,
        (w >>> 16) & 255,
        (w >>> 8) & 255,
        w & 255,
        h >>> 24,
        (h >>> 16) & 255,
        (h >>> 8) & 255,
        h & 255,
      ]),
    ])
  writeFileSync(p, png(1200, 800))
  expect(imageInfo(p)).toEqual({ w: 1200, h: 800, format: "png" })
  writeFileSync(p, png(10000, 5000))
  expect(imageInfo(p)).toEqual({ problem: "too large" })
  // same size and mtime: the cached answer stands
  const at = new Date(Date.now() - 60_000)
  writeFileSync(p, png(100, 50))
  utimesSync(p, at, at)
  expect(imageInfo(p)).toEqual({ w: 100, h: 50, format: "png" })
  writeFileSync(p, png(200, 50))
  utimesSync(p, at, at)
  expect(imageInfo(p)).toEqual({ w: 100, h: 50, format: "png" })
  writeFileSync(join(root, "b.png"), "not an image")
  expect(imageInfo(join(root, "b.png"))).toEqual({ problem: "unsupported" })
  expect(imageInfo(join(root, "missing.png"))).toEqual({ problem: "not found" })
  mkdirSync(join(root, "d.png"))
  expect(imageInfo(join(root, "d.png"))).toEqual({ problem: "not found" })
})

test("imageInfo: a raster the decoder refuses is too large (25 MP, 16384 a side); an SVG keeps 40 MP", () => {
  const root = tmpDir()
  const png = (w: number, h: number) =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from("IHDR"),
      Buffer.from([
        w >>> 24,
        (w >>> 16) & 255,
        (w >>> 8) & 255,
        w & 255,
        h >>> 24,
        (h >>> 16) & 255,
        (h >>> 8) & 255,
        h & 255,
      ]),
    ])
  const jpeg = (w: number, h: number) =>
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])
  const info = (name: string, bytes: Buffer) => {
    writeFileSync(join(root, name), bytes)
    return imageInfo(join(root, name))
  }
  // measured against NativeImage.decode: 5000x5000 decodes, 6000x4167 does not; 16384 a side decodes, 16385 does not
  expect(info("a.png", png(5000, 5000))).toEqual({ w: 5000, h: 5000, format: "png" })
  expect(info("b.png", png(6000, 4167))).toEqual({ problem: "too large" })
  expect(info("c.jpg", jpeg(7008, 4672))).toEqual({ problem: "too large" })
  expect(info("d.jpg", jpeg(6000, 4000))).toEqual({ w: 6000, h: 4000, format: "jpeg" })
  expect(info("e.png", png(16384, 1))).toEqual({ w: 16384, h: 1, format: "png" })
  expect(info("f.png", png(16385, 1))).toEqual({ problem: "too large" })
  expect(info("g.png", png(20000, 100))).toEqual({ problem: "too large" })
  const svg = (w: number, h: number) => Buffer.from(`<svg width="${w}" height="${h}"/>`)
  expect(info("h.svg", svg(20000, 1500))).toEqual({ w: 20000, h: 1500, format: "svg" })
  expect(info("i.svg", svg(8000, 5001))).toEqual({ problem: "too large" })
})

test("imageInfo: a file that cannot be read is unreadable", () => {
  if (process.getuid?.() === 0) return
  const p = join(tmpDir(), "locked.png")
  writeFileSync(p, "x")
  chmodSync(p, 0o000)
  expect(imageInfo(p)).toEqual({ problem: "unreadable" })
})
