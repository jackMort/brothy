import { describe, expect, test } from "bun:test"
import { A } from "../../src/lib/spans"
import { width } from "../../src/lib/text"
import { parseFrontMatter } from "../../src/markdown/frontmatter"
import { scanComments, stripComments } from "../../src/markdown/lexer"
import { CALLOUT_KINDS, render, stripTags } from "../../src/markdown/render"
import {
  needsLexer,
  renderSource,
  sourceScan,
  sourceStructureLexed,
  sourceStructureLines,
} from "../../src/markdown/source"
import { stats } from "../../src/markdown/stats"
import { contrast, themes } from "../../src/theme/theme"
import { brothy } from "../helpers/theme"

const t = brothy
const text = (r: ReturnType<typeof render>) => r.lines.map((l) => l.spans.map((s) => s.text).join(""))
/** [depth, text] outlines of Preview (front matter cut, as App renders it) and Source; they must be equal (outline parity). */
const outlines = (src: string): [[number, string][], [number, string][]] => [
  render(parseFrontMatter(src).body, 60, t).headings.map((h): [number, string] => [h.depth, h.text]),
  renderSource(src, 60, t).headings.map((h): [number, string] => [h.depth, h.text]),
]
const RULE = /^[\s─━│┌┐└┘├┤┬┴┼═]*$/
/** Every non-rule glyph reaches 3:1 on its own background, in both views and every theme. */
const readable = (src: string) => {
  for (const th of themes)
    for (const draw of [render, renderSource])
      for (const l of draw(src, 80, th).lines)
        for (const s of l.spans) {
          if (RULE.test(s.text)) continue
          expect(contrast(s.fg ?? th.text, s.bg ?? th.background), `${th.name} "${s.text}"`).toBeGreaterThanOrEqual(3)
        }
}

describe("==highlight==", () => {
  test("marks are dropped and the text gets the highlight style", () => {
    const r = render("a ==hi **b**== c", 60, t)
    expect(text(r)).toEqual(["a hi b c"])
    const hi = r.lines[0]!.spans.filter((s) => s.bg === t.backgroundElement)
    expect(hi.map((s) => s.text).join("")).toBe("hi b")
    expect(hi.every((s) => s.fg === t.warning)).toBe(true)
    expect(hi.some((s) => ((s.attr ?? 0) & A.BOLD) !== 0)).toBe(true)
  })
  test("not a highlight: spaced ==, code spans, fences", () => {
    expect(text(render("a == b == c", 60, t))).toEqual(["a == b == c"])
    expect(text(render("if a === b === c", 60, t))).toEqual(["if a === b === c"])
    expect(render("`==no==`\n\n```\n==no==\n```", 60, t).plain.join("\n")).toContain("==no==")
    expect(render("`==no==`", 60, t).plain.join("")).toContain("==no==")
  })
  test("headings with a highlight read the same in both outlines", () => {
    const [p, s] = outlines("## A ==b== c\n\ntext\n")
    expect(p).toEqual([[2, "A b c"]])
    expect(s).toEqual(p)
  })
  test("readable in every theme", () => readable("x ==hi== y\n"))
})

describe("%% comments", () => {
  test("stripComments cuts closed pairs", () => {
    expect(stripComments("a %%b%% c")).toBe("a  c")
    expect(stripComments("a\n\n%%\nhidden\n%%\n\nb")).toBe("a\n\n\nb")
  })
  test("inline comment vanishes, text around it stays", () => {
    const plain = render("keep %%secret%% this", 60, t).plain.join("\n")
    expect(plain).not.toContain("secret")
    expect(plain).toContain("keep")
    expect(plain).toContain("this")
  })
  test("a block comment leaves no rows behind", () => {
    expect(text(render("a\n\n%%\nhidden\nmore\n%%\n\nb", 60, t))).toEqual(["a", "", "b"])
  })
  test("a heading inside a comment is in neither outline", () => {
    const [p, s] = outlines("# A\n\n%%\n## Hidden\n%%\n\n## B\n")
    expect(p).toEqual([
      [1, "A"],
      [2, "B"],
    ])
    expect(s).toEqual(p)
  })
  test("%% inside code spans and fences stays", () => {
    const plain = render("`%%a%%`\n\n```\n%%b%%\n```", 60, t).plain.join("\n")
    expect(plain).toContain("%%a%%")
    expect(plain).toContain("%%b%%")
  })
  test("unclosed %% stays literal and hides nothing", () => {
    const r = render("50%% off and more\n\n## Next\n", 60, t)
    expect(r.plain.join("\n")).toContain("50%% off and more")
    expect(r.headings.map((h) => h.text)).toEqual(["Next"])
    const odd = render("a %%x%% b %% c", 60, t).plain.join("\n")
    expect(odd).not.toContain("x")
    expect(odd).toContain("b %% c")
  })
  test("Source keeps comment lines, muted italic, and skips their headings", () => {
    const r = renderSource("a\n%%\n# no\n%%\n", 60, t)
    expect(r.plain.join("\n")).toContain("# no")
    expect(r.headings).toEqual([])
    const body = r.lines[2]!.spans.at(-1)!
    expect(body.fg).toBe(t.textMuted)
    expect((body.attr ?? 0) & A.ITALIC).toBeTruthy()
  })
  test("an inline comment in a heading is out of every outline title", () => {
    for (const src of ["# Title %%secret%%\n\ntext\n", "Title %%x%%\n===\n"]) {
      const [p, s] = outlines(src)
      expect(p).toEqual([[1, "Title"]])
      expect(s).toEqual(p)
      expect(sourceScan(src, t).headings.map((h) => h.text)).toEqual(["Title"])
    }
  })
  test("text left after a comment closes is read the same way by both outlines", () => {
    const src = "%%start\nmid\n%% # Heading\n\ntext\n"
    const [p, s] = outlines(src)
    expect(p).toEqual([[1, "Heading"]])
    expect(s).toEqual(p)
  })
  test("%% in front matter never pairs with one in the body", () => {
    const src = "---\ntitle: x %% y\n---\n# First\n\nbody\n\n# Second\n\nmore %% z\n"
    const p = render(parseFrontMatter(src).body, 60, t).headings.map((h) => h.text)
    expect(p).toEqual(["First", "Second"])
    expect(renderSource(src, 60, t).headings.map((h) => h.text)).toEqual(p)
    expect(sourceScan(src, t).headings.map((h) => h.text)).toEqual(p)
    expect(sourceScan(src, t).text[9]).toBe("more %% z")
  })
  test("stats skip comment words but count every line", () => {
    const s = stats("one %%two three%% four\n%%\nx\n%%")
    expect(s.words).toBe(2)
    expect(s.lines).toBe(4)
  })
})

describe("callouts", () => {
  const row = (src: string, w = 60) => render(src, w, t).lines[0]!
  const str = (l: { spans: { text: string }[] }) => l.spans.map((s) => s.text).join("")

  test("header row: bar, icon and title in the kind color", () => {
    const l = row("> [!warning] Mind the gap\n> body")
    expect(str(l)).toBe("▎ ▲ Mind the gap")
    expect(l.spans[0]!.fg).toBe(t.warning)
    expect(l.spans.find((s) => s.text.includes("Mind"))!.fg).toBe(t.warning)
  })
  const cases: [string, string][] = [
    ["note", "note"],
    ["summary", "abstract"],
    ["tldr", "abstract"],
    ["abstract", "abstract"],
    ["info", "info"],
    ["todo", "todo"],
    ["tip", "tip"],
    ["hint", "tip"],
    ["important", "tip"],
    ["success", "success"],
    ["check", "success"],
    ["done", "success"],
    ["question", "question"],
    ["help", "question"],
    ["faq", "question"],
    ["warning", "warning"],
    ["caution", "warning"],
    ["attention", "warning"],
    ["failure", "failure"],
    ["fail", "failure"],
    ["missing", "failure"],
    ["danger", "danger"],
    ["error", "danger"],
    ["bug", "bug"],
    ["example", "example"],
    ["quote", "quote"],
    ["cite", "quote"],
    ["Warning", "warning"],
    ["whatever", "note"],
  ]
  for (const [type, kind] of cases)
    test(`[!${type}] draws as ${kind}`, () => {
      const k = CALLOUT_KINDS[kind]!
      const l = row(`> [!${type}]\n> body`)
      expect(str(l)).toContain(k.icon)
      expect(l.spans[0]!.fg).toBe(t[k.color])
    })
  test("every icon is one column", () => {
    for (const k of Object.values(CALLOUT_KINDS)) expect(width(k.icon)).toBe(1)
  })
  test("empty title falls back to the capitalized type", () => {
    expect(str(row("> [!tip]\n> x"))).toBe("▎ ★ Tip")
    expect(str(row("> [!whatever]\n> x"))).toBe("▎ ✎ Whatever")
  })
  test("fold markers show ▾ and the body stays visible", () => {
    const r = render("> [!note]- Folded\n> body", 60, t)
    expect(text(r)[0]).toBe("▎ ✎ Folded ▾")
    expect(text(r)[1]).toContain("body")
    expect(text(render("> [!note]+ Open\n> b", 60, t))[0]).toBe("▎ ✎ Open ▾")
  })
  test("body text keeps the text color; quote kind stays muted italic", () => {
    const body = render("> [!note] T\n> plain words", 60, t).lines[1]!.spans.find((s) => s.text.includes("plain"))!
    expect(body.fg).toBe(t.text)
    const q = render("> [!quote] T\n> said words", 60, t).lines[1]!.spans.find((s) => s.text.includes("said"))!
    expect(q.fg).toBe(t.textMuted)
    expect((q.attr ?? 0) & A.ITALIC).toBeTruthy()
  })
  test("heading inside a callout body sits on its line, in both outlines", () => {
    const src = "> [!note] T\n> intro\n>\n> ## Inside\n> after\n"
    const r = render(src, 60, t)
    expect(r.headings.map((h) => h.text)).toEqual(["Inside"])
    expect(text(r)[r.headings[0]!.line]).toContain("Inside")
    expect(text(r)[r.headings[0]!.line]!.startsWith("▎")).toBe(true)
    const [p, s] = outlines(src)
    expect(s).toEqual(p)
  })
  test("nested callout", () => {
    const r = render("> [!note] Outer\n> > [!tip] Inner\n> > deep\n", 60, t)
    const i = text(r).findIndex((l) => l.includes("★ Inner"))
    expect(i).toBeGreaterThan(0)
    expect(r.lines[i]!.spans[0]!.fg).toBe(t.info)
    expect(r.lines[i]!.spans[1]!.fg).toBe(t.accent)
    expect(r.plain.join("\n")).toContain("deep")
  })
  test("callout with a list and code keeps its bar on every row", () => {
    const r = render("> [!example] E\n> - a\n> - b\n>\n> ```js\n> x()\n> ```\n", 60, t)
    for (const l of text(r)) expect(l.startsWith("▎")).toBe(true)
  })
  test("not callouts: plain quote, mid-paragraph marker", () => {
    const q = render("> just a quote", 60, t).lines[0]!.spans
    expect(q.map((s) => s.text).join("")).toBe("▎ just a quote")
    expect(q[1]!.fg).toBe(t.textMuted)
    expect(text(render("para [!note] x", 60, t))).toEqual(["para [!note] x"])
  })
  test("narrow width: the header wraps under its bar and never overflows", () => {
    const r = render("> [!warning] A long title that wraps around\n> body", 16, t)
    for (const l of text(r)) {
      expect(width(l)).toBeLessThanOrEqual(16)
      expect(l.startsWith("▎")).toBe(true)
    }
  })
  test("Source colors the [!type] marker", () => {
    const sp = renderSource("> [!warning]- T\n> b", 60, t).lines[0]!.spans.find((s) => s.text.includes("[!warning]-"))!
    expect(sp.fg).toBe(t.warning)
    expect((sp.attr ?? 0) & A.BOLD).toBeTruthy()
  })
  test("readable in every theme", () =>
    readable(
      [
        "note",
        "abstract",
        "info",
        "todo",
        "tip",
        "success",
        "question",
        "warning",
        "failure",
        "danger",
        "bug",
        "example",
        "quote",
      ]
        .map((k) => `> [!${k}] Title\n> body text`)
        .join("\n\n"),
    ))
})

describe("outline parity inside quotes", () => {
  test("setext headings in quotes are in both outlines; lazy and separated underlines are not", () => {
    const cases: [string, string[]][] = [
      ["> Head\n> ---\n", ["Head"]],
      ["> Head\n> ===\n", ["Head"]],
      ["> > Deep\n> > ---\n", ["Deep"]],
      ["> a\n\n> ---\n", []],
      ["> a\n---\n", []],
      ["> - item\n> ---\n", []],
      ["Head\n> ---\n", []],
      ["> a\n    lazy\n> ---\n", []],
    ]
    for (const [src, want] of cases) {
      const [p, s] = outlines(src)
      expect(
        p.map((h) => h[1]),
        JSON.stringify(src),
      ).toEqual(want)
      expect(s, JSON.stringify(src)).toEqual(p)
    }
  })
  test("a heading inside a quoted fence is in neither outline", () => {
    const [p, s] = outlines("> ```\n> # x\n> ```\n\n# After\n")
    expect(p).toEqual([[1, "After"]])
    expect(s).toEqual(p)
    // a quoted fence line inside an unquoted fence is code, not its end
    expect(outlines("~~~\n> ~~~\n# H\n")).toEqual([[], []])
  })
  test("a callout whose body opens with a setext heading stays a callout", () => {
    const src = "> [!note] T\n> text\n> ---\n\n# After\n"
    expect(text(render(src, 60, t))[0]).toContain("T")
    const [p, s] = outlines(src)
    expect(p).toEqual([
      [2, "text"],
      [1, "After"],
    ])
    expect(s).toEqual(p)
  })
  test("a comment-only line between a paragraph and its underline is gone in both", () => {
    const [p, s] = outlines("para\n%%c%%\n===\n")
    expect(p).toEqual([[1, "para"]])
    expect(s).toEqual(p)
  })
})

describe("dataview blocks", () => {
  const dv = "```dataviewjs\nconst a = 1\nconst b = 2\ndv.table()\n```"
  test("one filled row at any width", () => {
    for (const w of [12, 30, 80, 120]) {
      const r = render(dv, w, t)
      expect(r.lines.length).toBe(1)
      expect(r.lines[0]!.fill).toBe(t.backgroundElement)
      expect(width(text(r)[0]!)).toBeLessThanOrEqual(w)
    }
  })
  test("label names the language and line count, never the query", () => {
    const l = text(render(dv, 80, t))[0]!
    expect(l).toContain("⌁ dataviewjs · 3 lines")
    expect(l).toContain("s: source")
    expect(l).not.toContain("const")
    expect(text(render("```dataview\nLIST\n```", 80, t))[0]).toContain("⌁ dataview · 1 line")
    expect(text(render("```DataviewJS\nx\n```", 80, t))[0]).toContain("⌁ DataviewJS · 1 line")
    expect(text(render("```tasks\nnot done\n```", 80, t))[0]).toContain("⌁ tasks · 1 line")
  })
  test("no highlight request is queued", () => {
    expect(render(dv, 80, t).pending ?? []).toEqual([])
  })
  test("headings after it stay exact; # inside is no heading in either outline", () => {
    const src = "```dataview\n# not\n```\n\n## After\n"
    const r = render(src, 60, t)
    expect(text(r)[r.headings[0]!.line]).toContain("After")
    const [p, s] = outlines(src)
    expect(p).toEqual([[2, "After"]])
    expect(s).toEqual(p)
  })
  test("Source still shows the query", () => {
    expect(renderSource(dv, 80, t).plain.join("\n")).toContain("dv.table()")
  })
  test("readable in every theme", () => readable(dv))
})

describe("HTML", () => {
  const hero = '<div class="daily-hero"><img class="daily-banner" src="https://x/y.jpg" alt=""></div>'
  test("stripTags keeps unknown tags and breaks on <br> and block closers", () => {
    expect(stripTags("<p>a</p><p>b</p>")).toBe("a\nb\n")
    expect(stripTags("a<br/>b")).toBe("a\nb")
    expect(stripTags("<custom-el>x</custom-el>")).toBe("<custom-el>x</custom-el>")
  })
  test("a Templater banner with no text leaves no rows", () => {
    expect(text(render(`${hero}\n\npara`, 60, t))).toEqual(["para"])
  })
  test("block HTML with text keeps the text, muted", () => {
    const r = render('<p class="day-stamp">Week 23 · Day 155</p>\n\nx', 60, t)
    expect(text(r)[0]).toBe("Week 23 · Day 155")
    expect(r.lines[0]!.spans[0]!.fg).toBe(t.textMuted)
  })
  test("unknown tags stay literal", () => {
    expect(r0("x Promise<void> y")).toBe("x Promise<void> y")
    expect(r0("a <T> b")).toBe("a <T> b")
    expect(r0("<foo>x</foo> z")).toContain("<foo>")
  })
  test("<br> breaks the line", () => {
    expect(text(render("a<br>b", 60, t))).toEqual(["a", "b"])
  })
  test("<kbd> and <mark> style their text; other known tags vanish", () => {
    const sp = render("press <kbd>Ctrl</kbd> and <mark>this</mark> <sup>2</sup>", 60, t).lines[0]!.spans
    expect(sp.map((s) => s.text).join("")).toBe("press Ctrl and this 2")
    const k = sp.find((s) => s.text === "Ctrl")!
    expect(k.bg).toBe(t.backgroundElement)
    expect(k.fg).toBe(t.accent)
    const m = sp.find((s) => s.text === "this")!
    expect(m.bg).toBe(t.backgroundElement)
    expect(m.fg).toBe(t.warning)
    expect(sp.find((s) => s.text.includes("and"))!.bg).toBeUndefined()
  })
  test("inline HTML comments vanish", () => {
    expect(r0("a <!-- hidden --> b")).not.toContain("hidden")
  })
  test("readable in every theme", () => readable("press <kbd>K</kbd> <mark>m</mark>\n\n<p>stamp</p>\n"))
})
function r0(src: string) {
  return text(render(src, 60, t))[0]!
}

describe("bare task items", () => {
  test("an item that is only [ ] or [x] draws as a task", () => {
    const r = render("- [ ]\n- [x]\n- [ ] real", 60, t)
    expect(text(r).map((l) => l.trimEnd())).toEqual(["[ ]", "[x]", "[ ] real"])
    expect(r.lines[1]!.spans.find((s) => s.text === "[x]")!.fg).toBe(t.success)
  })
  test("stats count them", () => {
    expect(stats("- [ ]\n- [x]\n- [ ] real").tasks).toEqual([1, 3])
  })
})

describe("sourceScan", () => {
  const fixtures = [
    "# A\ntext\n## B\n",
    "---\ntitle: x\n---\n# Real\n```\n# not\n```\nSetext\n===\n",
    "%%\n# hidden\n%%\n# Shown [[note|alias]] `code`\n> # quoted\n",
    "> [!note] Title\n> ## inside\n\n```dataview\nTABLE x\n```\n## after\n",
  ]
  test("headings equal the Source outline, and srcRow maps each heading's line to its row", () => {
    for (const src of fixtures) {
      const sc = sourceScan(src, t)
      const r = renderSource(src, 60, t)
      expect(sc.headings.map((h) => [h.depth, h.text])).toEqual(r.headings.map((h) => [h.depth, h.text]))
      expect(sc.headings.map((h) => r.srcRow![h.line])).toEqual(r.headings.map((h) => h.line))
    }
  })
  test("text blanks front matter, comment-only lines, fences and fenced code; inline comments are cut", () => {
    const sc = sourceScan("---\na: 1\n---\nkeep %%c%% this\n%% gone %%\n```\ncode\n```\nkeep 2\n", t)
    expect(sc.text).toEqual(["", "", "", "keep  this", "", "", "", "", "keep 2"])
  })
  test("srcRow is monotonic and lands on the gutter number of each source line", () => {
    const src = "a long line that wraps " + "word ".repeat(30) + "\nshort\n\nlast\n"
    const r = renderSource(src, 40, t)
    expect(r.srcRow!.length).toBe(4)
    r.srcRow!.forEach((row, i) => {
      if (i) expect(row).toBeGreaterThan(r.srcRow![i - 1]!)
      expect(r.lines[row]!.spans[0]!.text.trim()).toBe(String(i + 1))
    })
  })
})

describe("outline parity: structure the lexer sees", () => {
  const cases: Record<string, string> = {
    "html comment block": "# Intro\n\n<!--\n# Draft\nold\n-->\n\n# Usage\n",
    "html comment with underline": "# A\n\n<!--\n===\n-->\n\n# B\n",
    "heading in list item": "# Intro\n\n- # Item heading\n\n# Usage\n",
    "heading in numbered item": "1. # One\n2. text\n   # Two\n",
    "fence in list item": "- ```\n  # not\n  ```\n\n# Real\n",
    "html block with heading": "<details>\n<summary>x</summary>\n\n# Inside\n\n</details>\n\n# After\n",
    "lazy quote then heading": "> # CC\n===\n> ---\n> # CC\n",
    "callout setext body": "> [!note] T\n> Foo\n> ---\n\n# After\n",
    "nested list quote": "- > # Quoted\n- text\n\n# End\n",
    "single-dash setext": "Para\n-\n\n# A\n",
    "single-dash setext after headings": "# A\n## B\nPara text\n-\n-- dashes\na  \n-\n# A\n",
    "single-dash setext, non-ASCII": "Héllo wörld\n-\n-\n",
    "front matter that is not key: value": "---\nText\n---\n## C\n<div>\n",
    "front matter then a setext": "---\nText\n---\nSetext\n-\n",
  }
  for (const [name, src] of Object.entries(cases))
    test(name, () => {
      const [a, b] = outlines(src)
      expect(b).toEqual(a)
      expect(sourceScan(src, t).headings.map((h) => [h.depth, h.text])).toEqual(a)
    })

  test("heading lines point at the source", () => {
    const src = "# Intro\n\n<!--\n# Draft\n-->\n\n- # Item\n\n> Foo\n> # Q\n\nSetext\n===\n"
    const lines = src.split("\n")
    expect(
      sourceScan(src, t).headings.map((h) =>
        lines
          .slice(h.line, h.end + 1)
          .join("\n")
          .replace(/^[\s>\-#]+/, ""),
      ),
    ).toEqual(["Intro", "Item", "Q", "Setext\n==="])
  })
})

describe("Source outline: line-based path vs lexer", () => {
  const frags = [
    "# AA",
    "## BB",
    "text",
    "more text",
    "",
    "===",
    "---",
    "```",
    "~~~",
    "***",
    "Setext",
    "# J #",
    "#K",
    "\\# esc",
    "```js",
    "%% x %%",
    "<!--",
    "-->",
    "- item",
    "  - nested",
    "1. num",
    "> quote",
    "> more",
    "lazy",
    "- a\nlazy",
    "> a\nlazy",
    "text\n===",
    "- a\n---",
    "-- ",
    "-",
    "text\n-",
  ]
  test("notes the line-based path accepts get the lexer's outline", () => {
    let seed = 42
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const blankish = (kept: string[], s: Set<number>) =>
      [...s].filter((i) => !/^[ >]*$/.test(kept[i] ?? "")).sort((a, b) => a - b)
    let used = 0
    for (let n = 0; n < 4000; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => frags[Math.floor(rnd() * frags.length)]!)
        .join("\n")
        .split("\n")
      const { kept, hidden } = scanComments(lines, 0)
      if (needsLexer(kept.filter((_, i) => !hidden[i]))) continue
      used++
      const a = sourceStructureLines(kept, 0, t, hidden)
      const b = sourceStructureLexed(kept, 0, t, hidden)
      expect([...a.headings], lines.join("\n")).toEqual([...b.headings])
      expect([...a.fenceLines].sort(), lines.join("\n")).toEqual([...b.fenceLines].sort())
      expect(blankish(kept, a.codeLines), lines.join("\n")).toEqual(blankish(kept, b.codeLines))
    }
    expect(used).toBeGreaterThan(200)
  })

  test("lists, indentation, HTML, tables and link definitions go to the lexer", () => {
    for (const s of [
      "> # q",
      "> [!note] T",
      "- # a",
      "- [ ] t",
      "- a\n  more",
      "  # x",
      "\tcode",
      "<div>",
      "| a |",
      "[x]: http://a",
      "text\n  ---",
      "- a\n---",
      "> q\nlazy",
      "- - a",
    ])
      expect(needsLexer(s.split("\n")), s).toBe(true)
    for (const s of ["# A\n\ntext *x*\n\n```\ncode\n```\n", "- one\n  - two\n- three\n\n> quoted words\n\n---"])
      expect(needsLexer(s.split("\n")), s).toBe(false)
  })
})
