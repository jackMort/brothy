import { describe, expect, test } from "bun:test"
import type { Span } from "../../src/lib/spans"
import {
  clamp,
  fmtNum,
  graphemes,
  mergeSpans,
  plural,
  pushSpan,
  sameStyle,
  spanWidth,
  superscript,
  truncate,
  truncateLeft,
  width,
} from "../../src/lib/text"
import { expectLinear, SCALE } from "../helpers/perf"

describe("width", () => {
  test("counts display columns: wide, zero-width and clustered characters", () => {
    expect(width("abc")).toBe(3)
    expect(width("日本")).toBe(4)
    expect(width("é")).toBe(1)
    expect(width("👨‍👩‍👧")).toBe(2)
  })

  test("graphemes keeps clusters whole", () => {
    expect(graphemes("aé👨‍👩‍👧")).toEqual(["a", "é", "👨‍👩‍👧"])
    expect(graphemes("")).toEqual([])
  })

  test("spanWidth sums the spans", () => {
    expect(spanWidth([{ text: "ab" }, { text: "日" }, { text: "" }])).toBe(4)
    expect(spanWidth([])).toBe(0)
  })
})

describe("span merging", () => {
  test("same style ignores a missing attr but never joins two links", () => {
    expect(sameStyle({ text: "a", fg: "#fff" }, { text: "b", fg: "#fff", attr: 0 })).toBe(true)
    expect(sameStyle({ text: "a", fg: "#fff" }, { text: "b", fg: "#000" })).toBe(false)
    expect(sameStyle({ text: "a", link: 0 }, { text: "b", link: 1 })).toBe(false)
  })

  test("pushSpan merges into the last span, drops empty text and copies what it adds", () => {
    const out: Span[] = []
    const first = { text: "a", fg: "#fff" }
    pushSpan(out, first)
    pushSpan(out, { text: "", fg: "#000" })
    pushSpan(out, { text: "b", fg: "#fff" })
    pushSpan(out, { text: "c", fg: "#000" })
    expect(out).toEqual([
      { text: "ab", fg: "#fff" },
      { text: "c", fg: "#000" },
    ])
    expect(first.text).toBe("a")
  })

  test("mergeSpans leaves its input alone", () => {
    const spans: Span[] = [{ text: "a" }, { text: "b" }, { text: "c", attr: 1 }]
    expect(mergeSpans(spans)).toEqual([{ text: "ab" }, { text: "c", attr: 1 }])
    expect(spans).toHaveLength(3)
  })
})

/** The rule truncate kept from status.ts: grow by code points while the measured text fits. */
function cutRight(s: string, max: number): string {
  if (max <= 0) return ""
  if (width(s) <= max) return s
  let out = ""
  for (const ch of s) {
    if (width(out + ch) > max - 1) break
    out += ch
  }
  return out + "…"
}

function cutLeft(s: string, max: number): string {
  if (max <= 0) return ""
  if (width(s) <= max) return s
  const chars = [...s]
  let out = ""
  for (let i = chars.length - 1; i >= 0; i--) {
    if (width(chars[i] + out) > max - 1) break
    out = chars[i] + out
  }
  return "…" + out
}

describe("truncate", () => {
  test("cuts a cluster where the per-code-point rule did", () => {
    // 👍 alone is 2 columns, 👍 + U+FE0E is 1: the cut falls before it although the whole would fit
    expect(truncate("ab👍︎cd", 4)).toBe("ab…")
    expect(truncateLeft("ab👍︎cd", 4)).toBe("…︎cd")
    expect(truncate("x👨‍👩‍👧yz", 3)).toBe("x…")
    expect(truncate("café au lait", 5)).toBe("café…")
    expect(truncateLeft("🇺🇸🇩🇪🇫🇷", 4)).toBe("…🇪🇫🇷")
  })

  test("text with escape sequences is measured whole", () => {
    expect(truncate("\x1b[1mbold\x1b[0m text", 5)).toBe("\x1b[1mbold\x1b[0m…")
    expect(truncateLeft("\x1b[1mbold\x1b[0m text", 5)).toBe("…text")
  })

  test("matches the per-code-point rule on mixed text", () => {
    const pool = [
      "a",
      " ",
      "日",
      "👨",
      "👩",
      "‍",
      "́",
      "🇺",
      "🇸",
      "❤",
      "️",
      "︎",
      "👍",
      "🏽",
      "ᄀ",
      "ᅡ",
      "ශ",
      "්",
      "ර",
      "क",
      "्",
      "‌",
      "\x1b",
      "[",
      "m",
      "\x9b",
      " ",
      "1",
      "⃣",
    ]
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let i = 0; i < 20000; i++) {
      let s = ""
      for (let n = rnd(16); n > 0; n--) s += pool[rnd(pool.length)]
      const max = rnd(12) - 1
      expect(truncate(s, max)).toBe(cutRight(s, max))
      expect(truncateLeft(s, max)).toBe(cutLeft(s, max))
    }
  })

  test("long text is cut in linear time", () => {
    const N = 80_000
    const text = (big: boolean) => "word é 日本 👍 ".repeat((big ? N : N / SCALE) / 10)
    const small = text(false)
    const big = text(true)
    expectLinear("truncate", (b) => truncate(b ? big : small, (b ? N : N / SCALE) / 2))
    expectLinear("truncateLeft", (b) => truncateLeft(b ? big : small, (b ? N : N / SCALE) / 2))
  })
})

describe("numbers", () => {
  test("fmtNum and plural", () => {
    expect(fmtNum(1234567)).toBe("1,234,567")
    expect(plural(1, "word")).toBe("1 word")
    expect(plural(2000, "word")).toBe("2,000 words")
    expect(plural(0, "heading")).toBe("0 headings")
  })

  test("clamp holds to the range; lo wins an empty one", () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
    expect(clamp(2, 0, 3)).toBe(2)
    expect(clamp(2, 4, 1)).toBe(4)
  })

  test("superscript digits", () => {
    expect(superscript(1)).toBe("¹")
    expect(superscript(10)).toBe("¹⁰")
  })
})

test("superscript writes digits as superscripts", () => {
  expect(superscript(1)).toBe("¹")
  expect(superscript(3)).toBe("³")
  expect(superscript(12)).toBe("¹²")
})
