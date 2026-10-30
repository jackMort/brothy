import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { Change } from "../../src/ai/delta"
import { A } from "../../src/lib/spans"
import { width } from "../../src/lib/text"
import { headingKey } from "../../src/markdown/sections"
import type { Stats } from "../../src/markdown/stats"
import type { FileNode } from "../../src/notes/files"
import { scanTree } from "../../src/notes/files"
import { mix, themeByName } from "../../src/theme/theme"
import { footInk } from "../../src/ui/footnote"
import {
  type ChangeView,
  changeHead,
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
  MAX_CHANGE_ROWS_OPEN,
  noteIndex,
  outlineRowSpans,
  outlineRows,
  resolveLink,
  SUMMARY_ROWS,
  type SummaryView,
  tldrHead,
  tldrItems,
  tldrWord,
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
  // the study's 62-word reply
  const BROTH =
    "A good broth takes patience: bones and cold water held where the surface barely moves, never a rolling boil. Chicken simmers for 3 to 4 hours, beef for 8 to 12 and fish for only 45 minutes before it turns bitter. Skim the grey foam in the first hour, keep the fat, and salt only at the end, since the pot reduces."
  const sv = (o: Partial<SummaryView> = {}): SummaryView => ({
    text: BROTH,
    state: "fresh",
    model: "llama3.2",
    secs: 0,
    stale: null,
    old: "",
    error: null,
    open: false,
    ...o,
  })
  const t = themeByName("brothy")
  const text = (spans: { text: string }[]) => spans.map((x) => x.text).join("")
  /** each row as drawn at `cols` */
  const drawn = (items: InfoItem[], cols = 30) => items.map((it) => text(infoSpans(it, t, cols)))
  const feet = (items: InfoItem[]) => items.filter((it) => it.kind === "foot")
  const rule = (items: InfoItem[]) => items.at(-1) as Extract<InfoItem, { kind: "frule" }>

  test("none: one hint row, no rule", () => {
    const items = tldrItems(sv({ text: "", state: "none", model: "" }), 30)
    expect(drawn(items)).toEqual(["* a summarize this note"])
    const spans = infoSpans(items[0]!, t, 30)
    expect(spans.map((x) => x.fg)).toEqual([t.textMuted, undefined, t.text, t.textMuted])
  })
  test("fresh: * and a hanging indent, then the rule with its signature", () => {
    const items = tldrItems(sv(), 30)
    const rows = drawn(items)
    expect(rows[0]).toBe("* A good broth takes patience:")
    expect(rows[1]).toBe("  bones and cold water held")
    expect(rows.at(-1)).toBe(`${"─".repeat(13)} TL;DR · llama3.2`)
    expect(rows.every((r) => width(r) <= 30)).toBe(true)
    expect(infoSpans(items[0]!, t, 30)[0]).toEqual({ text: "*", fg: t.primary })
    expect(rule(items)).toMatchObject({ stop: false })
  })
  test("a long model is cut before the signature; control characters never pass", () => {
    const long = drawn(tldrItems(sv({ model: "a-very-long-model-name-that-overflows" }), 30)).at(-1)!
    expect(long).toStartWith("────")
    expect(long).toContain("TL;DR · a-very-")
    expect(long).toEndWith("…")
    expect(width(long)).toBe(30)
    const rows = drawn(tldrItems(sv({ text: "bad\x1b[2Jtext", model: "m\x1b" }), 30))
    expect(rows.join("")).not.toContain("\x1b")
  })
  test("the 62-word reply shows whole: 12 rows at 30 columns, 10 at 34 and 38", () => {
    for (const [cols, n] of [
      [30, 12],
      [34, 10],
      [38, 10],
    ] as const) {
      const items = tldrItems(sv(), cols)
      expect(feet(items).length).toBe(n)
      expect(drawn(items, cols).join("")).not.toContain("…")
      expect(rule(items).stop).toBe(false)
    }
  })
  test("past 14 rows: the 14th ends …, the rule is a stop saying ⏎ more; open shows every row and ⏎ less", () => {
    const long = "word ".repeat(200)
    const shut = tldrItems(sv({ text: long }), 30)
    expect(feet(shut).length).toBe(SUMMARY_ROWS)
    const rows = drawn(shut)
    expect(rows[SUMMARY_ROWS - 1]).toEndWith("…")
    expect(rows.at(-1)).toEndWith("⏎ more · llama3.2")
    expect(rule(shut).stop).toBe(true)
    const open = tldrItems(sv({ text: long, open: true }), 30)
    expect(feet(open).length).toBeGreaterThan(SUMMARY_ROWS)
    expect(feet(open).length).toBeLessThanOrEqual(Math.ceil(1200 / 28))
    expect(drawn(open).at(-1)).toEndWith("⏎ less · llama3.2")
  })
  test("outdated: text dimmed, mark muted, the tail says why and how to refresh", () => {
    const edited = tldrItems(sv({ state: "outdated", stale: "edited" }), 30)
    expect(feet(edited).every((it) => it.tone === "stale" && it.markStale)).toBe(true)
    expect(drawn(edited).at(-1)).toBe(`${"─".repeat(5)} edited since · a refresh`)
    expect(infoSpans(edited[1]!, t, 30).at(-1)!.fg).toBe(mix(t.textMuted, t.background, 0.4))
    expect(drawn(tldrItems(sv({ state: "outdated", stale: "version" }), 30)).at(-1)).toEndWith(
      "older version · a refresh",
    )
  })
  test("waiting: the caret row and the seconds on the tail from 1 s; regenerating keeps the old text dimmed", () => {
    const at = (secs: number) => drawn(tldrItems(sv({ text: "", state: "waiting", secs }), 30))
    expect(at(0)).toEqual(["* ▍", `${"─".repeat(14)} asking llama3.2`])
    expect(at(3)).toEqual(["* ▍", `${"─".repeat(8)} asking llama3.2 · 3 s`])
    const caret = infoSpans(tldrItems(sv({ text: "", state: "waiting" }), 30)[0]!, t, 30)
    expect(caret.map((x) => x.fg)).toEqual([t.primary, undefined, t.text])
    const regen = tldrItems(sv({ text: "", state: "waiting", old: BROTH, secs: 1 }), 30)
    expect(drawn(regen).slice(0, 2)).toEqual(["* ▍", "  A good broth takes patience:"])
    expect(
      feet(regen)
        .slice(1)
        .every((it) => it.tone === "stale" && it.mark === null),
    ).toBe(true)
    expect(infoSpans(regen[0]!, t, 30)[0]!.fg).toBe(t.textMuted)
    expect(drawn(regen).at(-1)).toEndWith("asking llama3.2 · 1 s")
    expect(drawn(tldrItems(sv({ text: "", state: "waiting", secs: 3 }), 44), 44).at(-1)).toEndWith(
      "asking llama3.2 · 3 s · a cancel",
    )
  })
  test("streaming: the text so far ends in the caret; the tail names the model and a cancel", () => {
    const items = tldrItems(sv({ text: "Apples are", state: "streaming" }), 30)
    expect(drawn(items)).toEqual(["* Apples are▍", `${"─".repeat(10)} llama3.2 · a cancel`])
    const capped = tldrItems(sv({ text: "word ".repeat(200), state: "streaming" }), 30)
    expect(feet(capped).length).toBe(SUMMARY_ROWS)
    expect(rule(capped).stop).toBe(false)
  })
  test("error: ✗ and the message in at most 3 rows, the old text dimmed under it, a retry", () => {
    const items = tldrItems(sv({ state: "none", text: "", error: "500 from localhost:11434" }), 30)
    expect(drawn(items)).toEqual(["* ✗ 500 from localhost:11434", `${"─".repeat(16)}       a retry`])
    const spans = infoSpans(items[0]!, t, 30)
    expect(spans.map((x) => [x.text, x.fg])).toEqual([
      ["*", t.textMuted],
      [" ", undefined],
      ["✗", t.error],
      [" 500 from localhost:11434", t.textMuted],
    ])
    const long = drawn(tldrItems(sv({ state: "none", text: "", error: "word ".repeat(40) }), 30))
    expect(long.length).toBe(4)
    expect(long[1]).toStartWith("    word")
    expect(long[2]).toEndWith("…")
    const over = tldrItems(sv({ error: "empty summary" }), 30)
    expect(drawn(over).slice(0, 2)).toEqual(["* ✗ empty summary", "  A good broth takes patience:"])
    expect(
      feet(over)
        .slice(1)
        .every((it) => it.tone === "stale"),
    ).toBe(true)
  })
  test("a narrow panel shrinks the rule to 4 first, then cuts the model, then drops the key, never the status first", () => {
    const tail = (o: Partial<SummaryView>, cols: number) => drawn(tldrItems(sv(o), cols), cols).at(-1)!
    const edited = { state: "outdated", stale: "edited" } as const
    expect(tail(edited, 29)).toBe(`${"─".repeat(4)} edited since · a refresh`)
    expect(tail(edited, 22)).toBe(`${"─".repeat(9)} edited since`)
    expect(tail(edited, 14)).toBe(`${"─".repeat(4)} edited s…`)
    expect(tail({ text: "x", state: "streaming" }, 22)).toBe(`${"─".repeat(4)} llama… · a cancel`)
    expect(tail({ text: "", state: "waiting", secs: 3 }, 22)).toBe(`${"─".repeat(4)} asking lla… · 3 s`)
    for (const cols of [12, 14, 18, 22, 30]) expect(width(tail(edited, cols))).toBe(cols)
  })
  test("the head mark and a's word follow the state", () => {
    expect(tldrHead(null)).toBeNull()
    expect(tldrHead(sv())).toBe("fresh")
    expect(tldrHead(sv({ state: "outdated", stale: "edited" }))).toBe("stale")
    expect(tldrHead(sv({ error: "x" }))).toBe("stale")
    expect(tldrHead(sv({ state: "none", text: "", error: "x" }))).toBeNull()
    expect(tldrHead(sv({ state: "waiting", text: "" }))).toBeNull()
    expect(tldrHead(sv({ state: "waiting", text: "", old: "Old." }))).toBe("stale")
    expect(tldrHead(sv({ state: "streaming" }))).toBeNull()
    expect(tldrWord(sv())).toBe("summarize")
    expect(tldrWord(sv({ state: "none", text: "" }))).toBe("summarize")
    expect(tldrWord(sv({ state: "outdated", stale: "edited" }))).toBe("refresh")
    expect(tldrWord(sv({ error: "x" }))).toBe("retry")
    expect(tldrWord(sv({ state: "waiting" }))).toBe("cancel")
    expect(tldrWord(sv({ state: "streaming" }))).toBe("cancel")
  })
  test("infoItems puts the block and a blank row before Properties; nothing when AI is off", () => {
    const props: [string, string][] = [["title", "Welcome"]]
    const on = infoItems(props, STATS, [], 30, null, 0, sv({ text: "", state: "none" }))
    expect(on.slice(0, 2).map((i) => i.kind)).toEqual(["foot", "blank"])
    expect(on[2]!.kind).toBe("prop")
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
const idle: ChangeView = {
  state: "idle",
  since: "14:02",
  model: "",
  secs: 0,
  changes: SAMPLE,
  summary: "",
  notes: [],
  error: null,
  open: false,
  ai: true,
  earlier: null,
}
const spanText = (spans: { text: string }[]) => spans.map((s) => s.text).join("")
const rowOf = (it: InfoItem) => spanText(infoSpans(it, themeByName("brothy"), 30)).trimEnd()

describe("changeItems", () => {
  test("idle: the label with D explain, a numbered row per change, counts right-aligned, `new` for an added one", () => {
    const items = changeItems(idle, "Welcome", 30)
    expect(items.map(rowOf)).toEqual([
      "Changed since 14:02  D explain",
      "¹ Why another reader?    +2 −1",
      "² Install on macOS         new",
      "³ Pager notes              −14",
    ])
    const rows = items.filter((i) => i.kind === "change")
    expect(rows.map((i) => [i.stop, i.removed, i.at, i.n])).toEqual([
      [true, false, 0, 1],
      [true, false, 1, 2],
      [false, true, 2, 3],
    ])
  })
  test("the head's count: all changes, muted once explained; null when too large", () => {
    expect(changeHead(idle)).toEqual({ n: 3, muted: false })
    expect(changeHead({ ...idle, state: "result" })).toEqual({ n: 3, muted: true })
    expect(changeHead({ ...idle, state: "large", changes: null })).toEqual({ n: null, muted: false })
    expect(changeHead(null)).toBeNull()
  })
  test("AI off: no D in the label", () => {
    expect(rowOf(changeItems({ ...idle, ai: false }, "W", 30)[0]!)).toBe("Changed since 14:02")
  })
  test("waiting: D cancel, the status row in the summary's place, then the rows", () => {
    const items = changeItems({ ...idle, state: "loading", model: "llama3.2", secs: 3 }, "Welcome", 30)
    expect(items.map(rowOf).slice(0, 3)).toEqual([
      "Changed since 14:02   D cancel",
      "▍ asking llama3.2 · 3 s",
      "¹ Why another reader?    +2 −1",
    ])
    expect(rowOf(changeItems({ ...idle, state: "loading", model: "llama3.2", secs: 0 }, "W", 30)[1]!)).toBe(
      "▍ asking llama3.2",
    )
  })
  test("streaming: the summary so far ends in the caret; a note shows once its line is in", () => {
    const items = changeItems(
      { ...idle, state: "loading", summary: "Adds macOS", notes: [{ what: "feature list trimmed" }] },
      "Welcome",
      30,
    )
    expect(items.map(rowOf).slice(0, 5)).toEqual([
      "Changed since 14:02   D cancel",
      "Adds macOS▍",
      "¹ Why another reader?    +2 −1",
      "  feature list trimmed",
      "² Install on macOS         new",
    ])
  })
  test("result: the model in the label, no D, summary at most 5 rows, notes at most 2 rows hung by 2", () => {
    const long =
      "Adds macOS install steps and drops the old pager notes, then rewrites the intro twice over and again, " +
      "and again, and once more for luck, with a coda."
    const items = changeItems(
      {
        ...idle,
        state: "result",
        model: "claude-haiku-5-5",
        summary: long,
        notes: [
          { what: "feature list trimmed down to the three that matter most" },
          { what: "brew and bun steps" },
          undefined,
        ],
      },
      "Welcome",
      30,
    )
    const rows = items.map(rowOf)
    expect(rows[0]).toBe("Changed since 14:02 · claude-…")
    expect(rows.slice(1, 6).every((r) => r.length > 0)).toBe(true)
    expect(rows[5]!.endsWith("…")).toBe(true)
    expect(rows.slice(6)).toEqual([
      "¹ Why another reader?    +2 −1",
      "  feature list trimmed down to",
      "  the three that matter most",
      "² Install on macOS         new",
      "  brew and bun steps",
      "³ Pager notes              −14",
    ])
    const marks = items.filter((i) => i.kind === "change").map((i) => i.tone)
    expect(marks).toEqual(["explained", "explained", "explained"])
  })
  test("error: D retry, ✗ and the message in at most 2 rows, then the idle rows", () => {
    const items = changeItems(
      { ...idle, state: "error", error: "model “llama3.2” not found · ollama pull llama3.2 first, then retry" },
      "W",
      30,
    )
    expect(items.map(rowOf).slice(0, 4)).toEqual([
      "Changed since 14:02    D retry",
      "✗ model “llama3.2” not found ·",
      "  ollama pull llama3.2 first,…",
      "¹ Why another reader?    +2 −1",
    ])
  })
  test("the label is a stop (it opens the Proof sheet) while there is a list to show, not when too large", () => {
    const stop = (cv: ChangeView) => (changeItems(cv, "W", 30)[0] as Extract<InfoItem, { kind: "changes" }>).stop
    expect(stop(idle)).toBe(true)
    expect(stop({ ...idle, state: "result", summary: "s", model: "m" })).toBe(true)
    expect(stop({ ...idle, changes: [] })).toBe(false)
    expect(stop({ ...idle, state: "large", changes: null })).toBe(false)
  })
  test("too large: the label, then why, in at most 2 rows; no rows", () => {
    expect(changeItems({ ...idle, state: "large", changes: null }, "W", 30).map(rowOf)).toEqual([
      "Changed since 14:02",
      "too many lines changed to",
      "compare; nothing to explain",
    ])
  })
  test("the lead-in is named by the note title", () => {
    expect(changeItems({ ...idle, changes: [chg("edited", "", 1, 0, -1)] }, "Welcome", 30).map(rowOf)[1]).toBe(
      "¹ Welcome" + " ".repeat(19) + "+1",
    )
  })
  test("at most 8 change rows, then a `+ n more` stop that opens them all", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => chg("edited", `S${i}`, 1, 0, i))
    const items = changeItems({ ...idle, changes: many(11) }, "W", 30)
    expect(items.filter((i) => i.kind === "change").length).toBe(MAX_CHANGE_ROWS)
    expect(rowOf(items.at(-1)!)).toBe("+ 3 more sections        ⏎ all")
    expect(rowOf(changeItems({ ...idle, changes: many(9) }, "W", 30).at(-1)!)).toBe("+ 1 more section         ⏎ all")
    const open = changeItems({ ...idle, changes: many(70), open: true }, "W", 30)
    expect(open.filter((i) => i.kind === "change").length).toBe(MAX_CHANGE_ROWS_OPEN)
    expect(rowOf(open.at(-1)!)).toBe("show fewer             ⏎ fewer")
    // a two-digit number: the row stays 30 wide
    expect(spanText(infoSpans(open.find((i) => i.kind === "change" && i.n === 10)!, themeByName("brothy"), 30))).toBe(
      `¹⁰ S9${" ".repeat(23)}+1`,
    )
  })
  test("Earlier: under the rows, dimmed, numbered on, summary at most 2 rows and notes 1, not stops", () => {
    const earlier = {
      since: "13:40",
      model: "llama3.2",
      summary: "The intro was rewritten from scratch, the install steps moved down, and the pager notes went.",
      notes: [{ what: "intro rewritten from scratch again and again" }],
      changes: [chg("edited", "Intro", 4, 4)],
    }
    const items = changeItems({ ...idle, earlier }, "W", 30)
    const at = items.findIndex((i) => i.kind === "earlier")
    expect(items.slice(at).map(rowOf)).toEqual([
      "Earlier 13:40 · llama3.2",
      "The intro was rewritten from",
      "scratch, the install steps…",
      "⁴ Intro                  +4 −4",
      "  intro rewritten from scratc…",
    ])
    expect(items.slice(at).some((i) => i.kind === "change" && i.stop)).toBe(false)
    const c = footInk(themeByName("brothy"))
    expect(infoSpans(items[at + 3]!, themeByName("brothy"), 30).every((s) => !s.fg || s.fg === c.stale)).toBe(true)
    // a result replaces it
    expect(changeItems({ ...idle, state: "result", earlier }, "W", 30).some((i) => i.kind === "earlier")).toBe(false)
  })
  test("narrow: long headings are cut with …, rows never exceed the width", () => {
    const items = changeItems(
      { ...idle, changes: [chg("edited", "A very long heading that cannot fit", 12, 345)] },
      "W",
      20,
    )
    const row = spanText(infoSpans(items[1]!, themeByName("brothy"), 20))
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
    { text: "Sum.", state: "fresh", model: "m", secs: 0, stale: null, old: "", error: null, open: false },
    { view: idle, title: "T" },
  )
  const kinds = items.map((i) => i.kind)
  expect(kinds.indexOf("frule")).toBeLessThan(kinds.indexOf("changes"))
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
    const row = { kind: "change", n: 2, text: "Gone", counts: "−3", at: 0, stop: true, removed: false } as const
    expect(infoSpans({ ...row, tone: "fresh" }, t, 12)).toEqual([
      { text: "²", fg: t.primary },
      { text: " " },
      { text: "Gone", fg: t.text, attr: A.NONE },
      { text: "    " },
      { text: "−3", fg: t.textMuted },
    ])
    const removed = infoSpans({ ...row, tone: "fresh", removed: true, stop: false }, t, 12)
    expect(removed[0]!.fg).toBe(t.textMuted)
    expect(removed[2]).toEqual({ text: "Gone", fg: t.textMuted, attr: A.STRIKE })
    expect(infoSpans({ ...row, tone: "explained" }, t, 12)[0]!.fg).toBe(t.textMuted)
    expect(infoSpans({ kind: "blank" }, t, 20)).toEqual([])
  })
})
