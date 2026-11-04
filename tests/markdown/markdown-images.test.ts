import { expect, test } from "bun:test"
import { PIC_MAX_ROWS, picBox, render } from "../../src/markdown/render"
import { brothy as t } from "../helpers/theme"

const cell = { w: 10, h: 20 }
const sizes: Record<string, { w: number; h: number } | { problem: string }> = {
  "a.png": { w: 400, h: 200 },
  "big.png": { w: 4000, h: 2000 },
  "tall.png": { w: 100, h: 4000 },
  "gone.png": { problem: "not found" },
}
const info = (s: string) => sizes[s] ?? null
const pix = { picture: { mode: "pixels" as const, cell, info } }
const txt = { picture: { mode: "text" as const, cell, info } }

test("picBox: never upscaled, measure caps width, rows from the cell aspect, capped at 30", () => {
  expect(picBox({ w: 400, h: 200 }, null, 80, cell)).toEqual({ cols: 40, rows: 10 })
  expect(picBox({ w: 4000, h: 2000 }, null, 80, cell)).toEqual({ cols: 80, rows: 20 })
  expect(picBox({ w: 400, h: 200 }, { w: 200 }, 80, cell)).toEqual({ cols: 20, rows: 5 })
  expect(picBox({ w: 400, h: 200 }, { w: 200, h: 400 }, 80, cell)).toEqual({ cols: 20, rows: 20 })
  const tall = picBox({ w: 100, h: 4000 }, null, 80, cell)
  expect(tall.rows).toBe(PIC_MAX_ROWS)
  expect(tall.cols).toBe(2) // shrunk to keep the aspect: 30 rows · 20 px = 600 px high → 15 px wide → 2 cells
})

test("a block image reserves rows plus a caption; headings after it keep exact lines", () => {
  const r = render("![Plan](a.png)\n\n# After", 80, t, pix)
  const p = r.pics![0]!
  expect(p).toMatchObject({ id: 0, line: 0, rows: 10, cols: 40, left: 20, src: "a.png", alt: "Plan" })
  for (let i = 0; i < 10; i++) expect(r.lines[i]!.pic).toBe(0)
  expect(r.plain[10]!.trim()).toBe("plan")
  const h = r.headings[0]!
  expect(r.lines[h.line]!.heading).toBe(0)
  expect(r.plain[h.line]).toContain("after")
  expect(h.last).toBe(h.line)
})

test("image first and last: reserved rows survive the blank-row trims", () => {
  const r = render("![](a.png)\n\ntext\n\n![](a.png)", 80, t, pix)
  expect(r.pics!.map((p) => p.line)).toEqual([0, r.pics![1]!.line])
  expect(r.lines.slice(r.pics![1]!.line, r.pics![1]!.line + 10).every((l) => l.pic === 1)).toBe(true)
  expect(r.pics![1]!.line + 10).toBe(r.lines.length) // an empty alt has no caption row
  expect(r.pics![0]!.alt).toBe("a")
})

test("an empty-alt picture keeps exactly its rows before more text, in a quote and in a callout", () => {
  for (const src of ["![](a.png)\n\nafter", "> ![](a.png)\n\nafter", "> [!note] T\n> ![](a.png)\n\nafter"]) {
    const r = render(src, 80, t, pix)
    const p = r.pics![0]!
    expect(r.lines.filter((l) => l.pic === 0)).toHaveLength(10)
    expect(r.lines.slice(p.line, p.line + 10).every((l) => l.pic === 0)).toBe(true)
    expect(r.plain.at(-1)).toBe("after")
  }
  const q = render("> ![](a.png)", 80, t, pix)
  expect(q.lines.filter((l) => l.pic === 0)).toHaveLength(10)
  const lead = render("\n\n> [!note] T\n> ![](a.png)", 80, t, pix)
  expect(lead.lines[lead.pics![0]!.line]!.pic).toBe(0)
})

test("a picture before a heading in a quote keeps the rows and the heading lines", () => {
  const r = render("> ![](a.png)\n> # H", 80, t, pix)
  expect(r.lines.filter((l) => l.pic === 0)).toHaveLength(10)
  const h = r.headings[0]!
  expect(r.lines[h.line]!.heading).toBe(0)
  expect(h.line).toBeGreaterThanOrEqual(r.pics![0]!.line + 10)
})

test("wikilink embeds: ![[a.png|200]] sizes; ![[Note|alias]] stays a link", () => {
  const r = render("![[a.png|200]]\n\n![[Note|alias]]", 80, t, pix)
  expect(r.pics).toHaveLength(1)
  expect(r.pics![0]).toMatchObject({ cols: 20, rows: 5, alt: "a" })
  expect(r.plain.some((p) => p.includes("alias"))).toBe(true)
})

test("text mode: one placeholder row with the size and ⏎ view", () => {
  const r = render("![Plan](a.png)", 80, t, txt)
  expect(r.pics![0]).toMatchObject({ rows: 0, line: 0 })
  expect(r.plain[0]).toBe("▣ plan · 400×200 · ⏎ view")
})

test("a problem is a placeholder with its reason, in pixels mode too", () => {
  const r = render("![Plan](gone.png)", 80, t, pix)
  expect(r.pics![0]).toMatchObject({ rows: 0, problem: "not found" })
  expect(r.plain[0]).toBe("▣ plan · not found")
  const reason = r.lines[0]!.spans.find((s) => s.text.includes("not found"))!
  expect(reason.fg).toBe(t.warning)
})

test("inline images and no picture opts render as today", () => {
  expect(render("see ![x](a.png) here", 80, t, pix).pics).toEqual([])
  expect(render("![x](a.png)", 80, t).pics).toEqual([])
  expect(render("![x](a.png)", 80, t).plain[0]).toBe("▣ x")
})

test("a picture alone in a tight list item is a picture; items after it keep their lines", () => {
  const r = render("- ![cap](a.png)\n- two\n\n# After", 80, t, pix)
  const p = r.pics![0]!
  expect(p).toMatchObject({ line: 0, rows: 10, cols: 40, src: "a.png", alt: "cap" })
  expect(p.left).toBeGreaterThan(2) // past the bullet's indent
  for (let i = 0; i < 10; i++) expect(r.lines[i]!.pic).toBe(0)
  expect(r.plain[10]!.trim()).toBe("cap")
  expect(r.plain[11]).toContain("two")
  const h = r.headings[0]!
  expect(r.lines[h.line]!.heading).toBe(0)
  expect(r.plain[h.line]).toContain("after")
  const t2 = render("- ![cap](a.png)\n- two", 80, t, txt)
  expect(t2.pics![0]).toMatchObject({ rows: 0, line: 0 })
  expect(t2.plain[0]).toContain("▣ cap · 400×200 · ⏎ view")
  expect(t2.plain[1]).toContain("two")
})

test("a list item with text around the image stays inline", () => {
  expect(render("- see ![cap](a.png)\n- two", 80, t, pix).pics).toEqual([])
})

test("a multi-line alt is one row: no newline in the caption, placeholder or Pic.alt", () => {
  for (const o of [pix, txt]) {
    const r = render("![two\nlines](a.png)", 80, t, o)
    expect(r.pics![0]!.alt).not.toMatch(/[\n\t]/)
    expect(r.plain.some((l) => l.includes("\n"))).toBe(false)
  }
})
