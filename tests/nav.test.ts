import { describe, expect, test } from "bun:test"
import { cached, copiedCount, findItems, findQuote, matchHits, selectedText, linkLabels, narrowLabels, overlayAt, visibleLinks, findLines, keepVisible, markMatches, matchIndex, matchKey, matchRanges, relocate, remapTop, stepMatch, stripLayout, thumb } from "../src/nav"
import { themes } from "../src/theme"

const t = themes[0]!

test("stepMatch continues from the current match, not the viewport top", () => {
  const m = [50, 60, 70]
  // match 50 was placed a third of the way down (top 44)
  expect(stepMatch(m, 50, 44, 19, 1)).toBe(60)
  expect(stepMatch(m, 60, 54, 19, 1)).toBe(70)
  expect(stepMatch(m, 60, 54, 19, -1)).toBe(50)
})

test("stepMatch wraps around both ends", () => {
  expect(stepMatch([5, 9], 9, 0, 19, 1)).toBe(5)
  expect(stepMatch([5, 9], 5, 0, 19, -1)).toBe(9)
})

test("stepMatch advances past matches clamped into the first screen", () => {
  expect(stepMatch([2, 4, 100], 2, 0, 19, 1)).toBe(4)
  expect(stepMatch([2, 4, 100], 4, 0, 19, 1)).toBe(100)
})

test("stepMatch searches from the viewport when the current match scrolled away", () => {
  expect(stepMatch([10, 80, 120], 10, 70, 19, 1)).toBe(80)
  expect(stepMatch([10, 80, 120], 10, 70, 19, -1)).toBe(10)
  expect(stepMatch([10, 80, 120], null, 0, 19, 1)).toBe(10)
  expect(stepMatch([], null, 0, 19, 1)).toBeUndefined()
})

test("matchRanges is case-insensitive and offsets index the original string", () => {
  expect(matchRanges("Foo foo FOO", "fOo")).toEqual([
    [0, 3],
    [4, 7],
    [8, 11],
  ])
  // "İ".toLowerCase() is two code units; offsets must not shift
  expect(matchRanges("İx foo", "foo")).toEqual([[3, 6]])
  expect(matchRanges("a.b axb", ".")).toEqual([[1, 2]])
  expect(matchRanges("abc", "")).toEqual([])
})

test("markMatches paints exactly the matched text", () => {
  const out = markMatches([{ text: "İx f" }, { text: "oo bar" }], "foo", t)
  const hit = out.filter((s) => s.bg === t.secondary).map((s) => s.text)
  expect(hit).toEqual(["f", "oo"])
  expect(out.map((s) => s.text).join("")).toBe("İx foo bar")
})

test("findLines lists matching line indexes", () => {
  expect(findLines(["Alpha", "beta", "ALPHABET"], "alpha")).toEqual([0, 2])
  expect(findLines(["a b"], "a b")).toEqual([0])
})

test("remapTop keeps the position inside the same section", () => {
  const a = { heads: [0, 10, 20], total: 30 }
  expect(remapTop(15, a, a)).toBe(15)
  expect(remapTop(15, a, { heads: [0, 20, 40], total: 60 })).toBe(30)
  expect(remapTop(2, { heads: [5], total: 10 }, { heads: [10], total: 20 })).toBe(4)
})

test("remapTop falls back to a document fraction when headings differ", () => {
  expect(remapTop(50, { heads: [0], total: 100 }, { heads: [0, 5], total: 200 })).toBe(100)
  expect(remapTop(0, { heads: [], total: 0 }, { heads: [], total: 40 })).toBe(0)
})

test("relocate puts the cursor back on a preferred path and keeps it visible", () => {
  const paths = ["a", "b", "c", "d", "e", "f"]
  expect(relocate(paths, [null, "e"], 0, 0, 3)).toEqual({ cursor: 4, sideTop: 2 })
  expect(relocate(paths, ["b", "e"], 5, 3, 3)).toEqual({ cursor: 1, sideTop: 1 })
})

test("relocate clamps when nothing preferred survives", () => {
  expect(relocate(["a", "b"], ["zz"], 7, 5, 3)).toEqual({ cursor: 1, sideTop: 0 })
  expect(relocate([], ["zz"], 7, 5, 3)).toEqual({ cursor: 0, sideTop: 0 })
})

test("matchKey distinguishes shift and ctrl variants", () => {
  const k = (name: string, o: Partial<{ ctrl: boolean; shift: boolean; meta: boolean; sequence: string }> = {}) => ({
    name,
    ctrl: false,
    shift: false,
    meta: false,
    sequence: name,
    ...o,
  })
  expect(matchKey("g", k("g"))).toBe(true)
  expect(matchKey("g", k("g", { shift: true }))).toBe(false)
  expect(matchKey("S-g", k("g", { shift: true }))).toBe(true)
  expect(matchKey("C-d", k("d", { ctrl: true }))).toBe(true)
  expect(matchKey("d", k("d", { ctrl: true }))).toBe(false)
  expect(matchKey("?", k("/", { shift: true, sequence: "?" }))).toBe(true)
  expect(matchKey("down", k("down"))).toBe(true)
})

test("cached recomputes only when an argument changes", () => {
  let calls = 0
  const f = cached((a: number, b: object) => (calls++, a))
  const o = {}
  f(1, o)
  f(1, o)
  expect(calls).toBe(1)
  f(1, {})
  f(2, {})
  expect(calls).toBe(3)
})

test("keepVisible scrolls a list window only as far as needed", () => {
  expect(keepVisible(0, 3, 5, 20)).toBe(0)
  expect(keepVisible(0, 7, 5, 20)).toBe(3)
  expect(keepVisible(10, 4, 5, 20)).toBe(4)
  expect(keepVisible(30, 19, 5, 20)).toBe(15)
  expect(keepVisible(3, 0, 5, 2)).toBe(0)
})

test("thumb is null when the rows fit, and spans the track from end to end", () => {
  expect(thumb(0, 10, 10)).toBeNull()
  expect(thumb(0, 10, 5)).toBeNull()
  expect(thumb(0, 10, 40)).toEqual({ start: 0, size: 3 })
  expect(thumb(15, 10, 40)).toEqual({ start: 4, size: 3 })
  expect(thumb(30, 10, 40)).toEqual({ start: 7, size: 3 })
  expect(thumb(99, 10, 40)).toEqual({ start: 7, size: 3 }) // top is clamped
  expect(thumb(0, 10, 1000)).toEqual({ start: 0, size: 1 })
})

test("stripLayout: superscript digits against the labels, three-space gaps from 30 columns, two below", () => {
  const full = stripLayout(32)
  expect(full.compact).toBe(false)
  expect(full.labels.map((l) => [l.view, l.digit, l.text, l.x0, l.lx, l.x1])).toEqual([
    ["files", "¹", "Files", 1, 2, 7],
    ["outline", "²", "Outline", 10, 11, 18],
    ["info", "³", "Info", 21, 22, 26],
  ])
  expect(stripLayout(30).compact).toBe(false)
  const c = stripLayout(29)
  expect(c.compact).toBe(true)
  expect(c.labels.map((l) => [l.digit, l.x0, l.lx, l.x1])).toEqual([["¹", 1, 2, 7], ["²", 9, 10, 17], ["³", 19, 20, 24]])
  // the narrowest panel (24 columns) still fits the compact strip
  expect(stripLayout(24).labels.at(-1)!.x1).toBeLessThanOrEqual(24)
})

test("matchIndex is 1-based and null when unset or stale", () => {
  expect(matchIndex([3, 8, 20], 8)).toBe(2)
  expect(matchIndex([3, 8, 20], null)).toBeNull()
  expect(matchIndex([3, 8, 20], 9)).toBeNull()
  expect(matchIndex([], 3)).toBeNull()
})
describe("link labels", () => {
  const row = (...parts: [string, number?][]) => ({ spans: parts.map(([text, link]) => (link === undefined ? { text } : { text, link })) })
  test("visibleLinks: column of the first cell, top-to-bottom, left-to-right", () => {
    const lines = [row(["see "], ["b", 0], [" and "], ["Sea", 1]), row(["é "], ["x", 2])]
    expect(visibleLinks(lines, 0, 5)).toEqual([
      { link: 0, row: 0, col: 4 },
      { link: 1, row: 0, col: 10 },
      { link: 2, row: 1, col: 2 },
    ])
  })
  test("a wrapped link is labelled once, on its first visible row", () => {
    const lines = [row(["aa "], ["one two", 0]), row(["three", 0], [" z"]), row(["q"])]
    expect(visibleLinks(lines, 0, 3)).toEqual([{ link: 0, row: 0, col: 3 }])
    expect(visibleLinks(lines, 1, 3)).toEqual([{ link: 0, row: 1, col: 0 }])
    expect(visibleLinks(lines, 2, 3)).toEqual([])
  })
  test("linkLabels: single keys up to the alphabet, then two-key labels; prefix-free", () => {
    expect(linkLabels(3)).toEqual(["a", "s", "d"])
    expect(linkLabels(12)).toHaveLength(12)
    const many = linkLabels(13)
    expect(many).toHaveLength(13)
    expect(many.every((l) => l.length === 2)).toBe(true)
    expect(many[0]).toBe("aa")
    expect(new Set(linkLabels(144)).size).toBe(144)
    expect(linkLabels(200)).toHaveLength(144) // more links than labels: the rest go unlabelled
    for (const set of [linkLabels(12), linkLabels(40)])
      for (const a of set) for (const b of set) if (a !== b) expect(b.startsWith(a)).toBe(false)
  })
  test("narrowLabels keeps labels starting with what was typed", () => {
    const ls = ["aa", "as", "sa"]
    expect(narrowLabels(ls, "a")).toEqual([0, 1])
    expect(narrowLabels(ls, "as")).toEqual([1])
    expect(narrowLabels(ls, "x")).toEqual([])
  })
  test("overlayAt replaces cells and keeps the row width", () => {
    const st = { fg: "#000", bg: "#ff0" }
    const out = overlayAt([{ text: "see " }, { text: "Sea", link: 1 }], 4, "s", st)
    expect(out.map((s) => s.text).join("")).toBe("see sea")
    expect(out.find((s) => s.bg === "#ff0")!.text).toBe("s")
    // a wide grapheme cut by the label becomes a space
    expect(overlayAt([{ text: "a漢b" }], 2, "x", st).map((s) => s.text).join("")).toBe("a xb")
    // a 2-key label over a 1-cell link spills onto the next cell
    expect(overlayAt([{ text: "b" }, { text: " and" }], 0, "as", st).map((s) => s.text).join("")).toBe("asand")
  })
})

test("selectedText drops row padding and blank edge rows, keeps indentation", () => {
  expect(selectedText("\n   \n  code   \nmore  \n   ")).toBe("  code\nmore")
  expect(selectedText("   \n ")).toBe("")
})

test("copiedCount counts lines, else code points", () => {
  expect(copiedCount("a\nb\nc")).toEqual([3, "line"])
  expect(copiedCount("zażółć")).toEqual([6, "char"])
})

test("stripLayout: a shorter view list renumbers from 1", () => {
  const l = stripLayout(32, ["outline", "info"]).labels
  expect(l.map((x) => [x.view, x.digit])).toEqual([["outline", "¹"], ["info", "²"]])
})

test("findQuote finds a phrase that wraps across rows", () => {
  const plain = ["# why", "the quick brown", "fox jumps over", "", "the lazy dog"]
  expect(findQuote(plain, 0, plain.length, "Brown  Fox")).toBe(1)
  expect(findQuote(plain, 0, plain.length, "over the lazy")).toBe(2) // a blank row is skipped, not a break
  expect(findQuote(plain, 0, plain.length, "lazy dog")).toBe(4)
})

test("findQuote searches the section's rows only", () => {
  const plain = ["# a", "needle here", "# b", "needle here"]
  expect(findQuote(plain, 2, 4, "needle here")).toBe(3)
  expect(findQuote(plain, 2, 3, "needle here")).toBeNull()
})

test("findQuote: a miss or an empty needle is null", () => {
  expect(findQuote(["abc"], 0, 1, "xyz")).toBeNull()
  expect(findQuote(["abc"], 0, 1, "  ")).toBeNull()
  expect(findQuote(["abc"], 0, 9, "abc")).toBe(0) // `to` past the end is clamped
})

test("findQuote ignores leading indentation of list rows", () => {
  expect(findQuote(["  • find in the vault"], 0, 1, "• Find in the vault")).toBe(0)
})

test("matchHits gives the code point indexes of every match", () => {
  expect(matchHits("Fish and fISH", "fish")).toEqual([0, 1, 2, 3, 9, 10, 11, 12])
  expect(matchHits("🐟 fish", "fish")).toEqual([2, 3, 4, 5]) // the emoji is one code point, two UTF-16 units
  expect(matchHits("nothing", "fish")).toEqual([])
})

test("findItems: a numbered row per match in Preview, the hits in primary, cut to the room", () => {
  const lines = [{ spans: [{ text: "  first line  " }] }, { spans: [{ text: "second " }, { text: "LINE here" }] }]
  const [a, b] = findItems(lines, [0, 1], "line", false, 40, t)
  const text = (it: { spans: { text: string }[] } | undefined) => it!.spans.map((s) => s.text).join("")
  expect(text(a)).toBe("   1  first line")
  expect(text(b)).toBe("   2  second LINE here")
  expect(a!.spans[0]).toEqual({ text: "   1  ", fg: t.textMuted })
  expect(b!.spans.filter((s) => s.fg === t.primary).map((s) => s.text)).toEqual(["LINE"])
  // Source rows carry no number, and a narrow room keeps the hit in view
  const [c] = findItems([{ spans: [{ text: "a long line of words before the word needle" }] }], [0], "needle", true, 16, t)
  expect(text(c)).toContain("needle")
  expect(text(c).startsWith("…")).toBe(true)
  expect(findItems(lines, [], "x", false, 40, t)).toEqual([])
})
