import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { Change } from "../../src/ai/delta"
import { width } from "../../src/lib/text"
import { headingKey } from "../../src/markdown/sections"
import type { Stats } from "../../src/markdown/stats"
import type { FileNode } from "../../src/notes/files"
import { scanTree } from "../../src/notes/files"
import { mix, themeByName } from "../../src/theme/theme"
import {
  type ChangeView,
  changeItems,
  extractLinks,
  fileRowSpans,
  findHeading,
  fmtAge,
  type InfoItem,
  infoItems,
  infoSpans,
  linkDest,
  MAX_CHANGE_ROWS,
  noteIndex,
  outlineRowSpans,
  outlineRows,
  resolveLink,
  SUMMARY_ROWS,
  tldrItems,
  wrapProperty,
} from "../../src/ui/panel"
import { useTmp } from "../helpers/tmp"

const fixture = useTmp("brothy-panel-")

const STATS: Stats = {
  words: 1021,
  lines: 10,
  headings: 12,
  links: 0,
  codeBlocks: 0,
  tables: 1,
  tasks: [2, 5],
  minutes: 5,
}

describe("outlineRows", () => {
  const hs = [
    { depth: 2, text: "Intro" },
    { depth: 3, text: "Setup" },
    { depth: 4, text: "Deep" },
    { depth: 2, text: "Usage" },
  ]
  test("indent by depth, three levels, read above the current heading", () => {
    const rows = outlineRows(hs, 2)
    expect(rows.map((r) => [r.indent, r.level, r.read, r.current])).toEqual([
      [0, 0, true, false],
      [2, 1, true, false],
      [4, 2, false, true],
      [0, 0, false, false],
    ])
  })
  test("a filter keeps matching headings in document order, with hits", () => {
    expect(outlineRows(hs, 0, "us").map((r) => [r.index, r.hits])).toEqual([[3, [0, 1]]])
  })
})

describe("infoItems", () => {
  test("properties wrap with a hanging key column, 4 rows at most; tags become chips", () => {
    const items = infoItems(
      [
        ["tags", ["alpha", "beta", "gamma-long-tag"]],
        ["title", "one two three four five six seven eight nine ten eleven twelve"],
      ],
      STATS,
      [],
      20,
      null,
    )
    expect(items.slice(0, 7)).toEqual([
      { kind: "prop", key: "title", keyW: 6, text: "one two three" },
      { kind: "prop", key: "", keyW: 6, text: "four five six" },
      { kind: "prop", key: "", keyW: 6, text: "seven eight" },
      { kind: "prop", key: "", keyW: 6, text: "nine ten …" },
      { kind: "chips", key: "tags", keyW: 6, tags: ["alpha", "beta"] },
      { kind: "chips", key: "", keyW: 6, tags: ["gamma-long-tag"] },
      { kind: "blank" },
    ])
  })
  test("too many chips end the 4th row with more", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `t${i}`)
    const rows = wrapProperty("tags", tags, 20, 5)
    expect(rows.length).toBe(4)
    expect(rows[3]).toMatchObject({ kind: "chips", more: true })
  })
  test("links: at most 8, then +N more; stats lines omit zero counts", () => {
    const links = Array.from({ length: 10 }, (_, i) => ({ target: `n${i}`, path: i % 2 ? null : `/v/n${i}.md` }))
    const now = Date.UTC(2026, 9, 12)
    const items = infoItems(
      [],
      { ...STATS, tables: 0 },
      links,
      30,
      { size: 8602, mtime: new Date(now - 3 * 86400e3) },
      now,
    )
    expect(items[0]).toEqual({ kind: "label", text: "Links" })
    expect(items.filter((i) => i.kind === "link").length).toBe(8)
    expect(items).toContainEqual({ kind: "more", n: 2 })
    expect(items.filter((i) => i.kind === "stat").map((i) => (i as { text: string }).text)).toEqual([
      "1,021 words · 5 min read",
      "12 headings · 2/5 tasks",
      "8.4 KB · edited 3 days ago",
    ])
  })
  test("property order: title, aliases, tags, date, created, modified, then file order", () => {
    const items = infoItems(
      [
        ["zeta", "z"],
        ["date", "d"],
        ["alpha", "a"],
        ["title", "t"],
      ],
      STATS,
      [],
      40,
      null,
    )
    expect(items.filter((i) => i.kind === "prop" && i.key).map((i) => (i as { key: string }).key)).toEqual([
      "title",
      "date",
      "zeta",
      "alpha",
    ])
  })
})

describe("links", () => {
  test("extractLinks: aliases, headings, note embeds; not images, code or self links", () => {
    const body =
      "See [[A]], [[B|alias]], [[C#Heading]], ![[D]], ![[pic.png]], ![[E.md]], [[a]] again, `[[code]]`\n```\n[[fenced]]\n```\n[[#local]]"
    expect(extractLinks(body)).toEqual(["A", "B", "C", "D", "E.md"])
  })
  test("resolveLink: exact relative path, else the note name; case-insensitive", () => {
    const root = fixture(["notes/Soup Base Stock.md", "a/index.md", "b/index.md", "Top.md"])
    const tree = scanTree(root)
    expect(resolveLink("notes/Soup Base Stock", tree)).toBe(join(root, "notes/Soup Base Stock.md"))
    expect(resolveLink("Soup Base Stock", tree)).toBe(join(root, "notes/Soup Base Stock.md"))
    expect(resolveLink("a/index.md", tree)).toBe(join(root, "a/index.md"))
    expect(resolveLink("index", tree)).toBe(join(root, "a/index.md")) // ambiguous: shortest path, then alphabetical
    expect(resolveLink("top", tree)).toBe(join(root, "Top.md"))
    expect(resolveLink("missing", tree)).toBeNull()
  })
  test("fmtAge words", () => {
    const now = Date.UTC(2026, 9, 12)
    expect(fmtAge(new Date(now - 30e3), now)).toBe("just now")
    expect(fmtAge(new Date(now - 5 * 60e3), now)).toBe("5 min ago")
    expect(fmtAge(new Date(now - 3600e3), now)).toBe("1 hour ago")
    expect(fmtAge(new Date(now - 86400e3), now)).toBe("1 day ago")
  })
})

describe("noteIndex / resolveLink", () => {
  test("exact relative path first, else a unique name", () => {
    const d = fixture(["a/index.md", "b/index.md", "a/Note.md", "Top.md", "x/a b.md"])
    const tree = scanTree(d)
    expect(resolveLink("a/index", tree)).toBe(join(d, "a/index.md"))
    expect(resolveLink("note", tree)).toBe(join(d, "a/Note.md"))
    expect(resolveLink("Folder/Top", tree)).toBe(join(d, "Top.md"))
    expect(resolveLink("a b", tree)).toBe(join(d, "x/a b.md"))
    expect(noteIndex(tree)).toBe(noteIndex(tree)) // cached per tree
  })
  test("ambiguous names resolve like Obsidian: a path suffix narrows, then the linking note's folder, then the shortest path", () => {
    const d = fixture([
      "plans/x.md",
      "specs/x.md",
      "deep/er/x.md",
      "p/q/take.md",
      "r/q/take.md",
      "r/take.md",
      "s/u/v.md",
      "t/u/v.md",
    ])
    const tree = scanTree(d)
    expect(resolveLink("x", tree, join(d, "specs/other.md"))).toBe(join(d, "specs/x.md"))
    expect(resolveLink("x", tree, join(d, "plans/other.md"))).toBe(join(d, "plans/x.md"))
    expect(resolveLink("x", tree, join(d, "elsewhere.md"))).toBe(join(d, "plans/x.md")) // same length: alphabetical
    expect(resolveLink("x", tree)).toBe(join(d, "plans/x.md"))
    expect(resolveLink("take", tree)).toBe(join(d, "r/take.md")) // shortest path
    expect(resolveLink("q/take", tree, join(d, "r/q/n.md"))).toBe(join(d, "r/q/take.md")) // suffix, then folder
    expect(resolveLink("q/take", tree)).toBe(join(d, "p/q/take.md"))
    expect(resolveLink("u/v", tree, join(d, "t/u/n.md"))).toBe(join(d, "t/u/v.md"))
  })
})

describe("linkDest", () => {
  const d = fixture(["dir/a.md", "dir/b c.md", "up.md", "dir/sub/z.md"])
  const tree = scanTree(d)
  const from = join(d, "dir/a.md")
  test("wikilinks resolve by name; same-note heading links stay", () => {
    expect(linkDest({ kind: "wiki", target: "z", heading: "H", embed: false }, from, tree)).toEqual({
      path: join(d, "dir/sub/z.md"),
      heading: "H",
      label: "z",
    })
    expect(linkDest({ kind: "wiki", target: "", heading: "Here", embed: false }, from, tree)).toEqual({
      path: from,
      heading: "Here",
      label: "Here",
    })
    expect(linkDest({ kind: "wiki", target: "nope", embed: false }, from, tree).path).toBeNull()
  })
  test("an ambiguous wikilink prefers the linking note's folder", () => {
    const v = fixture(["one/n.md", "two/n.md"])
    const vt = scanTree(v)
    expect(linkDest({ kind: "wiki", target: "n", embed: false }, join(v, "two/a.md"), vt).path).toBe(
      join(v, "two/n.md"),
    )
  })
  test("markdown links resolve relative to the note, URL-decoded, with #fragment", () => {
    expect(linkDest({ kind: "md", href: "b%20c.md#Sec" }, from, tree)).toEqual({
      path: join(d, "dir/b c.md"),
      heading: "Sec",
      label: "b c.md",
    })
    expect(linkDest({ kind: "md", href: "../up.md" }, from, tree)).toEqual({
      path: join(d, "up.md"),
      label: "../up.md",
    })
    expect(linkDest({ kind: "md", href: "sub/z" }, from, tree).path).toBe(join(d, "dir/sub/z.md"))
    expect(linkDest({ kind: "md", href: "#local" }, from, tree)).toEqual({
      path: from,
      heading: "local",
      label: "local",
    })
    expect(linkDest({ kind: "md", href: "missing.md" }, from, tree).path).toBeNull()
  })
  test("a percent-encoded control character never survives decoding", () => {
    expect(linkDest({ kind: "md", href: "%1b]0;LNKPWN%07.md" }, from, tree)).toEqual({
      path: null,
      label: "\ufffd]0;LNKPWN\ufffd.md",
    })
  })
  test("URLs are not opened, only reported", () => {
    expect(linkDest({ kind: "url", href: "https://x.y" }, from, tree)).toEqual({
      path: null,
      label: "https://x.y",
      url: "https://x.y",
    })
  })
})

describe("findHeading", () => {
  const hs = [{ text: "Intro" }, { text: "Part two!" }, { text: "Über  Café" }, { text: "Part two" }]
  test("lenient: case, spacing, dashes, # and punctuation", () => {
    expect(headingKey("## Part-Two!")).toBe("part two")
    expect(findHeading(hs, "part two")).toBe(1)
    expect(findHeading(hs, "Part-Two")).toBe(1)
    expect(findHeading(hs, "über café")).toBe(2)
    expect(findHeading(hs, "intro")).toBe(0)
    expect(findHeading(hs, "missing")).toBeNull()
  })
})

describe("TL;DR block", () => {
  const TEXT =
    "A tour of brothy, a terminal Markdown reader with Files, Outline and Info beside a calm text column. It covers live reload, find, themes and installing with bun."
  const rows = (items: ReturnType<typeof tldrItems>) =>
    items.map((it) => {
      if (it.kind === "tldr") return "TL;DR" + it.status
      return it.kind === "summary" ? it.text : `<${it.kind}>`
    })

  test("none: label and a muted hint", () => {
    expect(tldrItems({ text: "", state: "none", model: "" }, 30)).toEqual([
      { kind: "tldr", status: "" },
      { kind: "summary", text: "a to summarize", muted: true },
    ])
  })
  test("fresh at 30 columns matches the mockup", () => {
    expect(rows(tldrItems({ text: TEXT, state: "fresh", model: "claude-haiku-5-5" }, 30))).toEqual([
      "TL;DR · claude-haiku-5-5",
      "A tour of brothy, a terminal",
      "Markdown reader with Files,",
      "Outline and Info beside a calm",
      "text column. It covers live",
      "reload, find, themes and",
      "installing with bun.",
    ])
  })
  test("outdated at 38 columns matches the drawer mockup, muted", () => {
    const items = tldrItems({ text: TEXT, state: "outdated", model: "m" }, 38)
    expect(rows(items)).toEqual([
      "TL;DR · outdated · a to refresh",
      "A tour of brothy, a terminal Markdown",
      "reader with Files, Outline and Info",
      "beside a calm text column. It covers",
      "live reload, find, themes and",
      "installing with bun.",
    ])
    expect(items.slice(1).every((it) => it.kind === "summary" && it.muted)).toBe(true)
  })
  test("outdated suffix shortens when the full one doesn't fit", () => {
    expect(tldrItems({ text: "x", state: "outdated", model: "m" }, 30)[0]).toEqual({
      kind: "tldr",
      status: " · outdated · a",
    })
    expect(tldrItems({ text: "x", state: "outdated", model: "m" }, 31)[0]).toEqual({
      kind: "tldr",
      status: " · outdated · a to refresh",
    })
  })
  test("streaming label; fresh text not muted", () => {
    const items = tldrItems({ text: "Partial", state: "streaming", model: "" }, 30)
    expect(items).toEqual([
      { kind: "tldr", status: " · summarizing…" },
      { kind: "summary", text: "Partial", muted: false },
    ])
  })
  test("a long model name is cut to the width", () => {
    const [label] = tldrItems({ text: "x", state: "fresh", model: "a-very-long-model-name-that-overflows" }, 30)
    expect(label).toEqual({ kind: "tldr", status: " · a-very-long-model-nam…" })
  })
  test("at most 8 text rows, the last cut with …", () => {
    const items = tldrItems({ text: "word ".repeat(200), state: "fresh", model: "m" }, 30)
    expect(items.length).toBe(1 + SUMMARY_ROWS)
    const last = items.at(-1)!
    expect(last.kind === "summary" && last.text.endsWith("…") && Bun.stringWidth(last.text) <= 30).toBe(true)
  })
  test("control characters never reach a row", () => {
    const items = tldrItems({ text: "bad\x1b[2Jtext", state: "fresh", model: "m" }, 30)
    expect(rows(items)[1]).not.toContain("\x1b")
  })
  test("infoItems puts the block and a blank row before Properties; nothing when AI is off", () => {
    const props: [string, string][] = [["title", "Welcome"]]
    const on = infoItems(props, STATS, [], 30, null, 0, { text: "", state: "none", model: "" })
    expect(on.slice(0, 3).map((i) => i.kind)).toEqual(["tldr", "summary", "blank"])
    expect(on[3]!.kind).toBe("prop")
    expect(infoItems(props, STATS, [], 30, null, 0)[0]!.kind).toBe("prop")
  })
})

const chg = (status: Change["status"], name: string, plus: number, minus: number, index = 0): Change => ({
  status,
  index,
  path: index < 0 ? [] : ["Doc", name],
  key: headingKey(name),
  ord: 0,
  plus,
  minus,
  hunks: [],
  rewritten: false,
  newText: "",
})
const SAMPLE = [
  chg("edited", "Why another reader?", 2, 1),
  chg("added", "Install on macOS", 9, 0, 1),
  chg("removed", "Pager notes", 0, 14, 2),
]
const idle: ChangeView = { state: "idle", label: "14:02", changes: SAMPLE, summary: "", notes: [] }
const rowOf = (it: InfoItem) => {
  if (it.kind === "changes") return "Changed" + it.status
  if (it.kind === "change") return it.mark + " " + it.text + it.counts
  return it.kind === "summary" || it.kind === "stat" ? it.text : it.kind
}

describe("changeItems", () => {
  test("idle: label with the baseline time, one row per change, counts right-aligned", () => {
    const items = changeItems(idle, "Welcome", 30)
    expect(items.map(rowOf)).toEqual([
      "Changed · since 14:02",
      "~ Why another reader?    +2 −1",
      "+ Install on macOS          +9",
      "− Pager notes              −14",
    ])
    expect(items.filter((i) => i.kind === "change").map((i) => (i as { stop: boolean }).stop)).toEqual([
      true,
      true,
      false,
    ])
    expect(items.filter((i) => i.kind === "change").map((i) => (i as { at: number }).at)).toEqual([0, 1, 2])
  })
  test("loading: explaining…, the streamed summary and notes so far", () => {
    const items = changeItems(
      { ...idle, state: "loading", summary: "Adds macOS", notes: [{ what: "feature list trimmed" }] },
      "Welcome",
      30,
    )
    expect(items.map(rowOf).slice(0, 4)).toEqual([
      "Changed · explaining…",
      "Adds macOS",
      "~ Why another reader?    +2 −1",
      "    feature list trimmed",
    ])
  })
  test("result: model name, summary at most 3 rows, one muted line under each explained change", () => {
    const long = "Adds macOS install steps and drops the old pager notes, then rewrites the intro twice over and again."
    const items = changeItems(
      {
        state: "result",
        label: "claude-haiku-5-5",
        changes: SAMPLE,
        summary: long,
        notes: [{ what: "feature list trimmed" }, { what: "brew and bun steps" }, undefined],
      },
      "Welcome",
      30,
    )
    const rows = items.map(rowOf)
    expect(rows[0]).toBe("Changed · claude-haiku-5-5")
    expect(items.slice(1, 4).every((i) => i.kind === "summary" && i.muted)).toBe(true)
    expect(rows[3]!.endsWith("…")).toBe(true)
    expect(rows.slice(4)).toEqual([
      "~ Why another reader?    +2 −1",
      "    feature list trimmed",
      "+ Install on macOS          +9",
      "    brew and bun steps",
      "− Pager notes              −14",
    ])
  })
  test("the lead-in is named by the note title", () => {
    expect(changeItems({ ...idle, changes: [chg("edited", "", 1, 0, -1)] }, "Welcome", 30).map(rowOf)[1]).toBe(
      "~ Welcome" + " ".repeat(19) + "+1",
    )
  })
  test("at most 8 change rows, then + n more sections", () => {
    const many = Array.from({ length: 11 }, (_, i) => chg("edited", `S${i}`, 1, 0, i))
    const items = changeItems({ ...idle, changes: many }, "W", 30)
    expect(items.filter((i) => i.kind === "change").length).toBe(MAX_CHANGE_ROWS)
    expect(rowOf(items.at(-1)!)).toBe("+ 3 more sections")
  })
  test("narrow: long headings are cut with …, rows never exceed the width", () => {
    const items = changeItems(
      { ...idle, changes: [chg("edited", "A very long heading that cannot fit", 12, 345)] },
      "W",
      20,
    )
    const row = rowOf(items[1]!)
    expect(Bun.stringWidth(row)).toBe(20)
    expect(row).toContain("…")
    expect(row.endsWith("+12 −345")).toBe(true)
  })
  test("heading text is made terminal-safe", () => {
    const items = changeItems({ ...idle, changes: [chg("edited", "bad\x1b[31m", 1, 0)] }, "W", 30)
    expect(rowOf(items[1]!)).not.toContain("\x1b")
  })
})

test("infoItems puts the Changed block under the TL;DR and above the properties", () => {
  const items = infoItems(
    [["title", "T"]],
    STATS,
    [],
    30,
    null,
    0,
    { text: "Sum.", state: "fresh", model: "m" },
    { view: idle, title: "T" },
  )
  const kinds = items.map((i) => i.kind)
  expect(kinds.indexOf("tldr")).toBeLessThan(kinds.indexOf("changes"))
  expect(kinds.indexOf("changes")).toBeLessThan(kinds.indexOf("prop"))
})

describe("row spans", () => {
  const t = themeByName("brothy")
  const text = (spans: { text: string }[]) => spans.map((s) => s.text).join("")
  const node = (rel: string, o: Partial<FileNode> = {}): FileNode => ({
    name: rel.split("/").at(-1)!,
    path: "/r/" + rel,
    rel,
    dir: false,
    children: [],
    ...o,
  })
  const opts = {
    t,
    cols: 24,
    open: "/r/notes/open.md",
    expanded: new Set(["/r/open"]),
    counts: new Map([["/r/shut", 12]]),
    maxDepth: 2,
  }

  test("fileRowSpans: a closed folder shows its note count at the right edge, an open one none", () => {
    const shut = fileRowSpans({ node: node("shut", { dir: true }), depth: 0 }, opts)
    expect(text(shut)).toBe("▸ shut" + " ".repeat(16) + "12")
    expect(width(text(shut))).toBe(24)
    expect(text(fileRowSpans({ node: node("open", { dir: true }), depth: 1 }, opts))).toBe("  ▾ open")
  })

  test("fileRowSpans: the open note is marked and bold, indentation stops at maxDepth, a symlink out is marked", () => {
    const open = fileRowSpans({ node: node("notes/open.md"), depth: 5 }, opts)
    expect(text(open)).toBe("    ● open")
    expect(open.at(-1)).toEqual({ text: "open", fg: t.primary, attr: 1 })
    const out = fileRowSpans({ node: node("x.md", { outside: true }), depth: 0 }, opts)
    expect(text(out)).toBe("  x ↗")
    expect(out.at(-1)).toEqual({ text: " ↗", fg: t.textMuted })
  })

  test("fileRowSpans: a ranked hit has no indent, its hits in primary and its folder at the right edge", () => {
    const hit = fileRowSpans({ node: node("deep/notes/alpha.md"), depth: 3, hits: [0, 1] }, opts)
    expect(text(hit)).toBe("  alpha" + " ".repeat(12) + "notes")
    expect(hit.filter((s) => s.fg === t.primary && s.attr).map((s) => s.text)).toEqual(["al"])
    // no folder with fewer than 6 columns to spare
    expect(text(fileRowSpans({ node: node("notes/alpha.md"), depth: 0, hits: [] }, { ...opts, cols: 12 }))).toBe(
      "  alpha",
    )
  })

  test("outlineRowSpans: the reading heading behind ▸ in primary, read ones faded, indented", () => {
    const row = { index: 0, text: "Intro", indent: 2, level: 1 as const, read: false, current: true, hits: [] }
    expect(outlineRowSpans(row, t, 20)).toEqual([
      { text: "▸ ", fg: t.primary },
      { text: "  " },
      { text: "Intro", fg: t.primary, attr: 1 },
    ])
    const read = outlineRowSpans({ ...row, current: false, read: true, level: 2 }, t, 20)
    expect(read.at(-1)).toEqual({ text: "Intro", fg: mix(t.textMuted, t.background, 0.35), attr: 0 })
    expect(text(outlineRowSpans({ ...row, text: "a long heading text" }, t, 10))).toBe("▸   a lon…")
  })

  test("infoSpans: keys padded, unresolved links marked ?, tags cut to the room", () => {
    expect(infoSpans({ kind: "prop", key: "tags", keyW: 6, text: "x" }, t, 20)).toEqual([
      { text: "tags  ", fg: t.textMuted },
      { text: "x", fg: t.text },
    ])
    expect(infoSpans({ kind: "link", target: "Gone", path: null }, t, 20)).toEqual([
      { text: "→ ", fg: t.textMuted },
      { text: "Gone", fg: t.textMuted },
      { text: "?", fg: t.textMuted },
    ])
    expect(infoSpans({ kind: "link", target: "Here", path: "/r/here.md" }, t, 20)[1]).toEqual({
      text: "Here",
      fg: t.info,
    })
    expect(
      text(infoSpans({ kind: "chips", key: "tags", keyW: 5, tags: ["one", "averyverylongtag"], more: true }, t, 12)),
    ).toBe("tags #one #avery… …")
    expect(infoSpans({ kind: "change", mark: "+", text: "New", counts: " +3", at: 0, stop: true }, t, 20)).toEqual([
      { text: "+ ", fg: t.success },
      { text: "New", fg: t.text },
      { text: " +3", fg: t.textMuted },
    ])
    expect(infoSpans({ kind: "blank" }, t, 20)).toEqual([])
  })
})
