import { describe, expect, test } from "bun:test"
import { parseFrontMatter, parseProperties } from "../src/frontmatter"
import { canonicalLang } from "../src/highlight"
import { calloutKind, render } from "../src/markdown"
import { renderSource, sourceScan } from "../src/source"
import { A } from "../src/spans"
import { stats } from "../src/stats"
import { width, wrap } from "../src/text"
import { brothy } from "./helpers/theme"
import { SCALE, expectLinear } from "./perf"

const t = brothy
const text = (r: ReturnType<typeof render>) => r.lines.map((l) => l.spans.map((s) => s.text).join(""))
const rowText = (rows: { text: string }[][]) => rows.map((r) => r.map((s) => s.text).join(""))

describe("CRLF", () => {
  test("renderSource survives CRLF and still finds headings", () => {
    const r = renderSource("# Title\r\n\r\ntext\r\n## Two\r\n", 40, t)
    expect(r.headings.map((h) => h.text)).toEqual(["Title", "Two"])
    expect(r.lines.length).toBe(4)
  })
  test("render has no stray carriage returns", () => {
    const r = render("# Title\r\n\r\nsome *text*\r\nmore\r\n\r\n- a\r\n- b\r\n", 40, t)
    for (const l of r.plain) expect(l).not.toContain("\r")
    expect(r.headings.map((h) => h.text)).toEqual(["Title"])
  })
  test("front matter with CRLF is skipped in source view", () => {
    const r = renderSource("---\r\ntitle: x\r\n---\r\n# H\r\n", 40, t)
    expect(r.headings.map((h) => h.text)).toEqual(["H"])
    expect(r.headings[0]!.line).toBe(3)
  })
})

describe("code blocks keep whitespace", () => {
  test("leading and inner spaces survive", () => {
    const lines = text(render("```\nfoo\n    bar  baz\n```", 40, t))
    expect(lines.some((l) => l.includes("  " + "    bar  baz"))).toBe(true)
  })
  test("long lines are chopped without dropping characters", () => {
    const code = "a b ".repeat(20).trimEnd()
    const lines = text(render("```\n" + code + "\n```", 20, t))
    const body = lines.slice(1, -1).map((l) => l.replace(/^(  |↪ )/, ""))
    expect(body.length).toBeGreaterThan(1)
    expect(body[0]).toStartWith("a b a b")
    expect(body.join("").replace(/ /g, "")).toBe(code.replace(/ /g, ""))
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(20)
  })
})

describe("front matter", () => {
  test("control characters in values never survive (no terminal escapes); plain text is unchanged", () => {
    const src = '---\ntitle: "T\x1b[5mBLINK\tx"\naliases: [\x1b[7mREV, plain]\ntags:\n  - a\x9bb\n---\nbody'
    const ctl = /[\x00-\x1f\x7f-\x9f]/
    const fm = parseFrontMatter(src)
    expect(fm.entries).toEqual([["title", "T\ufffd[5mBLINK x"], ["aliases", "[\ufffd[7mREV, plain]"], ["tags", ""]])
    const props = parseProperties(src)
    expect(props).toEqual([["title", "T\ufffd[5mBLINK x"], ["aliases", ["\ufffd[7mREV", "plain"]], ["tags", ["a\ufffdb"]]])
    expect(JSON.stringify(props).match(ctl)).toBeNull()
  })
  test("closing fence must be a whole line", () => {
    const fm = parseFrontMatter("---\ntitle: x\n---not-closing\nmore: y\n---\nbody")
    expect(fm.entries.map((e) => e[0])).toEqual(["title", "more"])
    expect(fm.body).toBe("body")
    expect(fm.offset).toBe(5)
  })
  test("a longer dash run does not close it", () => {
    const fm = parseFrontMatter("---\na: 1\n----\nb: 2\n---\nbody")
    expect(fm.entries.map((e) => e[0])).toEqual(["a", "b"])
    expect(fm.body).toBe("body")
  })
  test("empty front matter is recognised", () => {
    const fm = parseFrontMatter("---\n---\n# Body")
    expect(fm.entries).toEqual([])
    expect(fm.body).toBe("# Body")
    expect(fm.offset).toBe(2)
  })
  test("closing fence at end of file and BOM", () => {
    const fm = parseFrontMatter("﻿---\nk: v\n---")
    expect(fm.entries).toEqual([["k", "v"]])
    expect(fm.body).toBe("")
    expect(fm.offset).toBe(3)
  })
  test("unclosed front matter is not front matter", () => {
    const fm = parseFrontMatter("---\nk: v\n# hi")
    expect(fm.offset).toBe(0)
  })
})

describe("graphemes", () => {
  const fam = "👨‍👩‍👧"
  test("wrap never splits a ZWJ cluster", () => {
    const rows = rowText(wrap([{ text: fam.repeat(3) }], 4))
    expect(rows).toEqual([fam.repeat(2), fam])
  })
  test("continuation rows respect a wider rest prefix", () => {
    const rows = wrap([{ text: "x".repeat(20) }], 10, [{ text: "• " }], [{ text: "    " }])
    for (const r of rowText(rows)) expect(width(r)).toBeLessThanOrEqual(10)
    expect(rowText(rows).map((r) => r.replace(/^(• |    )/, "")).join("")).toBe("x".repeat(20))
  })
})

describe("tables at small widths", () => {
  const wide = "| a | b | c | d | e |\n|---|---|---|---|---|\n| aaaaaaaa | bbbbbbbb | cccccccc | dddddddd | eeeeeeee |"
  test("never exceed max, even when columns cannot all fit", () => {
    for (const w of [10, 12, 15, 20, 25, 30]) {
      const r = render(wide, w, t)
      for (const l of text(r)) expect(width(l)).toBeLessThanOrEqual(w)
      expect(r.lines.length).toBeGreaterThan(0)
    }
  })
  test("many columns still fit", () => {
    const cols = 30
    const src = `|${" h |".repeat(cols)}\n|${"---|".repeat(cols)}\n|${" cell |".repeat(cols)}`
    for (const l of text(render(src, 40, t))) expect(width(l)).toBeLessThanOrEqual(40)
  })
  test("cells too narrow to read are truncated with an ellipsis", () => {
    const r = render("| first | second | third |\n|---|---|---|\n| alpha beta | gamma delta | epsilon zeta |", 20, t)
    expect(text(r).join("\n")).toContain("…")
  })
  test("dropped columns are flagged with a final … column", () => {
    for (const w of [10, 12, 15, 20]) {
      const lines = text(render(wide, w, t))
      for (const l of lines) expect(width(l)).toBeLessThanOrEqual(w)
      const head = lines[1]!
      expect(head.trimEnd().endsWith("… │")).toBe(true)
      expect(lines[0]!.trimEnd().endsWith("┐")).toBe(true)
    }
    // every row carries the marker cell, so the grid stays rectangular
    const lines = text(render(wide, 15, t))
    expect(new Set(lines.map((l) => width(l))).size).toBe(1)
  })
  test("no marker column when every column fits", () => {
    const lines = text(render("| a | b |\n|---|---|\n| c | d |", 40, t))
    expect(lines.join("\n")).not.toContain("…")
  })
  test("narrow column does not starve a wide one", () => {
    const r = render("| id | description |\n|---|---|\n| 1 | a fairly long description of the thing |", 40, t)
    expect(text(r).join("\n")).toContain("description")
    expect(text(r).join("\n")).not.toContain("…")
  })
  test("table with a huge number of rows renders", () => {
    const rows = Array.from({ length: 120_000 }, () => "| a |").join("\n")
    const r = render("| h |\n|---|\n" + rows, 30, t)
    expect(r.lines.length).toBeGreaterThan(100_000)
  })
})

describe("entities", () => {
  const plain = (src: string) => render(src, 60, t).plain.join("\n")
  test("decodes once, not twice", () => {
    expect(plain("`&lt;`")).toBe("&lt;")
    expect(plain("a &amp;lt; b")).toBe("a &lt; b")
  })
  test("decodes numeric and hex entities", () => {
    expect(plain("it&#x27;s &#8212; ok &#39;x&#39;")).toBe("it's — ok 'x'")
  })
  test("ignores out-of-range numeric entities", () => {
    expect(plain("bad &#99999999; here")).toBe("bad &#99999999; here")
  })
})

describe("lists", () => {
  test("ordered task items keep their number", () => {
    const lines = text(render("1. [x] done\n2. [ ] todo", 40, t))
    expect(lines[0]).toStartWith("1. [x] done")
    expect(lines[1]).toStartWith("2. [ ] todo")
  })
  test("bullet depth is independent of the parent marker", () => {
    const lines = text(render("1. one\n   - two\n     - three\n\n- a\n  - b\n    - c", 40, t))
    expect(lines.find((l) => l.includes("two"))).toContain("◦")
    expect(lines.find((l) => l.includes("three"))).toContain("▪")
    expect(lines.find((l) => l.includes(" a"))).toContain("•")
    expect(lines.find((l) => l.includes(" b"))).toContain("◦")
    expect(lines.find((l) => l.includes(" c"))).toContain("▪")
  })
  test("bullets under a task item are nested bullets", () => {
    const lines = text(render("- [ ] task\n  - sub", 40, t))
    expect(lines.find((l) => l.includes("sub"))).toContain("◦")
  })
})

describe("source outline matches preview", () => {
  const docs: Record<string, string> = {
    setext: "Title\n=====\n\nBody text\n\nSub\n---\n\nmore\n",
    "mismatched fences": "# Real\n\n```\n~~~\n# not a heading\n~~~\n```\n\n## After\n",
    "longer fence": "# A\n\n````md\n```\n# nope\n```\n````\n\n## B\n",
    "tilde fence": "# A\n\n~~~\n```\n# nope\n~~~\n\n## B\n",
    "closing hashes": "## Title ##\n\ntext\n",
    "indented atx": "  ## Indented\n\ntext\n",
    "in quote": "> ## Quoted\n\ntext\n\n# Out\n",
    hr: "# A\n\n---\n\ntext\n\n***\n",
    "multi-line setext": "line one\nline two\n===\n",
  }
  for (const [name, src] of Object.entries(docs)) {
    test(name, () => {
      const p = render(src, 60, t).headings.map((h) => [h.depth, h.text])
      const s = renderSource(src, 60, t).headings.map((h) => [h.depth, h.text])
      expect(s).toEqual(p)
    })
  }
  test("source heading line points at a row that shows the heading", () => {
    const r = renderSource("intro\n\nTitle\n=====\n\n## Two\n", 40, t)
    expect(r.headings.map((h) => h.line)).toEqual([2, 5])
    expect(r.plain[2]).toContain("title")
    expect(r.lines[2]!.heading).toBe(0)
    expect(r.lines[5]!.heading).toBe(1)
  })
})

describe("stats", () => {
  test("counts links inside table cells", () => {
    const s = stats("| a |\n|---|\n| [x](http://a) |\n\n[y](http://b)\n")
    expect(s.links).toBe(2)
  })
  test("CRLF line count", () => {
    expect(stats("a\r\nb\r\nc\r\n").lines).toBe(stats("a\nb\nc\n").lines)
  })
})

describe("entity safety", () => {
  test("control-character entities stay literal", () => {
    const plain = render("x &#27;[31m y &#7; z", 60, t).plain.join("\n")
    expect(plain).not.toContain("\u001b")
    expect(plain).not.toContain("\u0007")
  })
  test("raw control characters in the file are neutralised in both views", () => {
    const src = "x \u001b[31m `a\u001bb` y\n\n```\nc\u001bd\n```\n"
    for (const r of [render(src, 60, t), renderSource(src, 60, t)])
      for (const l of r.lines) for (const s of l.spans) expect(s.text).not.toContain("\u001b")
  })
})

describe("deep quote prefixes at narrow widths", () => {
  const cases = ["> ".repeat(60) + "---", "> > > > > > # T", "> > > > > > ## T", "> ".repeat(60) + "```\ncode\n```", "- ".repeat(40) + "---", "> ".repeat(30) + "| a |\n> ".repeat(1) + "|---|\n> | b |"]
  test("render and renderSource never throw", () => {
    const th = brothy
    for (const src of cases)
      for (let w = 1; w <= 80; w++) {
        expect(() => render(src, w, th), `${JSON.stringify(src.slice(0, 20))} @${w}`).not.toThrow()
        expect(() => renderSource(src, w, th)).not.toThrow()
      }
  })
})

describe("CR-only line endings", () => {
  const src = "---\rtitle: x\rtags: [a, b]\r---\r# Real\r"
  test("front matter and properties are read, and Preview and Source agree", () => {
    const fm = parseFrontMatter(src)
    expect(fm.entries).toEqual([["title", "x"], ["tags", "[a, b]"]])
    expect(fm.body).toBe("# Real\n")
    expect(fm.offset).toBe(4)
    expect(parseProperties(src)).toEqual([["title", "x"], ["tags", ["a", "b"]]])
    const out = (r: ReturnType<typeof render>) => r.headings.map((h) => h.text)
    expect(out(renderSource(src, 60, t))).toEqual(["Real"])
    expect(out(render(fm.body, 60, t))).toEqual(["Real"])
  })
})

describe("user text never hits Object.prototype", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])
    test(`[!${name}] is a note, ${name} fence is plain`, () => {
      expect(calloutKind(name)).toBe("note")
      const out = text(render(`> [!${name}] Title\n> body\n\n\`\`\`${name}\nx = 1\n\`\`\``, 60, t))
      expect(out.join("\n")).not.toContain("undefined")
      expect(out.join("\n")).toContain("Title")
      expect(canonicalLang(name)).toBe(name.toLowerCase())
      expect(() => renderSource(`> [!${name}] T`, 60, t)).not.toThrow()
    })
})

describe("pathological inline input stays fast", () => {
  // timed at full size and 1/8 of it by `expectLinear` (see perf.ts); a full-size run under 20 ms is fast whatever its ratio
  const inputs: Record<string, [unit: string, reps: number]> = {
    "unclosed [": ["[", 100_000],
    "unclosed [[": ["[[", 50_000],
    "unpaired ==": ["==a ", 40_000],
    "mixed emphasis": ["*a _b ", 8_000],
    "unclosed [[a": ["[[a ", 40_000],
  }
  const views: Record<string, (src: string) => unknown> = {
    render: (src) => render(src, 80, t),
    renderSource: (src) => renderSource(src, 80, t),
    stats: (src) => stats(src),
    sourceScan: (src) => sourceScan(src, t),
  }
  for (const [name, [unit, reps]] of Object.entries(inputs))
    test(name, () => {
      const big = unit.repeat(reps)
      const small = unit.repeat(reps / SCALE)
      for (const [view, f] of Object.entries(views)) expectLinear(view, (isBig) => f(isBig ? big : small))
    }, 60_000)

  test("a paragraph past the inline cap keeps its text, the rest as plain text", () => {
    const head = "**bold** " + "word ".repeat(1000)
    const tail = "**not bold** [[not a link]] ==not marked==" + " x".repeat(10)
    const r = render(`# T\n\n${head}${tail}\n\n## After\n`, 80, t)
    expect(r.headings.map((h) => h.text)).toEqual(["T", "After"])
    expect(r.links).toHaveLength(0)
    expect(r.lines.map((l) => l.spans.map((s) => s.text).join("")).join(" ").replace(/\s+/g, " ")).toContain("**not bold** [[not a link]] ==not marked==")
    expect(r.lines.some((l) => l.spans.some((s) => s.text === "bold" && (s.attr ?? 0) & A.BOLD))).toBe(true)
  })

  test("outline parity holds with an overlong heading", () => {
    const src = `# ${"w ".repeat(3000)}\n\ntext\n\n## Two\n`
    expect(render(src, 60, t).headings.map((h) => h.text)).toEqual(renderSource(src, 60, t).headings.map((h) => h.text))
  })
})
