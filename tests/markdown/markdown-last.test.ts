// `Heading.last`: the row a heading's text ends on in Preview, where the AI notes put their marks.
import { describe, expect, test } from "bun:test"
import { HEADING_STYLES } from "../../src/markdown/heading-style"
import { type Rendered, render } from "../../src/markdown/render"
import { renderSource } from "../../src/markdown/source"
import { brothy } from "../helpers/theme"

const t = brothy
const rowText = (r: Rendered, i: number) => (r.lines[i]?.spans ?? []).map((s) => s.text).join("")
const LONG = "# A heading long enough to wrap twice\n\ntext\n\n## Short\n\nbody\n\n### A third one that wraps around\n"

describe("Heading.last", () => {
  test("a classic h1 wrapped over two rows ends before its underline; a one-row h2 ends where it starts", () => {
    const r = render(LONG, 20, t)
    const [h1, h2] = r.headings
    expect(h1!.last).toBe(h1!.line + 1)
    expect(rowText(r, h1!.last!)).toBe("enough to wrap twice")
    expect(rowText(r, h1!.last! + 1)).toMatch(/^━+$/)
    expect(h2!.last).toBe(h2!.line)
  })

  test("bars and ladder: the last wrapped row under the mark", () => {
    for (const style of ["bars", "ladder"] as const) {
      const r = render(LONG, 20, t, { headings: style })
      const h1 = r.headings[0]!
      expect(h1.last).toBeGreaterThan(h1.line)
      expect(rowText(r, h1.last!)).toMatch(/^ +(\S+ )*twice$/)
      expect(rowText(r, h1.last! + 1)).toBe("")
    }
  })

  test("rules: the fill row of an h1 and h2, the wrapped row of an h3", () => {
    const r = render(LONG, 20, t, { headings: "rules" })
    const [h1, h2, h3] = r.headings
    expect(rowText(r, h1!.last!)).toMatch(/twice ━+$/)
    expect(rowText(r, h2!.last!)).toMatch(/^── Short ─+$/)
    expect(h2!.last).toBe(h2!.line)
    expect(h3!.last).toBe(h3!.line + 1)
    expect(rowText(r, h3!.last!).trim()).toBe("wraps around")
  })

  test("every style: last ≥ line, and the row after it is not more of the same heading", () => {
    for (const style of HEADING_STYLES) {
      const r = render(LONG, 20, t, { headings: style })
      for (const h of r.headings) {
        expect(h.last).toBeGreaterThanOrEqual(h.line)
        const words = h.text.split(" ")
        expect(rowText(r, h.last! + 1)).not.toContain(words.at(-1)!)
      }
    }
  })

  test("a heading in a quote keeps its last row under the bar", () => {
    const r = render("> # Quoted heading that wraps here\n\nx", 20, t, { headings: "bars" })
    const h = r.headings[0]!
    expect(h.last).toBe(h.line + 1)
    expect(rowText(r, h.last!)).toBe("▎   that wraps here")
  })

  test("blank rows trimmed from the top move last with line", () => {
    const r = render("&nbsp;\n\n# T", 20, t)
    expect(r.headings[0]).toMatchObject({ line: 0, last: 0 })
  })

  test("Source leaves it undefined, and the outlines still match", () => {
    const src = renderSource(LONG, 20, t)
    expect(src.headings.map((h) => h.last)).toEqual([undefined, undefined, undefined])
    expect(src.headings.map((h) => [h.depth, h.text])).toEqual(
      render(LONG, 20, t).headings.map((h) => [h.depth, h.text]),
    )
  })
})
