import { describe, expect, test } from "bun:test"
import { A, parseWikilink, render, renderSource, wikiLabel, width } from "../src/markdown"
import { themes } from "../src/theme"

const t = themes[0]!
const text = (r: ReturnType<typeof render>) => r.lines.map((l) => l.spans.map((s) => s.text).join(""))
const linkSpans = (r: ReturnType<typeof render>) => r.lines.flatMap((l) => l.spans.filter((s) => s.link !== undefined))

describe("parseWikilink / wikiLabel", () => {
  const cases: [string, ReturnType<typeof parseWikilink>, string][] = [
    ["Note", { target: "Note" }, "Note"],
    ["Folder/Note", { target: "Folder/Note" }, "Note"],
    ["Note.md", { target: "Note.md" }, "Note"],
    ["Note|alias", { target: "Note", alias: "alias" }, "alias"],
    ["Note#Heading", { target: "Note", heading: "Heading" }, "Note › Heading"],
    ["Note#H1#H2", { target: "Note", heading: "H2" }, "Note › H2"],
    ["#Heading", { target: "", heading: "Heading" }, "Heading"],
    ["Note#^blk", { target: "Note", block: "blk" }, "Note"],
    ["Note#Heading|shown", { target: "Note", heading: "Heading", alias: "shown" }, "shown"],
    [" spaced | a ", { target: "spaced", alias: "a" }, "a"],
  ]
  for (const [inner, parsed, label] of cases)
    test(`[[${inner}]]`, () => {
      expect(parseWikilink(inner)).toEqual(parsed)
      expect(wikiLabel(parsed)).toBe(label)
    })
})

describe("wikilinks in the preview", () => {
  test("render as their label, info + underline, each with its own id", () => {
    const r = render("see [[b]] and [[c|Sea]] and [[b]]", 80, t)
    expect(text(r)).toEqual(["see b and Sea and b"])
    const ls = linkSpans(r)
    expect(ls.map((s) => s.text)).toEqual(["b", "Sea", "b"])
    expect(ls.map((s) => s.link)).toEqual([0, 1, 2])
    for (const s of ls) {
      expect(s.fg).toBe(t.info)
      expect((s.attr ?? 0) & A.UNDERLINE).toBeTruthy()
    }
    expect(r.links).toEqual([
      { kind: "wiki", target: "b", embed: false },
      { kind: "wiki", target: "c", embed: false },
      { kind: "wiki", target: "b", embed: false },
    ])
  })
  test("heading links keep the heading for the jump", () => {
    const r = render("[[b#Part two]] [[#Local]]", 80, t)
    expect(text(r)).toEqual(["b › Part two Local"])
    expect(r.links).toEqual([
      { kind: "wiki", target: "b", heading: "Part two", embed: false },
      { kind: "wiki", target: "", heading: "Local", embed: false },
    ])
  })
  test("unresolved targets are muted when `exists` says so; same-note links always resolve", () => {
    const r = render("[[yes]] [[no]] [[#Here]]", 80, t, { exists: (x) => x === "yes" })
    const [yes, no, here] = linkSpans(r)
    expect(yes!.fg).toBe(t.info)
    expect(no!.fg).toBe(t.textMuted)
    expect(here!.fg).toBe(t.info)
    expect((no!.attr ?? 0) & A.UNDERLINE).toBeTruthy()
  })
  test("code stays literal; unclosed brackets stay text", () => {
    const r = render("`[[code]]` [[unclosed\n\n```\n[[fence]]\n```", 80, t)
    expect(r.plain.join("\n")).toContain("[[code]]")
    expect(r.plain.join("\n")).toContain("[[unclosed")
    expect(r.plain.join("\n")).toContain("[[fence]]")
    expect(r.links).toEqual([])
  })
  test("image embeds are a muted placeholder, not a link; note embeds are links with ↳", () => {
    const r = render("![[shot 1.png]] ![[Board.canvas]] ![[Note]]", 80, t)
    expect(text(r)).toEqual(["▣ shot 1.png ▣ Board.canvas ↳ Note"])
    const img = r.lines[0]!.spans.find((s) => s.text.includes("shot"))!
    expect(img.fg).toBe(t.textMuted)
    expect((img.attr ?? 0) & A.ITALIC).toBeTruthy()
    expect(img.link).toBeUndefined()
    expect(r.links).toEqual([{ kind: "wiki", target: "Note", embed: true }])
  })
  test("markdown links get ids too, classified md / url", () => {
    const r = render("[a](other.md#Sec) [b](#local) [c](https://x.y) [d](mailto:q@x.y)", 80, t)
    expect(r.links).toEqual([
      { kind: "md", href: "other.md#Sec" },
      { kind: "md", href: "#local" },
      { kind: "url", href: "https://x.y" },
      { kind: "url", href: "mailto:q@x.y" },
    ])
    expect(linkSpans(r).map((s) => s.link)).toEqual([0, 1, 2, 3])
  })
  test("adjacent links never merge into one span", () => {
    const ls = linkSpans(render("[[a]][[b]]", 80, t))
    expect(ls.map((s) => [s.text, s.link])).toEqual([["a", 0], ["b", 1]])
  })
  test("a link wrapped across rows keeps its id on both rows", () => {
    const r = render("xxxxxxxx [[n|one two three four]]", 14, t)
    const rows = r.lines.map((l) => l.spans.filter((s) => s.link === 0).map((s) => s.text).join(""))
    expect(rows.filter(Boolean).length).toBeGreaterThan(1)
    expect(rows.join(" ").replace(/\s+/g, " ").trim()).toBe("one two three four")
  })
  test("links inside tables, headings, lists and callout titles get ids", () => {
    const r = render("## About [[x|the X]]\n\n- [[li]]\n\n> [!note] see [[t]]\n\n| a |\n|---|\n| [[cell\\|C]] |\n", 80, t)
    expect(r.links!.map((l) => (l.kind === "wiki" ? l.target : ""))).toEqual(["x", "li", "t", "cell"])
  })
  test("glyphs are one column", () => {
    for (const g of ["↳", "▣", "›"]) expect(width(g)).toBe(1)
  })
})

describe("parity and Source", () => {
  test("a heading with a wikilink reads the same in both outlines", () => {
    const src = "## About [[x|the X]]\n\ntext\n"
    const p = render(src, 60, t).headings.map((h) => [h.depth, h.text])
    expect(p).toEqual([[2, "About the X"]])
    expect(renderSource(src, 60, t).headings.map((h) => [h.depth, h.text])).toEqual(p)
  })
  test("Source keeps [[…]] verbatim and tints it info; code lines stay untinted", () => {
    const r = renderSource("see [[b|Bee]] here\n\n```\n[[code]]\n```\n", 80, t)
    expect(r.plain[0]).toContain("see [[b|bee]] here")
    expect(r.lines[0]!.spans.find((s) => s.text.includes("[[b|Bee]]"))!.fg).toBe(t.info)
    expect(r.lines[0]!.spans.find((s) => s.text.includes("see"))!.fg).toBe(t.text)
    const code = r.lines.find((l) => l.spans.some((s) => s.text.includes("[[code]]")))!
    expect(code.spans.find((s) => s.text.includes("[[code]]"))!.fg).toBe(t.accent)
  })
  test("Source mutes an unresolved [[…]] like Preview does", () => {
    const r = renderSource("[[ok]] [[gone|Gone]] [[#here]] ![[ok]]\n", 80, t, { exists: (x) => x === "ok" })
    const fg = (part: string) => r.lines[0]!.spans.find((s) => s.text === part)!.fg
    expect(fg("[[ok]]")).toBe(t.info)
    expect(fg("[[gone|Gone]]")).toBe(t.textMuted)
    expect(fg("[[#here]]")).toBe(t.info)
    expect(fg("![[ok]]")).toBe(t.info)
  })
})
