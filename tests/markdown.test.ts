import { describe, expect, test } from "bun:test"
import { HEADING_STYLES, type HeadingStyle } from "../src/heading-style"
import { parseFrontMatter, parseProperties, render, renderSource, stats, stripCode, wordStats, wrap, width } from "../src/markdown"
import { rankNotes, scanTree, visibleRows, folderCounts } from "../src/files"
import { contrast, themes } from "../src/theme"
import { join } from "node:path"

const t = themes[0]!
const text = (r: ReturnType<typeof render>) => r.lines.map((l) => l.spans.map((s) => s.text).join(""))

describe("heading styles", () => {
  const src = "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n"
  const rowsOf = (style: HeadingStyle, s = src, w = 40) => text(render(s, w, t, { headings: style })).map((l) => l.trimEnd())
  const expected: Record<HeadingStyle, string[]> = {
    classic: ["One", "━━━" + "─".repeat(37), "", "## Two", "", "### Three", "", "#### Four", "", "##### Five", "", "###### Six"],
    bars: ["█ One", "", "▌ Two", "", "┃ Three", "", "│ Four", "", "┆ Five", "", "┊ Six"],
    ladder: ["██ One", "", "▓▓▓ Two", "", "▒▒▒▒ Three", "", "░░░░░ Four", "", "░░░░░░ Five", "", "░░░░░░░ Six"],
    rules: ["━━ One " + "━".repeat(33), "", "── Two " + "─".repeat(33), "", "╌╌ Three", "", "Four", "", "Five", "", "Six"],
  }
  for (const style of HEADING_STYLES) {
    describe(style, () => {
      test("row text for H1..H6", () => expect(rowsOf(style)).toEqual(expected[style]))
      test("the heading line points at the title row", () => {
        const r = render(src, 40, t, { headings: style })
        expect(r.headings.map((h) => h.depth)).toEqual([1, 2, 3, 4, 5, 6])
        const names = ["One", "Two", "Three", "Four", "Five", "Six"]
        r.headings.forEach((h, i) => {
          expect(text(r)[h.line]).toContain(names[i]!)
          expect(r.lines[h.line]!.heading).toBe(i)
        })
      })
      test("wrapped long headings stay within the width and keep their prefix on every row", () => {
        const long = "word ".repeat(30).trim()
        for (const d of [1, 2, 3, 4, 6]) {
          const rows = text(render(`${"#".repeat(d)} ${long}\n`, 30, t, { headings: style }))
          expect(rows.filter((r) => r.includes("word")).length).toBeGreaterThan(1)
          for (const r of rows) expect(width(r)).toBeLessThanOrEqual(30)
        }
      })
      test("headings in a blockquote keep the │ prefix", () => {
        const rows = rowsOf(style, "> ## Quoted heading that is long enough to wrap onto more rows than one\n> ### Deep\n", 30).filter((r) => r.trim())
        expect(rows.length).toBeGreaterThan(2)
        for (const r of rows) expect(r.startsWith("▎")).toBe(true)
        for (const r of rows) expect(width(r)).toBeLessThanOrEqual(30)
      })
    })
  }
  test("rules: only the last row of a wrapped H1/H2 is filled", () => {
    const rows = rowsOf("rules", "# aaa bbb ccc ddd eee fff ggg hhh\n", 20).filter((r) => r)
    expect(rows.length).toBeGreaterThan(1)
    rows.slice(0, -1).forEach((r) => expect(r).not.toContain("━━━"))
    expect(rows[rows.length - 1]).toMatch(/━+$/)
    expect(rows[0]!.startsWith("━━ ")).toBe(true)
    expect(rows[1]!.startsWith("   ")).toBe(true)
  })
  test("bars and ladder indent continuation rows by the prefix", () => {
    expect(rowsOf("bars", "## aaa bbb ccc ddd eee fff ggg hhh\n", 16)[1]).toStartWith("  ")
    expect(rowsOf("ladder", "## aaa bbb ccc ddd eee fff ggg hhh\n", 16)[1]).toStartWith("    ")
  })
  test("colors follow the level in every style", () => {
    const r = render("## Two\n", 40, t, { headings: "bars" })
    const row = r.lines[0]!.spans
    expect(row[0]!.fg).toBe(t.secondary)
    expect(row.find((s) => s.text.includes("Two"))!.fg).toBe(t.secondary)
    const q = render("## Two\n", 40, t, { headings: "rules" }).lines[0]!.spans
    expect(q[0]!.fg).toBe(t.border)
    expect(q.find((s) => s.text.includes("Two"))!.fg).toBe(t.secondary)
  })
  test("the default is classic", () => expect(text(render(src, 40, t))).toEqual(text(render(src, 40, t, { headings: "classic" }))))
})

describe("wrap", () => {
  test("never exceeds the width", () => {
    const rows = wrap([{ text: "lorem ipsum dolor sit amet ".repeat(20) }], 30)
    for (const r of rows) expect(width(r.map((s) => s.text).join(""))).toBeLessThanOrEqual(30)
  })
  test("hard-splits long words", () => {
    const rows = wrap([{ text: "x".repeat(25) }], 10)
    expect(rows.length).toBe(3)
  })
  test("keeps prefixes on continuation rows", () => {
    const rows = wrap([{ text: "one two three four" }], 10, [{ text: "• " }], [{ text: "  " }])
    const lines = rows.map((r) => r.map((s) => s.text).join(""))
    expect(lines[0]).toStartWith("• one")
    expect(lines[1]).toStartWith("  ")
  })
})

describe("render", () => {
  test("headings are indexed with their line", () => {
    const r = render("# Title\n\nText\n\n## Sub\n\nMore", 60, t)
    expect(r.headings.map((h) => h.text)).toEqual(["Title", "Sub"])
    expect(text(r)[r.headings[1]!.line]).toContain("Sub")
  })
  test("tables are drawn with box borders and fit the width", () => {
    const r = render("| a | b |\n|---|---|\n| long cell value here | x |", 30, t)
    const lines = text(r)
    expect(lines[0]!.startsWith("┌")).toBe(true)
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(30)
  })
  test("code blocks fill their background and show the language", () => {
    const r = render("```ts\nconst a = 1\n```", 40, t)
    expect(r.lines[0]!.fill).toBe(t.backgroundElement)
    expect(text(r)[0]).toContain("ts")
  })
  test("task lists render checkboxes", () => {
    const lines = text(render("- [x] done\n- [ ] todo", 40, t))
    expect(lines[0]).toStartWith("[x] done")
    expect(lines[1]).toStartWith("[ ] todo")
  })
  test("nothing overflows on narrow widths", () => {
    const src = require("node:fs").readFileSync(join(import.meta.dir, "../examples/README.md"), "utf8")
    for (const w of [20, 37, 80]) for (const l of text(render(parseFrontMatter(src).body, w, t))) expect(width(l)).toBeLessThanOrEqual(w)
  })
})

describe("source + stats", () => {
  test("front matter is parsed and offset counted", () => {
    const fm = parseFrontMatter("---\ntitle: Hi\ntags: a\n---\n# Body")
    expect(fm.entries).toEqual([["title", "Hi"], ["tags", "a"]])
    expect(fm.body).toBe("# Body")
    expect(fm.offset).toBe(4)
  })
  test("source view keeps indentation and numbers lines", () => {
    const r = renderSource("- a\n  - b\n", 40, t)
    expect(r.plain[1]).toBe("2    - b")
  })
  test("stats count words, tasks and code", () => {
    const s = stats("# Hi there\n\n- [x] one\n- [ ] two\n\n```\ncode words ignored\n```\n")
    expect(s.tasks).toEqual([1, 2])
    expect(s.codeBlocks).toBe(1)
    expect(s.words).toBe(4)
  })
})

describe("files", () => {
  test("scans markdown recursively, README first", () => {
    const tree = scanTree(join(import.meta.dir, "../examples"))
    const rows = visibleRows(tree, new Set(folderCounts(tree).keys()))
    expect(rows.some((r) => r.node.name === "keybindings.md")).toBe(true)
    const rootFiles = tree.children.filter((c) => !c.dir).map((c) => c.name)
    expect(rootFiles[0]).toBe("README.md")
  })
  test("filter ranks matching notes", () => {
    const tree = scanTree(join(import.meta.dir, "../examples"))
    expect(rankNotes(tree, "kbd").rows.map((r) => r.node.name)).toEqual(["keybindings.md"])
  })
})

describe("parseProperties", () => {
  test("scalars keep their order; quotes are stripped", () => {
    expect(parseProperties("---\ntitle: \"Calm: a study\"\ndate: 2024-01-02\nnote: 'x'\n---\nbody")).toEqual([
      ["title", "Calm: a study"],
      ["date", "2024-01-02"],
      ["note", "x"],
    ])
  })
  test("flow, comma and block lists; commas in other scalars stay", () => {
    const src = "---\ntags: [a, \"b c\", ]\naliases: x, y\ncats:\n  - one\n  - 'two'\nafter: z\ntitle: Hello, world\n---\n"
    expect(parseProperties(src)).toEqual([
      ["tags", ["a", "b c"]],
      ["aliases", ["x", "y"]],
      ["cats", ["one", "two"]],
      ["after", "z"],
      ["title", "Hello, world"],
    ])
  })
  test("an empty block is an empty value; no front matter means no properties", () => {
    expect(parseProperties("---\ntags:\nnext: 1\n---\n")).toEqual([["tags", ""], ["next", "1"]])
    expect(parseProperties("# just text")).toEqual([])
  })
})

test("stats counts wikilinks with links, but not inside code", () => {
  expect(stats("[a](b) and [[Note]] and ![[pic.png]]\n\n`[[no]]`\n\n```\n[[nope]]\n```\n").links).toBe(3)
})

describe("stripCode", () => {
  test("hides a backtick fence", () => {
    expect(stripCode("a [[x]]\n```\n[[hidden]]\n```\nb [[y]]")).toBe("a [[x]]\nb [[y]]")
  })
  test("hides a tilde fence", () => {
    expect(stripCode("~~~js\n[[hidden]]\n~~~\n[[shown]]")).toBe("[[shown]]")
  })
  test("hides inline code spans", () => {
    expect(stripCode("see `[[hidden]]` and [[shown]]")).toBe("see  and [[shown]]")
  })
})

describe("document text stays readable in every theme", () => {
  const doc = "---\ntitle: T\ntags: [a]\n---\n\n# Heading\n\n## Sub heading\n\nSetext\n======\n\n> quote\n> next\n\n- item\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[link](https://x.y) and `code`\n\n---\n"
  const BOX = /^[\s─━│┌┐└┘├┤┬┴┼═▎]*$/
  for (const [label, draw] of [["preview", render], ["source", renderSource]] as const) {
    test(`${label}: every non-rule glyph reaches 3:1 on its own background`, () => {
      for (const th of themes)
        for (const l of draw(doc, 80, th).lines)
          for (const sp of l.spans) {
            if (BOX.test(sp.text)) continue
            expect(contrast(sp.fg ?? th.text, sp.bg ?? th.background), `${th.name} ${label} "${sp.text}"`).toBeGreaterThanOrEqual(3)
          }
    })
  }
})

test("wordStats: the same words and minutes as stats, without lexing", () => {
  const src = "# Title\n\nSome words here, don't count `code` twice.\n\n```js\nconst skipped = 1\n```\n\n- [x] done task\n\n%%hidden comment%%\n" + "more words ".repeat(300)
  const st = stats(src)
  expect(wordStats(src)).toEqual({ words: st.words, minutes: st.minutes })
  expect(st.minutes).toBe(3)
})
