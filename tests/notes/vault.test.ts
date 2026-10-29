import { describe, expect, test } from "bun:test"
import type { FileNode } from "../../src/notes/files"
import {
  BODY_LIMIT,
  CHUNK,
  SWITCH_CAP,
  emptyIndex,
  firstHit,
  foldSame,
  headingAt,
  hitOrdinal,
  indexNote,
  isStop,
  lineOf,
  nextSection,
  notesOf,
  recentSection,
  refreshIndex,
  remember,
  searchVault,
  stepRow,
  switchRows,
  type IndexIO,
  type SwitchHit,
  type SwitchRow,
} from "../../src/notes/vault"

/** An in-memory tree under /v from "dir/name.md" paths (folders created on the way). */
export function treeOf(rels: string[]): FileNode {
  const root: FileNode = { name: "v", path: "/v", rel: "", dir: true, children: [] }
  for (const rel of rels) {
    const parts = rel.split("/")
    let dir = root
    parts.slice(0, -1).forEach((p, k) => {
      const r = parts.slice(0, k + 1).join("/")
      let d = dir.children.find((c) => c.dir && c.rel === r)
      if (!d) dir.children.push((d = { name: p, path: "/v/" + r, rel: r, dir: true, children: [] }))
      dir = d
    })
    dir.children.push({ name: parts.at(-1)!, path: "/v/" + rel, rel, dir: false, children: [] })
  }
  return root
}
/** IO over a map of "rel" → source; `mtimes` overrides the default mtime 1; `reads` logs every read. */
export function memIO(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  const reads: string[] = []
  const io: IndexIO = {
    stat: (p) => {
      const rel = p.slice(3)
      return rel in files ? { mtime: mtimes[rel] ?? 1, size: files[rel]!.length } : null
    },
    read: async (p) => {
      const rel = p.slice(3)
      reads.push(rel)
      if (files[rel] === undefined) throw new Error("gone")
      return files[rel]!
    },
  }
  return { io, reads }
}

describe("indexNote", () => {
  test("aliases (list or scalar), outline headings with lines, searchable text without fences or front matter", () => {
    const src = "---\naliases: [Kafka, Streams]\n---\n# Top\nbody line\n```\nsecret code\n```\n## Sub\n%% hidden %%\nend\n"
    const d = indexNote(src, 5, src.length)
    expect(d.aliases).toEqual(["Kafka", "Streams"])
    expect(d.headings).toEqual([{ text: "Top", line: 3, depth: 1 }, { text: "Sub", line: 8, depth: 2 }])
    expect(d.text).not.toContain("secret")
    expect(d.text).not.toContain("hidden")
    expect(d.text).not.toContain("aliases")
    expect(d.text.split("\n")[4]).toBe("body line")
    expect(d.starts[4]).toBe(d.text.indexOf("body line"))
    expect(indexNote("---\nalias: Solo\n---\n", 1, 1).aliases).toEqual(["Solo"])
  })
  test("headingAt / lineOf: the section of a source line and the line of a text offset", () => {
    const d = indexNote("lead\n# A\nx\n## B\ny\n", 1, 1)
    expect(d.headings.map((h) => h.depth)).toEqual([1, 2])
    expect(headingAt(d.headings, 0)).toBeNull()
    expect(headingAt(d.headings, 2)).toBe(0)
    expect(headingAt(d.headings, 4)).toBe(1)
    expect(lineOf(d.starts, d.text.indexOf("y"))).toBe(4)
  })
  test("over BODY_LIMIT: name and headings only", () => {
    const d = indexNote("# Big\nneedle\n", 1, BODY_LIMIT + 1)
    expect(d.headings).toEqual([{ text: "Big", line: 0, depth: 1 }])
    expect(d.text).toBe("")
  })
  test("foldSame keeps the length, so offsets carry over", () => {
    expect(foldSame("ŁÓDŹ Abc")).toBe("łódź abc")
    const s = "İstanbul X"
    expect(foldSame(s).length).toBe(s.length)
    expect(foldSame(s).indexOf("x")).toBe(s.indexOf("X"))
  })
})

describe("refreshIndex", () => {
  test("indexes every note once; unchanged files are not re-read; a changed mtime re-reads one", async () => {
    const tree = treeOf(["a.md", "d/b.md"])
    const files = { "a.md": "# A\n", "d/b.md": "# B\n" }
    const ix = emptyIndex()
    const one = memIO(files)
    expect(await refreshIndex(ix, tree, one.io)).toBe(true)
    expect(one.reads.sort()).toEqual(["a.md", "d/b.md"])
    const two = memIO(files, { "d/b.md": 2 })
    await refreshIndex(ix, tree, two.io)
    expect(two.reads).toEqual(["d/b.md"])
    expect(notesOf(tree).map((n) => n.rel)).toEqual(["a.md", "d/b.md"])
  })
  test("notes gone from the tree or unreadable are dropped; the rest index", async () => {
    const ix = emptyIndex()
    await refreshIndex(ix, treeOf(["a.md", "b.md"]), memIO({ "a.md": "# A\n", "b.md": "# B\n" }).io)
    const { io } = memIO({ "a.md": "# A2\n" })
    io.stat = () => ({ mtime: 9, size: 1 }) // every note stats as changed; b and c have no content, so their reads throw
    await refreshIndex(ix, treeOf(["a.md", "b.md", "c.md"]), io)
    expect([...ix.docs.keys()]).toEqual(["/v/a.md"])
    expect(ix.docs.get("/v/a.md")!.headings[0]!.text).toBe("A2")
  })
  test("progress every CHUNK reads; live() turning false stops the build", async () => {
    const rels = Array.from({ length: CHUNK + 5 }, (_, i) => `n${String(i).padStart(2, "0")}.md`)
    const files = Object.fromEntries(rels.map((r) => [r, "# h\n"]))
    const ix = emptyIndex()
    let alive = true
    const seen: [number, number][] = []
    const ok = await refreshIndex(ix, treeOf(rels), memIO(files).io, (d, n) => {
      seen.push([d, n])
      alive = false
    }, () => alive)
    expect(ok).toBe(false)
    expect(seen).toEqual([[CHUNK, CHUNK + 5]])
    expect(ix.docs.size).toBe(CHUNK)
  })
})

async function indexed(files: Record<string, string>) {
  const tree = treeOf(Object.keys(files))
  const ix = emptyIndex()
  await refreshIndex(ix, tree, memIO(files).io)
  return { tree, ix }
}
const titles = (secs: { title: string }[]) => secs.map((s) => s.title)

describe("searchVault", () => {
  test("Notes: name, then alias (labelled), then folder path; the folder tells same-named notes apart", async () => {
    const { tree, ix } = await indexed({
      "kafka.md": "x",
      "Streams.md": "---\naliases: [Apache Kafka]\n---\n",
      "kafka-notes/index.md": "x",
      "a/index.md": "x",
      "b/index.md": "x",
    })
    const notes = searchVault(ix, tree, "kafka")[0]!
    expect(notes.title).toBe("Notes")
    expect(notes.hits.map((h) => h.name)).toEqual(["kafka", "Streams", "index"])
    expect(notes.hits[1]).toMatchObject({ kind: "note", alias: { text: "Apache Kafka" } })
    const idx = searchVault(ix, tree, "index")[0]!.hits
    expect(idx.map((h) => h.folder).sort()).toEqual(["a", "b", "kafka-notes"])
  })
  test("without an index only Notes answer (aliases unknown yet)", () => {
    const tree = treeOf(["kafka.md"])
    expect(titles(searchVault(null, tree, "kafka"))).toEqual(["Notes"])
  })
  test("Headings: Note › Heading with its outline index; substring before subsequence", async () => {
    const { tree, ix } = await indexed({ "s.md": "# Intro\n## Set up the cluster\n## Setup\n" })
    const hs = searchVault(ix, tree, "setup").find((s) => s.title === "Headings")!.hits
    expect(hs.map((h) => [h.name, h.kind === "heading" && h.text, h.kind === "heading" && h.heading])).toEqual([
      ["s", "Setup", 2],
      ["s", "Set up the cluster", 1],
    ])
  })
  test("Text: ≥ 3 characters, one hit per line, at most 3 per note, fences and front matter skipped", async () => {
    const body = "---\nk: needle\n---\n# A\nneedle 1\n```\nneedle code\n```\nneedle 2 needle\nneedle 3\nneedle 4\n"
    const { tree, ix } = await indexed({ "n.md": body })
    expect(titles(searchVault(ix, tree, "ne"))).toEqual([])
    const text = searchVault(ix, tree, "NEEDLE").find((s) => s.title === "Text")!
    expect(text.hits.map((h) => h.kind === "text" && h.context)).toEqual(["needle 1", "needle 2 needle", "needle 3"])
    expect(text.hits.map((h) => h.kind === "text" && h.line)).toEqual([4, 8, 9])
    expect(text.hits.every((h) => h.kind === "text" && h.heading === 0)).toBe(true)
  })
  test("Text: context keeps 20 code points before the match, marks the cut, and hits point at the match", async () => {
    const { tree, ix } = await indexed({ "c.md": "x".repeat(30) + " Łódź İ needle\n" })
    const h = searchVault(ix, tree, "łódź")!.find((s) => s.title === "Text")!.hits[0]!
    if (h.kind !== "text") throw new Error("text hit expected")
    expect(h.context.startsWith("…")).toBe(true)
    expect([...h.context].filter((_, i) => h.hits.includes(i)).join("")).toBe("Łódź")
    const n = searchVault(ix, tree, "needle").find((s) => s.title === "Text")!.hits[0]!
    if (n.kind !== "text") throw new Error("text hit expected")
    expect([...n.context].filter((_, i) => n.hits.includes(i)).join("")).toBe("needle")
  })
  test("Text: the open note first, a section before any heading is null, the cap reads 50+", async () => {
    const files: Record<string, string> = { "z.md": "needle\n# H\n" }
    for (let i = 0; i < 20; i++) files[`m${i}.md`] = "needle a\nneedle b\nneedle c\n"
    const { tree, ix } = await indexed(files)
    const text = searchVault(ix, tree, "needle", "/v/z.md").find((s) => s.title === "Text")!
    expect(text.hits[0]).toMatchObject({ path: "/v/z.md", heading: null })
    expect(text.hits.length).toBe(SWITCH_CAP.text)
    expect(text.count).toBe("50+")
  })
})

describe("recents and rows", () => {
  test("ask rows: askNote is never a stop (like a header); answers and actions are", () => {
    const rows: SwitchRow[] = [
      { kind: "askNote", text: "asking…" },
      { kind: "header", title: "Answers", count: "1" },
      { kind: "answer", path: "/v/a.md", name: "a", heading: 0, text: "A", key: "a", ord: 0, id: "/v/a.md#a#0", query: "a", hits: [0], right: "1/1" },
      { kind: "askAction", act: "rerank", text: "↻ rerank with excerpts", note: " · ~1k tokens" },
      { kind: "askNote", text: "searched: a" },
    ]
    expect(rows.map(isStop)).toEqual([false, false, true, true, false])
    expect(firstHit(rows)).toBe(2)
    expect(stepRow(rows, 2, 1)).toBe(3)
    expect(stepRow(rows, 3, 1)).toBe(3)
    expect(stepRow(rows, 2, -1)).toBe(2)
    const note: SwitchRow[] = [{ kind: "askNote", text: "type a question" }]
    expect(firstHit(note)).toBe(-1)
  })
  test("recentSection: newest first, then the open note's folder-mates; the open note and vanished paths left out", () => {
    const tree = treeOf(["d/a.md", "d/b.md", "d/c.md", "e/x.md"])
    const sec = recentSection(tree, ["/v/e/x.md", "/v/d/a.md", "/v/gone.md"], "/v/d/a.md")
    expect(sec[0]!.title).toBe("Recent")
    expect(sec[0]!.hits.map((h) => h.path)).toEqual(["/v/e/x.md", "/v/d/b.md", "/v/d/c.md"])
    expect(recentSection(treeOf(["a.md"]), [], "/v/a.md")).toEqual([])
  })
  test("remember moves a path to the front, capped, and keeps the array when nothing changes", () => {
    const r = ["/a", "/b"]
    expect(remember(r, "/b")).toEqual(["/b", "/a"])
    expect(remember(r, "/a")).toBe(r)
    expect(remember(r, null)).toBe(r)
    expect(remember(["/1", "/2", "/3"], "/4", 3)).toEqual(["/4", "/1", "/2"])
  })
  test("rows: a header before each section; moves skip headers and stop at the ends; tab wraps", () => {
    const hit = (path: string) => ({ kind: "note" as const, path, name: path, folder: "", hits: [] })
    const rows = switchRows([
      { title: "Notes", count: "2", hits: [hit("a"), hit("b")] },
      { title: "Text", count: "1", hits: [hit("c")] },
    ])
    expect(rows.map((r) => (r.kind === "header" ? "#" + r.title : "path" in r ? r.path : ""))).toEqual(["#Notes", "a", "b", "#Text", "c"])
    expect(firstHit(rows)).toBe(1)
    expect(stepRow(rows, 2, 1)).toBe(4)
    expect(stepRow(rows, 4, 1)).toBe(4)
    expect(stepRow(rows, 1, -1)).toBe(1)
    expect(nextSection(rows, 1)).toBe(4)
    expect(nextSection(rows, 4)).toBe(1)
    expect(firstHit([])).toBe(-1)
  })
})

describe("text without headings or inline marks", () => {
  const textOf = async (body: string, q: string) => {
    const { tree, ix } = await indexed({ "n.md": body })
    return searchVault(ix, tree, q).find((s) => s.title === "Text")?.hits ?? []
  }
  const shown = (h: SwitchHit) => {
    if (h.kind !== "text") throw new Error("text hit expected")
    return { context: h.context, hit: [...h.context].filter((_, i) => h.hits.includes(i)).join("") }
  }
  test("heading lines (ATX, quoted, setext with its underline) are not text hits", async () => {
    const hits = await textOf("# Needle head\nneedle body\n> ## needle quoted\n\nSetext needle\n===\n", "needle")
    expect(hits.map((h) => shown(h).context)).toEqual(["needle body"])
  })
  test("context drops *, _, `, ==, heading # and shows wikilinks by their label; hits stay on the match", async () => {
    const body = "Some **bold needle** and `code` ==hi== [[dir/target|Alias]] [[Plain#Sec]] snake_case_x 2 * 3 _em_\n"
    const [h] = await textOf(body, "needle")
    expect(shown(h!)).toEqual({ context: "Some bold needle and code hi Alias Plain › Sec snake_case_x 2 * 3 em", hit: "needle" })
    const [k] = await textOf(body, "alias plain")
    expect(shown(k!).hit).toBe("Alias Plain")
  })
  test("a link URL stays searchable (only the listed marks are stripped)", async () => {
    const [h] = await textOf("see [x](http://zzqx.example)\n", "zzqx")
    expect(shown(h!).hit).toBe("zzqx")
  })
  test("heading rows are already plain text", () => {
    expect(indexNote("## **Bold** `c` ==h== [[n|Alias]]\n", 1, 1).headings[0]!.text).toBe("Bold c h Alias")
  })
})

describe("hitOrdinal", () => {
  test("earlier matches in the hit's section: its heading's title, then one per earlier line", () => {
    const doc = indexNote("intro needle\n\n# One\n\nneedle a\n\n# Two Needles\n\nneedle b\nnot here\nNEEDLE c needle\n", 0, 0)
    const hit = (line: number, heading: number | null) => ({ kind: "text" as const, path: "", name: "", folder: "", line, heading, context: "", hits: [] })
    expect(hitOrdinal(doc, hit(0, null), "needle")).toBe(0)
    expect(hitOrdinal(doc, hit(4, 0), "needle")).toBe(0)
    expect(hitOrdinal(doc, hit(8, 1), "needle")).toBe(1) // the heading "Two Needles"
    expect(hitOrdinal(doc, hit(10, 1), " Needle ")).toBe(2)
  })
})
