import { expect, test } from "bun:test"
import { readCapped } from "../src/stdin"

/** A stream of `chunks`, counting how many were pulled. */
function source(chunks: (string | Uint8Array)[]) {
  const enc = new TextEncoder()
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled === chunks.length) return c.close()
      const x = chunks[pulled++]!
      c.enqueue(typeof x === "string" ? enc.encode(x) : x)
    },
  })
  return { stream, pulled: () => pulled }
}

test("readCapped: the whole text under the cap, multi-byte characters split across chunks included", async () => {
  const é = new TextEncoder().encode("é")
  expect(await readCapped(source(["# Title\n", é.slice(0, 1), é.slice(1), "t\n"]).stream, 100)).toBe("# Title\nét\n")
  expect(await readCapped(source(["12345"]).stream, 5)).toBe("12345") // exactly at the cap is fine
})

test("readCapped: null once past the cap, without reading on", async () => {
  const s = source(["1234", "5678", "never", "read"])
  expect(await readCapped(s.stream, 5)).toBeNull()
  expect(s.pulled()).toBeLessThanOrEqual(3)
})
