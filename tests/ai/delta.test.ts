import { describe, expect, test } from "bun:test"
import { cleanReply, noteText } from "../../src/ai/client"
import {
  changeCounts,
  changeHeading,
  changeMarks,
  DELTA_MAX,
  DELTA_PROMPT,
  DIFF_BUDGET,
  DIFF_CELLS,
  DIFF_LIMIT,
  deltaMessage,
  deltaRequest,
  diffSections,
  hhmm,
  hunks,
  landTail,
  landText,
  lineDiff,
  MARK_MAX,
  MAX_DELTA,
  type Op,
  parseDelta,
  quoteNeedle,
  reloadToast,
  stepChange,
} from "../../src/ai/delta"
import { expectLinear, manyHeadings, SCALE } from "../helpers/perf"

const show = (ops: Op[]) => ops.map((o) => o.op + o.text)
const nums = (n: number, p = "l") => Array.from({ length: n }, (_, i) => `${p}${i}`)

describe("lineDiff", () => {
  test("identical lines are all context", () => {
    expect(show(lineDiff(["a", "b"], ["a", "b"])!)).toEqual([" a", " b"])
  })
  test("a replaced line is a removal then an addition", () => {
    expect(show(lineDiff(["a", "b", "c"], ["a", "x", "c"])!)).toEqual([" a", "-b", "+x", " c"])
  })
  test("insertions and deletions follow the longest common subsequence", () => {
    expect(show(lineDiff(["a", "b", "c", "d"], ["b", "c", "e"])!)).toEqual(["-a", " b", " c", "-d", "+e"])
    expect(show(lineDiff(["a"], ["a", "b"])!)).toEqual([" a", "+b"])
    expect(show(lineDiff([], ["a"])!)).toEqual(["+a"])
  })
  test("over the cell cap: null (sent as rewritten)", () => {
    expect(lineDiff(nums(1001, "a"), nums(1001, "b"))).toBeNull()
    expect(lineDiff(nums(3, "a"), nums(3, "b"), 8)).toBeNull()
    expect(lineDiff(nums(3, "a"), nums(3, "b"), 9)).not.toBeNull()
  })
  test("the cap counts the changed middle only", () => {
    const big = nums(2000)
    const ops = lineDiff([...big, "x"], [...big, "y"], 4)!
    expect(ops.filter((o) => o.op !== " ").map((o) => o.op + o.text)).toEqual(["-x", "+y"])
  })
})

describe("hunks", () => {
  test("no change, no hunk", () => {
    expect(hunks(lineDiff(["a"], ["a"])!)).toEqual([])
  })
  test("one context line around each change; distant changes stay apart", () => {
    const a = nums(10)
    const b = a.map((l, i) => (i === 2 || i === 8 ? l + "!" : l))
    expect(hunks(lineDiff(a, b)!).map((h) => show(h.ops))).toEqual([
      [" l1", "-l2", "+l2!", " l3"],
      [" l7", "-l8", "+l8!", " l9"],
    ])
  })
  test("changes whose context touches merge", () => {
    const a = nums(6)
    const b = a.map((l, i) => (i === 1 || i === 3 ? l + "!" : l))
    expect(hunks(lineDiff(a, b)!).map((h) => show(h.ops))).toEqual([
      [" l0", "-l1", "+l1!", " l2", "-l3", "+l3!", " l4"],
    ])
  })
})

/** Shared by the message tests: one section edited, one removed, two added (Install and its macOS child). */
const BEFORE =
  "Intro line.\n\n# Title\n\n## Why\n\nPagers dump text.\n- Find with n / N\n\n## Pager notes\n\nold 1\nold 2\n"
const AFTER =
  "Intro line.\n\n# Title\n\n## Why\n\nPagers dump text.\n- Find in the vault\n\n## Install\n\n### macOS\n\nbrew install bun\n"
const brief = (cs: ReturnType<typeof diffSections>) =>
  cs!.map((c) => `${c.status} ${c.path.join(" › ") || "(lead-in)"} +${c.plus} -${c.minus}`)

describe("diffSections", () => {
  test("edited, removed and added, in document order", () => {
    expect(brief(diffSections(BEFORE, AFTER))).toEqual([
      "edited Title › Why +1 -1",
      "removed Title › Pager notes +0 -4",
      "added Title › Install +1 -0",
      "added Title › Install › macOS +3 -0",
    ])
    const [why, gone, , mac] = diffSections(BEFORE, AFTER)!
    expect(why!.index).toBe(1)
    expect(why!.hunks.map((h) => show(h.ops))).toEqual([
      [" Pagers dump text.", "-- Find with n / N", "+- Find in the vault"],
    ])
    expect(gone!.index).toBe(2) // the old outline's index
    expect(gone!.newText).toBe("")
    expect(mac!.newText).toBe("### macOS\n\nbrew install bun")
    expect(mac!.index).toBe(3)
  })
  test("the same text: no changes", () => {
    expect(diffSections(BEFORE, BEFORE)).toEqual([])
  })
  test("a renamed heading is removed + added", () => {
    // no shared section precedes Why, so its removal is listed first
    expect(brief(diffSections("## Why\n\ntext\n", "## Why not\n\ntext\n"))).toEqual([
      "removed Why +0 -3",
      "added Why not +3 -0",
    ])
  })
  test("a heading edit that keeps the key is an edit", () => {
    expect(brief(diffSections("## Install\n\nx\n", "## Install!\n\nx\n"))).toEqual(["edited Install! +1 -1"])
  })
  test("duplicate headings are told apart by occurrence", () => {
    const cs = diffSections("## Notes\n\na\n\n## Notes\n\nb\n", "## Notes\n\na\n\n## Notes\n\nc\n")!
    expect(cs.map((c) => [c.status, c.index, c.ord])).toEqual([["edited", 1, 1]])
  })
  test("line endings and trailing spaces are not changes", () => {
    expect(diffSections("## A\n\ntext\n", "## A\r\n\r\ntext   \r\n")).toEqual([])
  })
  test("appending a section leaves its neighbour alone", () => {
    expect(brief(diffSections("## A\n\ntext\n", "## A\n\ntext\n\n## B\n\nmore\n"))).toEqual(["added B +3 -0"])
  })
  test("the lead-in before the first heading is a section with an empty path", () => {
    const cs = diffSections("intro\n\n# A\n", "intro, longer\n\n# A\n")!
    expect(cs.map((c) => [c.status, c.index, c.path])).toEqual([["edited", -1, []]])
    expect(brief(diffSections("# A\n", "new intro\n\n# A\n"))).toEqual(["added (lead-in) +1 -0"])
  })
  test("a fenced # line is not a section", () => {
    const cs = diffSections("## Run\n\n```sh\n# build\nmake\n```\n", "## Run\n\n```sh\n# build\nmake all\n```\n")!
    expect(brief(cs)).toEqual(["edited Run +1 -1"])
  })
  test("comments and front matter never count (callers pass noteText)", () => {
    const a = "---\ntitle: x\n---\n# A\n\ntext %%one%%\n"
    const b = "---\ntitle: y\n---\n# A\n\ntext %%two%%\n"
    expect(diffSections(noteText(a), noteText(b))).toEqual([])
  })
  test("a section over the cell cap is rewritten, without hunks", () => {
    const a = "## Big\n\n" + nums(1100, "a").join("\n") + "\n"
    const b = "## Big\n\n" + nums(1100, "b").join("\n") + "\n"
    const [c] = diffSections(a, b)!
    expect(c!.rewritten).toBe(true)
    expect(c!.hunks).toEqual([])
    expect(c!.plus).toBe(1102)
    expect(c!.newText.endsWith("b1099")).toBe(true)
  })
  test("over DIFF_LIMIT: null (too large to compare)", () => {
    expect(diffSections("x".repeat(DIFF_LIMIT + 1), "y")).toBeNull()
  })
  test("line diffs over DIFF_BUDGET cells in all: null (too large to compare)", () => {
    // every line of every section changed (a formatter run): each section is under DIFF_CELLS, together over the budget
    const lines = 200
    const count = Math.floor(DIFF_BUDGET / (lines * lines)) + 1
    const note = (tag: string, k: number) =>
      Array.from({ length: k }, (_, i) => `## S${i}\n\n${nums(lines, tag + i + "-").join("\n")}\n`).join("\n")
    expect(lines * lines).toBeLessThanOrEqual(DIFF_CELLS)
    expect(diffSections(note("a", count), note("b", count))).toBeNull()
    expect(diffSections(note("a", count - 1), note("b", count - 1))).toHaveLength(count - 1)
    // rewritten sections (over the cell cap) run no diff, so they spend none of it
    const big = (tag: string) =>
      Array.from({ length: 10 }, (_, i) => `## B${i}\n\n${nums(1100, tag).join("\n")}\n`).join("\n")
    expect(diffSections(big("a"), big("b"))!.every((c) => c.rewritten)).toBe(true)
  })
  test("stays linear in the number of headings", () => {
    const N = 48_000
    const before = { big: manyHeadings(N), small: manyHeadings(N / SCALE) }
    const edited = {
      big: before.big.replace("body 7\n", "body seven\n"),
      small: before.small.replace("body 7\n", "body seven\n"),
    }
    expectLinear("one line edited", (b) =>
      b ? diffSections(before.big, edited.big) : diffSections(before.small, edited.small),
    )
    // every section but the first is removed, all listed after it: the list grows by push, not by copying
    const first = manyHeadings(1)
    expectLinear("all but one removed", (b) => diffSections(b ? before.big : before.small, first))
  }, 60_000)
})

describe("deltaMessage", () => {
  const cs = () => diffSections(BEFORE, AFTER)!
  test("ids in document order, hunks with @@, removed and added in full", () => {
    expect(deltaMessage("Readme", cs(), 16_000)).toBe(
      [
        "Note: Readme",
        "§1 edited · Title › Why",
        "@@",
        "  Pagers dump text.",
        "- - Find with n / N",
        "+ - Find in the vault",
        "§2 removed · Title › Pager notes",
        "- ## Pager notes",
        "- ",
        "- old 1",
        "- old 2",
        "§3 added · Title › Install",
        "+ ## Install",
        "§4 added · Title › Install › macOS",
        "+ ### macOS",
        "+ ",
        "+ brew install bun",
      ].join("\n"),
    )
  })
  test("the lead-in is named by the note title", () => {
    expect(deltaMessage("Readme", diffSections("a\n", "b\n")!, 16_000)).toBe(
      "Note: Readme\n§1 edited · Readme\n@@\n- a\n+ b",
    )
  })
  test("a removed section sends its first 20 lines", () => {
    const before = "## Old\n\n" + nums(30).join("\n") + "\n"
    const m = deltaMessage("N", diffSections(before, "")!, 16_000)
    expect(m.split("\n").filter((l) => l.startsWith("- ")).length).toBe(21) // 20 lines + "- …"
    expect(m.endsWith("- …")).toBe(true)
  })
  test("a rewritten section sends its new text only", () => {
    const a = "## Big\n\n" + nums(1100, "a").join("\n") + "\n"
    const b = "## Big\n\n" + nums(1100, "b").join("\n") + "\n"
    const m = deltaMessage("N", diffSections(a, b)!, 100_000)
    expect(m.startsWith("Note: N\n§1 rewritten · Big\n+ ## Big\n")).toBe(true)
    expect(m).not.toContain("a17")
  })
  test("past the cap, sections are listed by heading only while they fit", () => {
    const a = "## Big\n\n" + nums(100, "a").join("\n") + "\n\n## Small\n\nx\n\n## Last\n\ny\n"
    const b = "## Big\n\n" + nums(100, "b").join("\n") + "\n\n## Small\n\nx2\n\n## Last\n\ny2\n"
    const m = deltaMessage("N", diffSections(a, b)!, 200)
    expect(m).toBe("Note: N\n§1 edited · Big (not shown)\n§2 edited · Small (not shown)\n§3 edited · Last (not shown)")
  })
  test("then one unnumbered line counts the rest; the message never passes max", () => {
    const m = deltaMessage("Readme", cs(), 80)
    expect([...m].length).toBeLessThanOrEqual(80)
    expect(m.split("\n").at(-1)).toBe("… and 3 more sections")
    expect(m).toContain("§1 edited · Title › Why (not shown)")
    expect(m).not.toContain("§2")
    // many sections: ids stay 1…k, the rest are only counted
    const many = (v: string) =>
      Array.from(
        { length: 500 },
        (_, i) => `## Section number ${i} with a longish heading\n\nline ${v} of ${i}\n`,
      ).join("\n")
    const big = deltaMessage("T", diffSections(many("a"), many("b"))!, 8000)
    expect([...big].length).toBeLessThanOrEqual(8000)
    const ids = big
      .split("\n")
      .flatMap((l) => /^§(\d+) /.exec(l)?.[1] ?? [])
      .map(Number)
    expect(ids).toEqual(ids.map((_, i) => i + 1))
    expect(big.split("\n").at(-1)).toBe(`… and ${500 - ids.length} more sections`)
    expect(
      deltaMessage("T", diffSections(many("a"), many("b"))!.slice(0, ids.length + 1), 8000)
        .split("\n")
        .at(-1),
    ).toBe("… and 1 more section")
  })
})

describe("deltaRequest", () => {
  test("DELTA_PROMPT and deltaMessage within min(maxChars, DELTA_MAX); cleanReply, at most MAX_DELTA", () => {
    const cs = diffSections(BEFORE, AFTER)!
    expect(deltaRequest("Readme", cs, 48_000)).toEqual({
      system: DELTA_PROMPT,
      user: deltaMessage("Readme", cs, DELTA_MAX),
      maxOut: MAX_DELTA,
      clean: cleanReply,
    })
    expect(deltaRequest("Readme", cs, 120).user).toBe(deltaMessage("Readme", cs, 120))
  })
})

describe("parseDelta", () => {
  const cs = () => diffSections(BEFORE, AFTER)!
  test("summary, then one note per known id; quotes kept only when they are real", () => {
    const raw = [
      "Adds install steps and drops the pager notes.",
      '§1: search now covers the vault | "Find in the vault"',
      '§2: pager notes removed | "old 1 and more"',
      '§3: new install section | "too short"',
      '§4: brew and bun steps | "brew install bun"',
      "§9: not a section",
      "§1: a duplicate",
    ].join("\n")
    const p = parseDelta(raw, cs())!
    expect(p.summary).toBe("Adds install steps and drops the pager notes.")
    expect(p.notes).toEqual([
      { what: "search now covers the vault", quote: "Find in the vault" },
      { what: "pager notes removed" }, // removed sections take no quote
      { what: "new install section" }, // "too short" is not in its + lines
      { what: "brew and bun steps", quote: "brew install bun" },
    ])
  })
  test("a quote must appear in that section's + lines", () => {
    const p = parseDelta('S.\n§1: x | "Pagers dump text."', cs())! // a context line, not a + line
    expect(p.notes[0]).toEqual({ what: "x" })
  })
  test("decorated § lines and a think block parse", () => {
    const raw = "<think>hmm</think>\nOverall.\n**§1:** vault search | “Find in the vault”\n- §4 — brew steps"
    const p = parseDelta(raw, cs())!
    expect(p.summary).toBe("Overall.")
    expect(p.notes[0]).toEqual({ what: "vault search", quote: "Find in the vault" })
    expect(p.notes[3]).toEqual({ what: "brew steps" })
  })
  test("summary only is valid; § lines only are valid", () => {
    expect(parseDelta("Just a summary.", cs())!.notes.every((n) => n === undefined)).toBe(true)
    expect(parseDelta("§2: gone", cs())!.summary).toBe("")
  })
  test("nothing valid: null", () => {
    expect(parseDelta("§9: unknown", cs())).toBeNull()
    expect(parseDelta("   ", cs())).toBeNull()
  })
  test("long parts are cut", () => {
    const p = parseDelta("word ".repeat(100) + "\n§1: " + "x".repeat(200), cs())!
    expect(p.summary.length).toBeLessThanOrEqual(300)
    expect(p.summary.endsWith("…")).toBe(true)
    expect(p.notes[0]!.what.length).toBeLessThanOrEqual(80)
  })
  test("partial: an unfinished § line waits, the summary streams", () => {
    expect(parseDelta("Adds inst", cs(), true)!.summary).toBe("Adds inst")
    const p = parseDelta("Sum.\n§1: vault se", cs(), true)!
    expect(p.notes[0]).toBeUndefined()
    expect(parseDelta("<think>still", cs(), true)).toBeNull()
  })
  test("a leading <think> block is dropped, also while streaming; a partial tag or a second block keeps nothing", () => {
    for (const partial of [false, true]) {
      expect(parseDelta("<think>hm</think>\nSum.", cs(), partial)!.summary).toBe("Sum.")
      expect(parseDelta("  <think>hm</think>Sum.\n§1: vault search\n", cs(), partial)!.notes[0]!.what).toBe(
        "vault search",
      )
      expect(parseDelta("<think", cs(), partial)).toBeNull()
      expect(parseDelta("<think>a</think><think>b</think>Sum.\n§1: x", cs(), partial)).toBeNull()
    }
    expect(parseDelta("Sum <think>b</think> x", cs())!.summary).toBe("Sum <think>b</think> x") // only a leading block is thinking
  })
})

describe("reloadToast", () => {
  const one = diffSections("## A\n\nx\n", "## A\n\ny\n")!
  test("rows of the spec's table", () => {
    expect(reloadToast([], false, true)).toBe("reloaded from disk")
    expect(reloadToast([], true, true)).toBe("reloaded · properties changed")
    expect(reloadToast(one, true, false)).toBe("reloaded · ¹ section changed")
    expect(reloadToast([...one, ...one], false, true)).toBe("reloaded · ² sections changed · D explains")
    expect(reloadToast(Array(12).fill(one[0]), false, false)).toBe("reloaded · ¹² sections changed")
    expect(reloadToast(null, false, true)).toBe("reloaded · too large to compare")
  })
})

test("hhmm is local hours:minutes", () => {
  expect(hhmm(new Date(2026, 9, 26, 9, 5).getTime())).toBe("09:05")
  expect(hhmm(new Date(2026, 9, 26, 14, 2).getTime())).toBe("14:02")
})

test("quoteNeedle: Source keeps the Markdown, Preview drops markers and marks", () => {
  expect(quoteNeedle("- [ ] **Find** in [[vault]]", true)).toBe("- [ ] **Find** in [[vault]]")
  expect(quoteNeedle("- [ ] **Find** in [[vault]]", false)).toBe("Find in vault")
  expect(quoteNeedle("2. step two here", false)).toBe("step two here")
})

test("the system prompt is the spec's", () => {
  expect(DELTA_PROMPT.startsWith("You are shown the sections of a note that changed")).toBe(true)
  expect(DELTA_PROMPT.endsWith("Same language as the note.")).toBe(true)
  expect(DELTA_PROMPT).toContain("at most 10 of them") // the reply stays under MAX_DELTA
  expect(DELTA_PROMPT).toContain("`§<id>: <at most 8 words>`") // two rows of a 30-column Info
})

describe("Change.after", () => {
  test("a removed section names the shared section it followed in the new text", () => {
    const cs = diffSections("# T\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n", "# T\n\n## A\n\na\n\n## C\n\nc\n")!
    expect(cs.map((c) => [c.status, c.key, c.after])).toEqual([["removed", "b", 1]])
  })
  test("-1 after the lead-in, null before every shared section; only removed sections carry it", () => {
    expect(diffSections("intro\n\n## A\n\na\n\n## B\n\nb\n", "intro\n\n## B\n\nb\n")![0]!.after).toBe(-1)
    expect(diffSections("## A\n\na\n\n## B\n\nb\n", "## B\n\nb\n")![0]!.after).toBeNull()
    expect(diffSections("## A\n\na\n", "## A\n\nb\n")![0]!.after).toBeUndefined()
  })
})

describe("changeHeading", () => {
  const hs = (...t: string[]) => t.map((text) => ({ text }))
  const [edit] = diffSections("# T\n\n## A\n\na\n\n## B\n\nb\n", "# T\n\n## A\n\na\n\n## B\n\nb!\n")!
  test("the heading at its index, else found again by key; null when gone", () => {
    expect(changeHeading(hs("T", "A", "B"), edit!)).toBe(2)
    expect(changeHeading(hs("T", "New", "A", "B"), edit!)).toBe(3)
    expect(changeHeading(hs("T", "A"), edit!)).toBeNull()
  })
  test("a duplicate heading by its occurrence; the lead-in is -1; a removed section has none", () => {
    const [dup] = diffSections("## N\n\na\n\n## N\n\nb\n", "## N\n\na\n\n## N\n\nc\n")!
    expect(changeHeading(hs("X", "Y", "N", "N"), dup!)).toBe(3)
    const [lead] = diffSections("intro\n\n# A\n", "intro!\n\n# A\n")!
    expect(changeHeading(hs("A"), lead!)).toBe(-1)
    const [gone] = diffSections("## A\n\na\n\n## B\n\nb\n", "## A\n\na\n")!
    expect(changeHeading(hs("A"), gone!)).toBeNull()
  })
})

describe("changeMarks", () => {
  // rows: 0 # T, 1 blank, 2 ## A, 3 blank, 4 a, 5 blank, 6 ## C, 7 blank, 8 c
  const heads = [
    { text: "T", line: 0 },
    { text: "A", line: 2 },
    { text: "C", line: 6, last: 6 },
  ]
  const before = "# T\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n"
  test("a heading's mark on its last row; a removed one on the row above the next shared heading", () => {
    const cs = diffSections(before, "# T\n\n## A\n\na!\n\n## C\n\nc!\n")!
    expect(cs.map((c) => c.status)).toEqual(["edited", "removed", "edited"])
    expect(changeMarks(heads, 9, cs)).toEqual([
      { n: 1, row: 2, kind: "heading" },
      { n: 3, row: 6, kind: "heading" },
      { n: 2, row: 5, kind: "removed" },
    ])
  })
  test("a removed last section on the last row; before every shared one on row 0; the lead-in in the gutter of row 0", () => {
    const last = diffSections("# T\n\n## A\n\na\n\n## C\n\nc\n\n## D\n\nd\n", "# T\n\n## A\n\na\n\n## C\n\nc\n")!
    expect(changeMarks(heads, 9, last)).toEqual([{ n: 1, row: 8, kind: "removed" }])
    const first = diffSections("## Z\n\nz\n\n# T\n\nt\n", "# T\n\nt\n")!
    expect(changeMarks(heads, 9, first)).toEqual([{ n: 1, row: 0, kind: "removed" }])
    const lead = diffSections("intro\n\n# T\n", "intro!\n\n# T\n")!
    expect(changeMarks(heads, 9, lead)).toEqual([{ n: 1, row: 0, kind: "lead" }])
  })
  test("a removed mark moves up off a row that already has one", () => {
    // B removed after A, whose heading is the row above C: A's mark is there
    const tight = [
      { text: "T", line: 0 },
      { text: "A", line: 4 },
      { text: "C", line: 5 },
    ]
    const cs = diffSections("# T\n\n## A\n## B\n\nb\n\n## C\n\nc\n", "# T\n\n## A!\n## C\n\nc\n")!
    expect(cs.map((c) => c.status)).toEqual(["edited", "removed"])
    expect(changeMarks(tight, 9, cs)).toEqual([
      { n: 1, row: 4, kind: "heading" },
      { n: 2, row: 3, kind: "removed" },
    ])
  })
  test("a heading no longer there has no mark; past MARK_MAX none", () => {
    const [edit] = diffSections("# T\n\n## Gone\n\nx\n", "# T\n\n## Gone\n\ny\n")!
    expect(changeMarks(heads, 9, [edit!])).toEqual([])
    const many = Array.from({ length: MARK_MAX + 1 }, () => ({ ...edit!, index: 1, key: "a" }))
    expect(changeMarks(heads, 9, many)).toHaveLength(MARK_MAX)
  })
})

describe("landing", () => {
  const cs = diffSections(
    "# T\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n",
    "# T\n\n## A\n\na\nmore\n\n## C\n\nc!\n\n## D\n\nd\n",
  )!
  test("stepChange skips removed sections and stops at the ends", () => {
    expect(cs.map((c) => c.status)).toEqual(["edited", "removed", "edited", "added"])
    expect(stepChange(cs, 1, 1)).toBe(3)
    expect(stepChange(cs, 3, -1)).toBe(1)
    expect(stepChange(cs, 4, 1)).toBeNull()
    expect(stepChange(cs, 1, -1)).toBeNull()
    expect(stepChange(cs, 0, 1)).toBe(1)
  })
  test("landText: the note, else the counts by status", () => {
    expect(landText(cs[0]!, { what: "one line added" })).toBe("one line added")
    expect(landText(cs[0]!, undefined)).toBe("edited · +1")
    expect(landText(cs[2]!, undefined)).toBe("edited · +1 −1")
    expect(landText(cs[3]!, undefined)).toBe("new section · +3")
    expect(changeCounts({ plus: 0, minus: 3 })).toBe("−3")
  })
  test("landTail: where it is, the key to the next (prev at the last), or the wait", () => {
    expect(landTail(cs, 1, null)).toEqual({ status: "¹ of 4", key: "]", word: "next" })
    expect(landTail(cs, 4, null)).toEqual({ status: "⁴ of 4", key: "[", word: "prev" })
    expect(landTail(cs.slice(0, 1), 1, null)).toEqual({ status: "¹ of 1" })
    expect(landTail(cs, 1, { model: "llama3.2", secs: 3 })).toEqual({
      status: "asking llama3.2 · 3 s",
      model: "llama3.2",
      key: "D",
      word: "cancel",
    })
  })
})
