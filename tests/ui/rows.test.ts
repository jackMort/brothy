import { expect, test } from "bun:test"
import { A } from "../../src/lib/spans"
import { themes } from "../../src/theme/theme"
import { artSpans, fitHits, hitSpans, modeSwitch, openItem, padTo, scrim, switchItem } from "../../src/ui/rows"
import { BIG, welcomeArt } from "../../src/ui/welcome"
import { brothy } from "../helpers/theme"

const t = brothy

test("scrim is a dark wash over dark themes and a light wash over light themes", () => {
  for (const t of themes) {
    const { r, g, b, a } = scrim(t)
    expect(a, t.name).toBeGreaterThan(100)
    expect(a, t.name).toBeLessThan(220)
    if (t.mode === "dark") expect([r, g, b]).toEqual([0, 0, 0])
    else expect([r, g, b]).toEqual([255, 255, 255])
  }
})

test("fitHits: the end is cut first; a late match gets a window; wide characters count double", () => {
  expect(fitHits("short", [0], 10)).toEqual({ text: "short", hits: [0] })
  expect(fitHits("abcdefghij", [1, 2], 6)).toEqual({ text: "abcde…", hits: [1, 2] })
  const late = fitHits("abcdefghijklmnopqrst", [15, 16], 8)
  expect(late.text.startsWith("…")).toBe(true)
  expect(late.hits.map((h) => [...late.text][h]).join("")).toBe("pq")
  expect(Bun.stringWidth(late.text)).toBeLessThanOrEqual(8)
  const cjk = fitHits("日本語のテキストと検索", [9, 10], 9)
  expect(cjk.hits.map((h) => [...cjk.text][h]).join("")).toBe("検索")
  expect(Bun.stringWidth(cjk.text)).toBeLessThanOrEqual(9)
})

test("modeSwitch: the active side is a primary chip on backgroundElement, the other muted", () => {
  const segs = modeSwitch(t, "light")
  expect(segs.map((seg) => seg.map((s) => s.text).join(""))).toEqual([" dark ", " light "]) // SWITCH_MODES order, one per chip
  expect(segs[1]!.find((s) => s.text === "light")).toMatchObject({ fg: t.primary, bg: t.backgroundElement, attr: 1 })
  expect(segs[0]!.map((s) => s.fg)).toEqual([t.textMuted])
  expect(segs[0]![0]!.attr).toBeUndefined()
  // a dark-only family: dark is the chip, light muted and struck through
  const only = modeSwitch(t, "dark", "dark")
  expect(only[0]!.find((s) => s.text === "dark")).toMatchObject({ fg: t.primary })
  expect(only[1]).toEqual([{ text: " light ", fg: t.textMuted, attr: A.STRIKE }])
})

test("hitSpans: hits are bold in the hit colour, runs of the same look share a span, `bold` makes the rest bold too", () => {
  expect(hitSpans("abcd", [1, 2], "#111", "#f00")).toEqual([
    { text: "a", fg: "#111", attr: 0 },
    { text: "bc", fg: "#f00", attr: A.BOLD },
    { text: "d", fg: "#111", attr: 0 },
  ])
  expect(hitSpans("ab", [], "#111", "#f00", true)).toEqual([{ text: "ab", fg: "#111", attr: A.BOLD }])
  // indexes are code points, not UTF-16 units
  expect(hitSpans("😀ab", [1], "#111", "#f00").map((s) => s.text)).toEqual(["😀", "a", "b"])
})

test("padTo fills to the width by display width and never cuts", () => {
  expect(padTo([{ text: "ab" }], 5)).toEqual([{ text: "ab" }, { text: "   " }])
  expect(padTo([{ text: "日本" }], 5).map((s) => s.text)).toEqual(["日本", " "])
  expect(padTo([{ text: "abcdef" }], 3)).toEqual([{ text: "abcdef" }, { text: "" }])
})

test("switchItem: a header is a muted bold title with its count, a note row puts the folder on the right", () => {
  expect(switchItem({ kind: "header", title: "Notes", count: "2" }, t)).toEqual({
    header: true,
    spans: [{ text: "Notes", fg: t.textMuted, attr: A.BOLD }],
    right: "2",
  })
  const note = switchItem({ kind: "note", path: "/v/a/b.md", name: "b", folder: "a", hits: [0] }, t, 40)
  expect(note.right).toBe("a")
  expect(note.header).toBeUndefined()
  expect(note.spans.map((s) => s.text).join("")).toBe("b")
  expect(note.spans[0]).toMatchObject({ text: "b", fg: t.primary })
})

test("switchItem: heading and text rows lead with the note name, an alias shows after ←, ask notes are never stops", () => {
  const heading = switchItem(
    { kind: "heading", path: "/v/b.md", name: "b", folder: "", heading: 1, text: "Install", hits: [0, 1] },
    t,
    40,
  )
  expect(heading.spans.map((s) => s.text).join("")).toBe("b › Install")
  const text = switchItem(
    { kind: "text", path: "/v/b.md", name: "b", folder: "x", heading: null, line: 3, context: "some words", hits: [5] },
    t,
    40,
  )
  expect(text.spans.map((s) => s.text).join("")).toBe("b  some words")
  expect(text.right).toBeUndefined()
  const alias = switchItem(
    { kind: "note", path: "/v/b.md", name: "b", folder: "", hits: [], alias: { text: "bee", hits: [0] } },
    t,
    40,
  )
  expect(alias.spans.map((s) => s.text).join("")).toBe("b  ← bee")
  expect(switchItem({ kind: "askNote", text: "searched: x" }, t)).toEqual({
    header: true,
    spans: [{ text: "searched: x", fg: t.textMuted }],
  })
})

test("switchItem: ask rows in theme roles; marks in the padding; never stops", () => {
  const searched = switchItem({ kind: "askNote", text: "a · b", tone: "text", lead: "searched: " }, t)
  expect(searched.spans).toEqual([
    { text: "searched: ", fg: t.textMuted },
    { text: "a · b", fg: t.text },
  ])
  expect(switchItem({ kind: "askNote", text: "no key", tone: "error" }, t).spans[0]!.fg).toBe(t.error)
  const rule = switchItem({ kind: "rule" }, t, 60)
  expect(rule).toEqual({ header: true, spans: [{ text: "─".repeat(16), fg: t.border }] })
  const foot = switchItem({ kind: "footnote", n: 2, text: "six hours for beef bones" }, t, 12)
  expect(foot).toEqual({
    header: true,
    mark: { text: "²", fg: t.primary },
    spans: [{ text: "six hours f…", fg: t.textMuted }],
  })
  const wait = switchItem({ kind: "askWait", text: "asking llama3.2 · 3 s" }, t)
  expect(wait.header).toBe(true)
  expect(wait.spans).toEqual([
    { text: "▍", fg: t.text },
    { text: " asking llama3.2 · 3 s", fg: t.textMuted },
  ])
  const err = switchItem({ kind: "askAction", act: "ask", text: "can't reach h", note: "", error: true }, t)
  expect(err.spans[0]).toEqual({ text: "✗ ", fg: t.error, attr: A.BOLD })
  const head = switchItem({ kind: "header", title: "Answers", count: "3", right: "llama3.2" }, t)
  expect(head.spans.map((x) => x.text).join("")).toBe("Answers  3")
  expect(head.right).toBe("llama3.2")
  const answer = switchItem(
    {
      kind: "answer",
      path: "/v/s.md",
      name: "stock",
      heading: 0,
      text: "How long to simmer",
      key: "how long to simmer",
      ord: 0,
      id: "/v/s.md#how long to simmer#0",
      query: "simmer",
      hits: [12, 13, 14, 15, 16, 17],
      right: "",
      n: 1,
    },
    t,
    40,
  )
  expect(answer.mark).toEqual({ text: "¹", fg: t.primary })
  expect(answer.spans.map((x) => x.text).join("")).toBe("stock › How long to simmer")
})

test("switchItem: a narrow row keeps the match in view and the note name within a quarter", () => {
  const w = 30
  const it = switchItem(
    {
      kind: "heading",
      path: "/v/n.md",
      name: "a-very-long-note-name-indeed",
      folder: "",
      heading: 0,
      text: "x".repeat(50) + "MATCH",
      hits: [50, 51, 52, 53, 54],
    },
    t,
    w,
  )
  const line = it.spans.map((s) => s.text).join("")
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(w)
  expect(line).toContain("MATCH")
  expect(line).toContain("…")
})

test("openItem: recent rows show the name, the ~ path and the last note; missing folders are muted", () => {
  const entry = { root: "/home/me/notes", lastNote: "/home/me/notes/todo.md", top: 0, at: 1 }
  const ok = openItem({ kind: "recent", missing: false, entry, name: "notes", hits: [0], score: 1 }, t, 60, "/home/me")
  expect(ok.spans.map((s) => s.text).join("")).toBe("notes  ~/notes")
  expect(ok.right).toBe("todo")
  const gone = openItem({ kind: "recent", missing: true, entry, name: "notes", hits: [], score: 1 }, t, 60, "/home/me")
  expect(gone.right).toBe("missing")
  expect(gone.spans[0]).toMatchObject({ fg: t.textMuted })
})

test("openItem: path rows mark folders with / and the typed folder as this folder", () => {
  const dir = openItem({ kind: "path", path: "/p/a", name: "a", dir: true, hits: [0], completion: "/p/a/" }, t)
  expect(dir.spans.map((s) => s.text).join("")).toBe("a/")
  expect(dir.right).toBeUndefined()
  const self = openItem({ kind: "path", path: "/p", name: "p", dir: true, hits: [], completion: "/p/", self: true }, t)
  expect(self).toEqual({ spans: [{ text: "/p/", fg: t.text }], right: "this folder" })
  expect(openItem({ kind: "header", title: "Recent", count: "1" }, t).header).toBe(true)
})

test("artSpans: neighbouring cells with the same look share a span; ink 0 and 3 differ only in colour", () => {
  const row = welcomeArt(BIG, 0)[0]!
  for (const ink of [0, 3]) {
    const spans = artSpans(t, row, ink)
    expect(spans.map((s) => s.text).join("")).toBe(row.map((c) => c.ch).join(""))
    expect(spans.length).toBeLessThan(row.length)
  }
  expect(
    artSpans(
      t,
      [
        { ch: "x", role: "none" },
        { ch: "y", role: "none" },
      ],
      3,
    ),
  ).toEqual([{ text: "xy", fg: undefined, bg: undefined }])
})
