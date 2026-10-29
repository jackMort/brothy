import { afterAll, describe, expect, test } from "bun:test"
import { A } from "../../src/lib/spans"
import { width } from "../../src/lib/text"
import {
  cachedHighlight,
  canonicalLang,
  clearHighlightCache,
  codeSpans,
  ensureHighlights,
  fallbackTokens,
  groupKind,
  type Kind,
  kindStyle,
  PARSER_FILETYPES,
  shutdownHighlighter,
  tokenize,
} from "../../src/markdown/highlight"
import { pendingHighlights, render } from "../../src/markdown/render"
import { themes } from "../../src/theme/theme"
import { brothy } from "../helpers/theme"

const t = brothy
afterAll(() => shutdownHighlighter())

const fenced = (lang: string, code: string) => "```" + lang + "\n" + code + "\n```"
const kinds = (toks: { text: string; kind?: Kind }[]) => toks.filter((k) => k.kind).map((k) => [k.text, k.kind])
const fg = (r: ReturnType<typeof render>, text: string) => r.lines.flatMap((l) => l.spans).find((s) => s.text.includes(text))?.fg

describe("languages", () => {
  test("info strings map to parser filetypes", () => {
    expect(canonicalLang("ts")).toBe("typescript")
    expect(canonicalLang("TSX title=x.tsx")).toBe("typescriptreact")
    expect(canonicalLang("js {1,3}")).toBe("javascript")
    expect(canonicalLang("zig")).toBe("zig")
    expect(canonicalLang("Python")).toBe("python")
    expect(canonicalLang("")).toBe("")
  })
  test("every filetype we claim really has a bundled parser, and python does not", async () => {
    const core = await import("@opentui/core")
    const client = core.getTreeSitterClient()
    await client.initialize()
    for (const ft of PARSER_FILETYPES) {
      const r = await client.highlightOnce("x", ft)
      expect([ft, r.warning, r.error]).toEqual([ft, undefined, undefined])
    }
    expect((await client.highlightOnce("x", "python")).warning).toContain("No parser")
  })
})

describe("capture names -> kinds", () => {
  test("prefixes resolve to the closest known group", () => {
    expect(groupKind("keyword.function")).toBe("keyword")
    expect(groupKind("string.escape")).toBe("escape")
    expect(groupKind("string.regexp")).toBe("string")
    expect(groupKind("comment.documentation")).toBe("comment")
    expect(groupKind("function.builtin")).toBe("function")
    expect(groupKind("type.builtin")).toBe("type")
    expect(groupKind("variable.member")).toBe("property")
    expect(groupKind("variable.parameter")).toBe("variable")
    expect(groupKind("constructor")).toBe("type")
  })
  test("editor metadata groups and unknown names are ignored", () => {
    for (const g of ["spell", "nospell", "conceal", "markup.heading.1", "toString", "__proto__"]) expect(groupKind(g)).toBeUndefined()
  })
})

describe("tokenize", () => {
  test("more specific groups beat generic ones, later beats earlier on ties", () => {
    const code = "foo(1) // c"
    const toks = tokenize(code, [
      [0, 3, "variable"],
      [0, 3, "function"],
      [4, 5, "number"],
      [7, 11, "comment"],
      [7, 11, "spell"],
      [7, 11, "comment.documentation"],
    ])
    expect(kinds(toks[0]!)).toEqual([
      ["foo", "function"],
      ["1", "number"],
      ["// c", "comment"],
    ])
    expect(toks[0]!.map((k) => k.text).join("")).toBe(code)
  })
  test("predicate-less identifier captures are re-checked against the text", () => {
    const code = "a Foo FOO"
    const both = (s: number, e: number): [number, number, string][] => [
      [s, e, "variable"],
      [s, e, "type"],
      [s, e, "constant"],
    ]
    const toks = tokenize(code, [...both(0, 1), ...both(2, 5), ...both(6, 9)])
    expect(kinds(toks[0]!)).toEqual([
      ["Foo", "type"],
      ["FOO", "constant"],
    ])
  })
  test("splits into one token list per source line", () => {
    const toks = tokenize("a\n\nb", [
      [0, 1, "keyword"],
      [3, 4, "string"],
    ])
    expect(toks.length).toBe(3)
    expect(toks[1]).toEqual([])
    expect(kinds(toks[2]!)).toEqual([["b", "string"]])
  })
})

describe("theme colors", () => {
  test("each kind takes its color from the theme it is drawn with", () => {
    for (const th of themes) {
      expect(kindStyle("keyword", th).fg).toBe(th.secondary)
      expect(kindStyle("string", th).fg).toBe(th.success)
      expect(kindStyle("number", th).fg).toBe(th.warning)
      expect(kindStyle("constant", th).fg).toBe(th.warning)
      expect(kindStyle("function", th).fg).toBe(th.primary)
      expect(kindStyle("type", th).fg).toBe(th.info)
      expect(kindStyle("comment", th)).toEqual({ fg: th.textMuted, attr: A.ITALIC })
      expect(kindStyle(undefined, th).fg).toBe(th.text)
    }
  })
})

describe("cache and rendering", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is TypeScript source with a template literal
  const src = fenced("ts", "const a = 1 // hi\nfunction f(n: number) {\n  return `x${n}`\n}")

  test("miss -> pending request -> hit, and a hit is not re-parsed", async () => {
    clearHighlightCache()
    const before = render(src, 60, t)
    const reqs = pendingHighlights(before)
    expect(reqs.length).toBe(1)
    expect(reqs[0]!.lang).toBe("typescript")
    expect(cachedHighlight(reqs[0]!.lang, reqs[0]!.code)).toBeUndefined()
    expect(fg(before, "const")).toBe(t.text) // plain until highlighted

    expect(await ensureHighlights(reqs)).toBe(true)
    expect(cachedHighlight(reqs[0]!.lang, reqs[0]!.code)).toBeDefined()
    const after = render(src, 60, t)
    expect(pendingHighlights(after)).toEqual([])
    expect(fg(after, "const")).toBe(t.secondary)
    expect(fg(after, "// hi")).toBe(t.textMuted)

    expect(await ensureHighlights(reqs)).toBe(false)
  })
  test("a request the worker drops (shut down mid-parse, as renderer.destroy() does) is not cached; the next ensure parses", async () => {
    clearHighlightCache()
    const reqs = pendingHighlights(render(fenced("ts", "const dropped = 1 // the worker went away"), 60, t))
    const asked = ensureHighlights(reqs) // in flight: shutdown destroys the client under it
    await shutdownHighlighter()
    expect(await asked).toBe(false)
    expect(cachedHighlight(reqs[0]!.lang, reqs[0]!.code)).toBeUndefined() // not pinned to the fallback
    expect(await ensureHighlights(reqs)).toBe(true) // a fresh worker
    expect(cachedHighlight(reqs[0]!.lang, reqs[0]!.code)).toBeTruthy()
  })
  test("duplicate requests share one parse", async () => {
    clearHighlightCache()
    const reqs = pendingHighlights(render(src + "\n\n" + src, 60, t))
    expect(reqs.length).toBe(2)
    expect(await ensureHighlights(reqs)).toBe(true)
    expect(pendingHighlights(render(src + "\n\n" + src, 60, t))).toEqual([])
  })
  test("switching theme re-colors from the cache without a new parse", async () => {
    clearHighlightCache()
    await ensureHighlights(pendingHighlights(render(src, 60, t)))
    const other = themes[1]!
    const r = render(src, 60, other)
    expect(pendingHighlights(r)).toEqual([])
    expect(fg(r, "const")).toBe(other.secondary)
  })
  test("line count and heading lines are identical with and without highlighting", async () => {
    const doc = [
      "# One",
      fenced("ts", "const a = 1\n\n\n  indented()\n// trailing comment\nconst long = '" + "x".repeat(80) + "'"),
      "## Two",
      fenced("tsx", "const e = <div className='a'>{x}</div>"),
      fenced("zig", "pub fn main() void {}"),
      "- item\n\n  " + fenced("js", "let y = `multi\nline`").replace(/\n/g, "\n  "),
      "> " + fenced("ts", "type A = string").replace(/\n/g, "\n> "),
      "### Three",
      fenced("ts", ""),
      fenced("ts", "ünï 日本語😀 = '😀'"),
    ].join("\n\n")
    for (const w of [20, 40, 80]) {
      clearHighlightCache()
      const plain = render(doc, w, t)
      expect(pendingHighlights(plain).length).toBeGreaterThan(5)
      await ensureHighlights(pendingHighlights(plain))
      const hl = render(doc, w, t)
      expect(pendingHighlights(hl)).toEqual([])
      expect(hl.lines.length).toBe(plain.lines.length)
      expect(hl.headings.map((h) => h.line)).toEqual(plain.headings.map((h) => h.line))
      expect(hl.plain).toEqual(plain.plain)
      for (const l of hl.lines) expect(width(l.spans.map((s) => s.text).join(""))).toBeLessThanOrEqual(w)
    }
  })
  test("non-ASCII offsets line up", async () => {
    clearHighlightCache()
    const code = 'const é = "日本語😀" // ü'
    await ensureHighlights([{ lang: "typescript", code }])
    const toks = cachedHighlight("typescript", code)![0]!
    expect(kinds(toks)).toContainEqual(['"日本語😀"', "string"])
    expect(kinds(toks)).toContainEqual(["// ü", "comment"])
  })
  test("a block that is not cached never changes shape: codeSpans always yields one entry per line", () => {
    clearHighlightCache()
    for (const code of ["", "a", "a\n", "\n\n", "x\r".slice(0, 1)]) expect(codeSpans("ts", code, t).lines.length).toBe(code.split("\n").length)
  })
})

describe("languages without a parser", () => {
  test("no request is made and the block still renders", () => {
    clearHighlightCache()
    for (const lang of ["python", "bash", "json", "rust", "nonsense", ""]) {
      const r = render(fenced(lang, "x = 1"), 40, t)
      expect(pendingHighlights(r)).toEqual([])
      expect(r.lines.length).toBeGreaterThan(2)
    }
  })
  test("unknown or missing languages stay plain", () => {
    expect(fallbackTokens("# not // a -- comment 'or string' 12", "")).toEqual([{ text: "# not // a -- comment 'or string' 12" }])
    expect(fallbackTokens("# nope", "nonsense")).toEqual([{ text: "# nope" }])
  })
  test("comment syntax only fires in the languages that use it", () => {
    const comment = (line: string, lang: string) => kinds(fallbackTokens(line, lang)).some(([, k]) => k === "comment")
    expect(comment("x = 1 # c", "python")).toBe(true)
    expect(comment("x = 1 // c", "python")).toBe(false)
    expect(comment("x = 1 -- c", "python")).toBe(false)
    expect(comment("let x = 1 // c", "rust")).toBe(true)
    expect(comment("let x = 1 # c", "rust")).toBe(false)
    expect(comment("select 1 -- c", "sql")).toBe(true)
    expect(comment("select 1 # c", "sql")).toBe(false)
    expect(comment('{"a": "// no", "b": 1}', "json")).toBe(false)
    expect(comment("echo a#b", "bash")).toBe(false)
    expect(comment("echo a #b", "bash")).toBe(true)
  })
  test("comment markers inside strings are not comments", () => {
    expect(kinds(fallbackTokens('s = "a # b" # c', "python"))).toEqual([
      ['"a # b"', "string"],
      ["# c", "comment"],
    ])
    expect(kinds(fallbackTokens('let u = "http://x" // c', "rust"))).toEqual([
      ['"http://x"', "string"],
      ["// c", "comment"],
    ])
  })
  test("numbers and literals in the fallback", () => {
    expect(kinds(fallbackTokens("x = [1, 0xFF, 2.5e3, None]", "python"))).toEqual([
      ["1", "number"],
      ["0xFF", "number"],
      ["2.5e3", "number"],
      ["None", "constant"],
    ])
    expect(kinds(fallbackTokens('{"a": true}', "json"))).toEqual([
      ['"a"', "string"],
      ["true", "constant"],
    ])
  })
  test("fallback tokens always reassemble the line", () => {
    for (const [line, lang] of [
      ["a 'b' # c", "python"],
      ["", "rust"],
      ["`x` // y", "go"],
      ["\t  spaced   out", "sql"],
    ] as const)
      expect(
        fallbackTokens(line, lang)
          .map((k) => k.text)
          .join(""),
      ).toBe(line)
  })
})
