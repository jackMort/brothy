import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanTree } from "../src/files"
import type { Stats } from "../src/markdown"
import { extractLinks, findHeading, fmtAge, headingKey, infoItems, linkDest, noteIndex, outlineRows, resolveLink, wrapProperty } from "../src/panel"

const made: string[] = []
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))
function fixture(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "brothy-panel-"))
  made.push(root)
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true })
    writeFileSync(join(root, f), "# x\n")
  }
  return root
}

const STATS: Stats = { words: 1021, lines: 10, headings: 12, links: 0, codeBlocks: 0, tables: 1, tasks: [2, 5], minutes: 5 }

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
    const items = infoItems([], { ...STATS, tables: 0 }, links, 30, { size: 8602, mtime: new Date(now - 3 * 86400e3) }, now)
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
    const items = infoItems([["zeta", "z"], ["date", "d"], ["alpha", "a"], ["title", "t"]], STATS, [], 40, null)
    expect(items.filter((i) => i.kind === "prop" && i.key).map((i) => (i as { key: string }).key)).toEqual(["title", "date", "zeta", "alpha"])
  })
})

describe("links", () => {
  test("extractLinks: aliases, headings, note embeds; not images, code or self links", () => {
    const body = "See [[A]], [[B|alias]], [[C#Heading]], ![[D]], ![[pic.png]], ![[E.md]], [[a]] again, `[[code]]`\n```\n[[fenced]]\n```\n[[#local]]"
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

function vault(files: string[]) {
  const d = mkdtempSync(join(tmpdir(), "brothy-links-"))
  made.push(d)
  for (const f of files) {
    mkdirSync(join(d, f, ".."), { recursive: true })
    writeFileSync(join(d, f), "# x\n")
  }
  return d
}

describe("noteIndex / resolveLink", () => {
  test("exact relative path first, else a unique name", () => {
    const d = vault(["a/index.md", "b/index.md", "a/Note.md", "Top.md", "x/a b.md"])
    const tree = scanTree(d)
    expect(resolveLink("a/index", tree)).toBe(join(d, "a/index.md"))
    expect(resolveLink("note", tree)).toBe(join(d, "a/Note.md"))
    expect(resolveLink("Folder/Top", tree)).toBe(join(d, "Top.md"))
    expect(resolveLink("a b", tree)).toBe(join(d, "x/a b.md"))
    expect(noteIndex(tree)).toBe(noteIndex(tree)) // cached per tree
  })
  test("ambiguous names resolve like Obsidian: a path suffix narrows, then the linking note's folder, then the shortest path", () => {
    const d = vault(["plans/x.md", "specs/x.md", "deep/er/x.md", "p/q/take.md", "r/q/take.md", "r/take.md", "s/u/v.md", "t/u/v.md"])
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
  const d = vault(["dir/a.md", "dir/b c.md", "up.md", "dir/sub/z.md"])
  const tree = scanTree(d)
  const from = join(d, "dir/a.md")
  test("wikilinks resolve by name; same-note heading links stay", () => {
    expect(linkDest({ kind: "wiki", target: "z", heading: "H", embed: false }, from, tree)).toEqual({ path: join(d, "dir/sub/z.md"), heading: "H", label: "z" })
    expect(linkDest({ kind: "wiki", target: "", heading: "Here", embed: false }, from, tree)).toEqual({ path: from, heading: "Here", label: "Here" })
    expect(linkDest({ kind: "wiki", target: "nope", embed: false }, from, tree).path).toBeNull()
  })
  test("an ambiguous wikilink prefers the linking note's folder", () => {
    const v = vault(["one/n.md", "two/n.md"])
    const vt = scanTree(v)
    expect(linkDest({ kind: "wiki", target: "n", embed: false }, join(v, "two/a.md"), vt).path).toBe(join(v, "two/n.md"))
  })
  test("markdown links resolve relative to the note, URL-decoded, with #fragment", () => {
    expect(linkDest({ kind: "md", href: "b%20c.md#Sec" }, from, tree)).toEqual({ path: join(d, "dir/b c.md"), heading: "Sec", label: "b c.md" })
    expect(linkDest({ kind: "md", href: "../up.md" }, from, tree)).toEqual({ path: join(d, "up.md"), label: "../up.md" })
    expect(linkDest({ kind: "md", href: "sub/z" }, from, tree).path).toBe(join(d, "dir/sub/z.md"))
    expect(linkDest({ kind: "md", href: "#local" }, from, tree)).toEqual({ path: from, heading: "local", label: "local" })
    expect(linkDest({ kind: "md", href: "missing.md" }, from, tree).path).toBeNull()
  })
  test("a percent-encoded control character never survives decoding", () => {
    expect(linkDest({ kind: "md", href: "%1b]0;LNKPWN%07.md" }, from, tree)).toEqual({ path: null, label: "\ufffd]0;LNKPWN\ufffd.md" })
  })
  test("URLs are not opened, only reported", () => {
    expect(linkDest({ kind: "url", href: "https://x.y" }, from, tree)).toEqual({ path: null, label: "https://x.y", url: "https://x.y" })
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
