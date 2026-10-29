import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ancestorsOf, findVault, folderCounts, folderOf, fuzzyHits, rankNotes, scanTree, scoreName, stem, visibleRows, type FileNode } from "../src/files"

const made: string[] = []
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))
function fixture(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "brothy-files-"))
  made.push(root)
  for (const f of files) {
    const p = join(root, f)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, "# x\n")
  }
  return root
}
const names = (root: string, max?: number) => {
  const out: string[] = []
  const walk = (n: FileNode) => n.children.forEach((c) => (c.dir ? walk(c) : out.push(c.rel)))
  walk(scanTree(root, 8, max))
  return out
}

describe("symlink loops", () => {
  test("a link back to an ancestor does not duplicate the tree", () => {
    const root = fixture(["docs/a.md"])
    symlinkSync(root, join(root, "docs", "loop"))
    expect(names(root)).toEqual(["docs/a.md"])
  })
  test("two links to each other terminate", () => {
    const root = fixture(["a/x.md", "b/y.md"])
    symlinkSync(join(root, "b"), join(root, "a", "to-b"))
    symlinkSync(join(root, "a"), join(root, "b", "to-a"))
    expect(names(root).sort()).toEqual(["a/x.md", "b/y.md"])
  })
  test("a link to a directory elsewhere in the tree is shown once", () => {
    const root = fixture(["real/r.md"])
    symlinkSync(join(root, "real"), join(root, "alias"))
    expect(names(root)).toEqual(["real/r.md"])
  })
  test("a link to an outside directory is followed", () => {
    const outside = fixture(["o.md"])
    const root = fixture(["a.md"])
    symlinkSync(outside, join(root, "ext"))
    expect(names(root).sort()).toEqual(["a.md", "ext/o.md"])
  })
  test("only links whose target leaves the root are marked outside", () => {
    const outside = fixture(["o.md", "far/f.md"])
    const root = fixture(["a.md"])
    symlinkSync(join(outside, "far"), join(root, "ext"))
    symlinkSync(join(outside, "o.md"), join(root, "out.md"))
    symlinkSync(join(root, "a.md"), join(root, "in.md"))
    const flags = Object.fromEntries(scanTree(root).children.map((c) => [c.rel, !!c.outside]))
    expect(flags).toEqual({ ext: true, "a.md": false, "in.md": false, "out.md": true })
  })
  test("a link to a markdown file still counts as a file; broken links are ignored", () => {
    const root = fixture(["a.md"])
    symlinkSync(join(root, "a.md"), join(root, "b.md"))
    symlinkSync(join(root, "missing"), join(root, "dangling"))
    expect(names(root).sort()).toEqual(["a.md", "b.md"])
  })
})

describe("names from disk", () => {
  test("control characters in file and folder names are replaced for display; the path stays raw", () => {
    const root = fixture(["dir\x1b[41mBG/evil\x1b]0;PWNED\x07.md", "plain.md"])
    const tree = scanTree(root)
    const dir = tree.children.find((c) => c.dir)!
    expect(dir.name).toBe("dir\ufffd[41mBG")
    expect(dir.children[0]!.name).toBe("evil\ufffd]0;PWNED\ufffd.md")
    expect(dir.children[0]!.rel).toBe(join("dir\ufffd[41mBG", "evil\ufffd]0;PWNED\ufffd.md"))
    expect(dir.children[0]!.path).toBe(join(root, "dir\x1b[41mBG/evil\x1b]0;PWNED\x07.md"))
    expect(tree.children.find((c) => !c.dir)!.name).toBe("plain.md")
  })
})

describe("skip rules", () => {
  test("only node_modules and dot-dirs are skipped, at any depth", () => {
    const root = fixture([
      "node_modules/p/README.md",
      "pkg/node_modules/q.md",
      ".git/g.md",
      ".hidden/h.md",
      ".github/gh.md",
      "build/b.md",
      "docs/dist/d.md",
      "vendor/v.md",
      "target/t.md",
    ])
    expect(names(root).sort()).toEqual([".github/gh.md", "build/b.md", "docs/dist/d.md", "target/t.md", "vendor/v.md"])
  })
})

describe("scan cap", () => {
  test("stops after the entry limit and flags truncation", () => {
    const root = fixture(Array.from({ length: 60 }, (_, i) => `f${i}.md`))
    const tree = scanTree(root, 8, 10)
    expect(tree.children.length).toBeLessThanOrEqual(10)
    expect(tree.truncated).toBe(true)
  })
  test("a small tree is not flagged", () => {
    const tree = scanTree(fixture(["a.md", "d/b.md"]))
    expect(tree.truncated).toBeFalsy()
  })
  test("cap applies across directories", () => {
    const root = fixture(Array.from({ length: 30 }, (_, i) => `d${i}/f.md`))
    expect(names(root, 20).length).toBeLessThan(30)
  })
})

describe("visibleRows", () => {
  test("folders start closed; expanded ones show their children", () => {
    const tree = scanTree(fixture(["a/b/c.md", "a/d.md", "e.md"]))
    const show = (exp: string[]) =>
      visibleRows(tree, new Set(exp.map((p) => join(tree.path, p)))).map((r) => `${r.depth}:${r.node.rel}`)
    expect(show([])).toEqual(["0:a", "0:e.md"])
    expect(show(["a"])).toEqual(["0:a", "1:a/b", "1:a/d.md", "0:e.md"])
    expect(show(["a", "a/b"])).toEqual(["0:a", "1:a/b", "2:a/b/c.md", "1:a/d.md", "0:e.md"])
    expect(show(["a/b"])).toEqual(["0:a", "0:e.md"]) // a closed parent hides an open child
  })
})

describe("ancestorsOf / folderCounts / stem", () => {
  test("ancestorsOf lists the folders holding a note, outermost first", () => {
    const tree = scanTree(fixture(["a/b/c.md", "ab/x.md"]))
    const r = tree.path
    expect(ancestorsOf(tree, join(r, "a/b/c.md"))).toEqual([join(r, "a"), join(r, "a/b")])
    expect(ancestorsOf(tree, join(r, "ab/x.md"))).toEqual([join(r, "ab")]) // "a" is not a folder of "ab/…"
    expect(ancestorsOf(tree, join(r, "top.md"))).toEqual([])
    expect(ancestorsOf(tree, "/elsewhere/n.md")).toEqual([])
  })
  test("folderCounts counts notes recursively, memoized per tree", () => {
    const tree = scanTree(fixture(["a/b/c.md", "a/d.md", "e.md"]))
    const m = folderCounts(tree)
    expect(m.get(tree.path)).toBe(3)
    expect(m.get(join(tree.path, "a"))).toBe(2)
    expect(m.get(join(tree.path, "a/b"))).toBe(1)
    expect(folderCounts(tree)).toBe(m)
  })
  test("stem drops Markdown extensions only", () => {
    expect(stem("README.md")).toBe("README")
    expect(stem("x.MARKDOWN")).toBe("x")
    expect(stem("a.txt")).toBe("a.txt")
  })
})

describe("fuzzyHits", () => {
  test("indexes code points, case-folded, tightened to the shortest span", () => {
    expect(fuzzyHits("a😀b", "😀b")).toEqual([1, 2])
    expect(fuzzyHits("Anise Loaf", "al")).toEqual([0, 6])
    expect(fuzzyHits("xaxab", "ab")).toEqual([3, 4])
    expect(fuzzyHits("ÄBC", "äc")).toEqual([0, 2])
    expect(fuzzyHits("abc", "")).toEqual([])
    expect(fuzzyHits("ab", "😀")).toBeNull()
    expect(fuzzyHits("abc", "ca")).toBeNull()
  })
})

describe("rankNotes", () => {
  test("name beats alias beats folder path; an alias hit carries the alias and its hits", () => {
    const tree = scanTree(fixture(["kafka.md", "Streams.md", "kafka-notes/x.md"]))
    const aliases = (n: FileNode) => (n.name === "Streams.md" ? ["Apache Kafka"] : [])
    const r = rankNotes(tree, "kafka", 10, aliases).rows
    expect(r.map((x) => x.node.rel)).toEqual(["kafka.md", "Streams.md", "kafka-notes/x.md"])
    expect(r[1]!.hits).toEqual([])
    expect(r[1]!.alias).toEqual({ text: "Apache Kafka", hits: [7, 8, 9, 10, 11] })
    expect(r[0]!.alias).toBeUndefined()
  })
  test("the best alias wins; a substring alias beats a subsequence alias; no callback, no aliases", () => {
    const tree = scanTree(fixture(["one.md", "two.md"]))
    const aliases = (n: FileNode) => (n.name === "one.md" ? ["q-u-e-ue", "queue"] : ["qxuxexuxe"])
    const r = rankNotes(tree, "queue", 10, aliases).rows
    expect(r.map((x) => [x.node.name, x.alias?.text])).toEqual([["one.md", "queue"], ["two.md", "qxuxexuxe"]])
    expect(rankNotes(tree, "queue").total).toBe(0)
  })
  test("scoreName: substring before subsequence, code-point hits", () => {
    expect(scoreName("Łódź notes", "dź")).toEqual({ hits: [2, 3], score: 3e6 - 2 })
    expect(scoreName("abc", "ac")!.hits).toEqual([0, 2])
    expect(scoreName("abc", "x")).toBeNull()
    expect(scoreName("abc", "  ")).toBeNull()
  })
  test("substring > tight subsequence > loose subsequence > folder-only; ties by length, then name", () => {
    const tree = scanTree(fixture(["poc.md", "zz/porch.md", "p-o-c.md", "poc/notes.md", "spoc.md", "pocket.md"]))
    expect(rankNotes(tree, "poc").rows.map((r) => r.node.rel)).toEqual([
      "poc.md",
      "pocket.md",
      "spoc.md",
      "zz/porch.md",
      "p-o-c.md",
      "poc/notes.md",
    ])
  })
  test("hits index the name without extension; limit caps the rows, total counts all", () => {
    const tree = scanTree(fixture(["Alpha.md", "alps.md", "b/alpine.md"]))
    const r = rankNotes(tree, "AL", 2)
    expect(r.total).toBe(3)
    expect(r.rows.length).toBe(2)
    expect(r.rows[0]!.node.name).toBe("alps.md")
    expect(r.rows[0]!.hits).toEqual([0, 1])
  })
  test("a blank query matches nothing (the tree is shown instead)", () => {
    expect(rankNotes(scanTree(fixture(["a.md"])), "  ").total).toBe(0)
  })
})

describe("findVault", () => {
  test("the nearest folder at or above `dir` holding .obsidian/", () => {
    const root = fixture(["Journal/2024/a.md", "b.md"])
    mkdirSync(join(root, ".obsidian"))
    expect(findVault(join(root, "Journal/2024"))).toBe(root)
    expect(findVault(root)).toBe(root)
  })
  test("null outside a vault; a .obsidian file does not count", () => {
    const root = fixture(["x/a.md", ".obsidian"])
    expect(findVault(join(root, "x"))).toBeNull()
  })
})

describe("non-UTF-8 names", () => {
  test("a name that is not valid UTF-8 is skipped, a literal U+FFFD name stays", () => {
    const root = fixture(["ok.md", "\uFFFDreal.md"])
    try {
      writeFileSync(Buffer.concat([Buffer.from(root + "/"), Buffer.from([0xe9]), Buffer.from("t\u00e9.md")]), "x")
    } catch {
      return // the filesystem refuses raw bytes
    }
    expect(names(root)).toEqual(["ok.md", "\uFFFDreal.md"])
  })
})

test("folderOf is the last folder of a note's relative path, empty at the root", () => {
  expect(folderOf({ rel: join("notes", "deep", "a.md") })).toBe("deep")
  expect(folderOf({ rel: join("notes", "a.md") })).toBe("notes")
  expect(folderOf({ rel: "a.md" })).toBe("")
})
