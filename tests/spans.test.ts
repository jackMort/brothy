import { describe, expect, test } from "bun:test"
import { render, renderSource, width } from "../src/markdown"
import { safe, safeLine } from "../src/spans"
import { themes } from "../src/theme"

const t = themes[0]!
const FAMILY = "👨‍👩‍👧"

describe("safe", () => {
  test("control characters become U+FFFD", () => {
    expect(safe("a\u001b[31mb\u0007c\u007fd\u009be")).toBe("a�[31mb�c�d�e")
    expect(safe("tab\there\nnl")).toBe("tab\there\nnl")
  })

  test("bidi overrides, embeddings and isolates are mapped", () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])
      expect(safe(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe("a�b")
  })

  test("zero-width characters are mapped, also a BOM in the middle", () => {
    for (const cp of [0x200b, 0x200e, 0x200f, 0xfeff]) expect(safe(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe("a�b")
  })

  test("ZWJ survives inside emoji sequences only", () => {
    expect(safe(FAMILY)).toBe(FAMILY)
    expect(safe("👩🏽‍💻")).toBe("👩🏽‍💻")
    expect(safe("🏳️‍🌈")).toBe("🏳️‍🌈")
    expect(safe("a‍b")).toBe("a�b")
    expect(safe("👩‍")).toBe("👩�")
    expect(safe("‍👩")).toBe("�👩")
    expect(width(safe(FAMILY))).toBe(width(FAMILY))
  })

  test("ZWNJ survives between letters or marks only", () => {
    expect(safe("می\u200cخواهم")).toBe("می\u200cخواهم")
    expect(safe("क\u094d\u200cष")).toBe("क\u094d\u200cष")
    expect(safe("a\u200c b")).toBe("a� b")
    expect(safe("\u200cab")).toBe("�ab")
    expect(safe("ab\u200c")).toBe("ab�")
    expect(safe("1\u200c2")).toBe("1�2")
  })

  test("safeLine also flattens tab and newline", () => {
    expect(safeLine("a\tb\nc‮d")).toBe("a b c�d")
  })

  test("ordinary text is untouched", () => {
    const s = "Zażółć gęślą jaźń — 日本語 العربية 😀 ✓"
    expect(safe(s)).toBe(s)
  })
})

describe("through the renderers", () => {
  const text = (r: ReturnType<typeof render>) => r.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n")
  test("a bidi override in Markdown never reaches the output", () => {
    for (const draw of [render, renderSource]) {
      const out = text(draw("# Title‮\n\npay⁦ment​ due\n", 60, t))
      expect(out).not.toMatch(/[​-‏‪-‮⁦-⁩]/)
      expect(out).toContain("�")
    }
  })
  test("emoji family keeps its joiners in Preview", () => {
    expect(text(render(`${FAMILY} ok`, 60, t))).toContain(FAMILY)
  })
  test("a leading BOM is still stripped, not shown", () => {
    for (const draw of [render, renderSource]) {
      const r = draw("﻿# Title\n", 60, t)
      expect(r.headings.map((h) => h.text)).toEqual(["Title"])
      expect(text(r)).not.toContain("�")
    }
  })
})
