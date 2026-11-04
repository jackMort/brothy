// PNGs made in the tests, from own pixels.
import { deflateSync } from "node:zlib"

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
export const makePng = (w: number, h: number, rgba: number[]) => {
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

/** A `w × h` PNG of one colour. */
export const solidPng = (w: number, h: number, [r, g, b, a]: readonly [number, number, number, number]) =>
  makePng(
    w,
    h,
    Array.from({ length: w * h * 4 }, (_, i) => [r, g, b, a][i % 4]!),
  )
