import { describe, expect, test } from "bun:test"
import {
  ASK_MEMO,
  ASK_PROMPT,
  type AskState,
  type AskView,
  askCandidates,
  askLocate,
  askRequest,
  askRows,
  askSection,
  askTitleNote,
  EXCERPT,
  MAX_ASK,
  MAX_CANDIDATES,
  MAX_QUERIES,
  MAX_RERANK,
  parseQueries,
  parseRerank,
  putNewest,
  QUESTION_MAX,
  questionOf,
  RERANK_PROMPT,
  rerankCost,
  rerankMessage,
  rerankRequest,
  WHY_W,
} from "../../src/ai/ask"
import { cleanReply, fmtTokens, tokens } from "../../src/ai/client"
import { truncate } from "../../src/lib/text"
import { noteSections, sectionId } from "../../src/markdown/sections"
import type { FileNode } from "../../src/notes/files"
import { type AnswerRow, emptyIndex, indexNote, type SwitchRow, type VaultIndex } from "../../src/notes/vault"

describe("questionOf", () => {
  test("a leading ? (after spaces) makes a question; the rest is trimmed; only one ? is taken", () => {
    expect(questionOf("?how do I open one file")).toEqual({ text: "how do I open one file", cut: false })
    expect(questionOf("   ?  spaced  ")).toEqual({ text: "spaced", cut: false })
    expect(questionOf("??twice")).toEqual({ text: "?twice", cut: false })
    expect(questionOf("?")).toEqual({ text: "", cut: false })
  })
  test("plain queries are not questions", () => {
    expect(questionOf("open")).toBeNull()
    expect(questionOf("a?b")).toBeNull()
    expect(questionOf("")).toBeNull()
  })
  test("cut at QUESTION_MAX code points, never inside a surrogate pair", () => {
    const q = questionOf("?" + "😀".repeat(QUESTION_MAX + 5))!
    expect([...q.text].length).toBe(QUESTION_MAX)
    expect(q.cut).toBe(true)
    expect(q.text.endsWith("😀")).toBe(true)
    expect(questionOf("?" + "x".repeat(QUESTION_MAX))!.cut).toBe(false)
  })
})

test("askRequest: ASK_PROMPT and the question alone; cleanReply, at most MAX_ASK", () => {
  expect(askRequest("how do I open one file")).toEqual({
    system: ASK_PROMPT,
    user: "how do I open one file",
    maxOut: MAX_ASK,
    clean: cleanReply,
  })
})

describe("parseQueries", () => {
  test("queries from a fenced or chatty reply", () => {
    expect(parseQueries('```json\n{"queries": ["open file", "path"]}\n```')).toEqual(["open file", "path"])
    expect(parseQueries('Sure! {"queries": ["cli"]} hope this helps')).toEqual(["cli"])
  })
  test("non-strings and too short / long dropped, trimmed, deduped by foldSame keeping the first", () => {
    const raw = JSON.stringify({
      queries: ["ok", 3, null, "a", "x".repeat(41), "x".repeat(40), "  Path ", "path", "PATH"],
    })
    expect(parseQueries(raw)).toEqual(["ok", "x".repeat(40), "Path"])
  })
  test("control characters become U+FFFD, tabs spaces", () => {
    expect(parseQueries(JSON.stringify({ queries: ["a\u001b[31mb", "c\td"] }))).toEqual(["a�[31mb", "c d"])
  })
  test("at most MAX_QUERIES", () => {
    expect(parseQueries(JSON.stringify({ queries: Array.from({ length: 12 }, (_, i) => `q${i}`) }))).toHaveLength(
      MAX_QUERIES,
    )
  })
  test("garbage or nothing usable → null", () => {
    for (const raw of [
      "",
      "no json",
      '{"queries": "open"}',
      '{"queries": []}',
      '{"queries": [1, 2]}',
      '["open"]',
      '{"queries": ["a"]}',
    ])
      expect(parseQueries(raw)).toBeNull()
  })
})

test("putNewest keeps the newest `cap` entries; re-putting a key makes it newest", () => {
  const m = new Map<string, number>()
  for (let i = 0; i < ASK_MEMO + 2; i++) putNewest(m, `k${i}`, i, ASK_MEMO)
  expect(m.size).toBe(ASK_MEMO)
  expect(m.has("k0")).toBe(false)
  putNewest(m, "k2", 99, ASK_MEMO)
  putNewest(m, "new", 1, ASK_MEMO)
  expect(m.has("k2")).toBe(true)
  expect(m.has("k3")).toBe(false)
  expect([...m.keys()].at(-2)).toBe("k2")
})

/** An index and tree under /v from [rel, source] pairs, in that tree order (folders created on the way). */
function vault(files: [string, string][]): { ix: VaultIndex; tree: FileNode } {
  const tree: FileNode = { name: "v", path: "/v", rel: "", dir: true, children: [] }
  const ix = emptyIndex()
  for (const [rel, src] of files) {
    const parts = rel.split("/")
    let dir = tree
    parts.slice(0, -1).forEach((p, k) => {
      const r = parts.slice(0, k + 1).join("/")
      let d = dir.children.find((c) => c.dir && c.rel === r)
      if (!d) dir.children.push((d = { name: p, path: "/v/" + r, rel: r, dir: true, children: [] }))
      dir = d
    })
    dir.children.push({ name: parts.at(-1)!, path: "/v/" + rel, rel, dir: false, children: [] })
    ix.docs.set("/v/" + rel, indexNote(src, 1, src.length))
  }
  return { ix, tree }
}
// source lines: 0 lead-in · 2 # Getting started · 6 ## Open a folder · 8 text · 10 ## Open a single file · 12, 13 text
const GS =
  "Lead-in about brothy.\n\n# Getting started\n\nInstall it.\n\n## Open a folder\n\nPass a folder path.\n\n## Open a single file\n\nPass a file path.\nA single file opens alone.\n"
const V = vault([
  ["README.md", "# README\n\n## Quick start\n\nbrothy path\n"],
  ["guides/getting-started.md", GS],
  ["notes/path.md", "# Misc\n\nnothing here\n"],
])
const label = (c: { name: string; heading: number; score: number; queries: number }) =>
  `${c.name}#${c.heading}:${c.score}/${c.queries}`

describe("askCandidates", () => {
  test("a heading beats text; a section sums its best kind per query; ties by query count, then tree order", () => {
    const c = askCandidates(V.ix, V.tree, ["single file", "path", "open"])
    expect(c.map(label)).toEqual(["getting-started#2:7/3", "getting-started#1:4/2", "README#1:1/1", "path#-1:1/1"])
    expect(c[0]!.best).toEqual({ query: "single file", line: 13 }) // ties with "open" (both heading): the earlier query
    expect(c[1]!.best).toEqual({ query: "open" }) // only the heading holds it: no line
    expect(c[0]).toMatchObject({
      path: "/v/guides/getting-started.md",
      text: "Open a single file",
      key: "open a single file",
      ord: 0,
    })
    expect(c[0]!.id).toBe(sectionId("/v/guides/getting-started.md", { key: "open a single file", ord: 0 }))
    expect(c[3]).toMatchObject({ heading: -1, text: "", key: "", ord: 0 }) // the note's name: its lead-in
  })
  test("text before the first heading is the lead-in (-1)", () => {
    expect(askCandidates(V.ix, V.tree, ["brothy"]).map((c) => `${c.name}#${c.heading}`)).toEqual([
      "README#1",
      "getting-started#-1",
    ])
  })
  test("at most SWITCH_CAP.perNote (3) text hits per note and query", () => {
    const v = vault([["a.md", Array.from({ length: 5 }, (_, i) => `# S${i}\n\nneedle\n`).join("\n")]])
    expect(askCandidates(v.ix, v.tree, ["needle"]).map((c) => c.heading)).toEqual([0, 1, 2])
  })
  test("at most MAX_CANDIDATES", () => {
    const v = vault([["a.md", Array.from({ length: 20 }, (_, i) => `# needle ${i}\n`).join("\n")]])
    expect(askCandidates(v.ix, v.tree, ["needle"])).toHaveLength(MAX_CANDIDATES)
  })
  test("only substring matches count: a query spread across a heading is not a hit", () => {
    const v = vault([["a.md", "# Options and tables\n\nbody\n"]])
    expect(askCandidates(v.ix, v.tree, ["one"])).toEqual([])
  })
  test("no queries, or a note missing from the index: nothing", () => {
    expect(askCandidates(V.ix, V.tree, [])).toEqual([])
    expect(askCandidates(emptyIndex(), V.tree, ["path"])).toEqual([])
  })
})

test("ids equal sectionId: the lead-in and a heading whose key is empty stay apart, and both are found again", () => {
  const src = "alpha intro line\n\n## ★\n\nalpha under a star heading\n\n## ★★\n\nalpha again\n"
  const v = vault([["n.md", src]])
  const c = askCandidates(v.ix, v.tree, ["alpha"])
  expect(c.map((x) => x.heading)).toEqual([-1, 0, 1])
  const secs = noteSections(src)
  expect(c.map((x) => x.id)).toEqual(secs.map((s) => sectionId("/v/n.md", s)))
  expect(new Set(c.map((x) => x.id)).size).toBe(3)
  const doc = v.ix.docs.get("/v/n.md")!
  expect(c.map((x) => askLocate(doc, { ...x, query: "alpha" }))).toEqual([
    { heading: -1, line: 0 },
    { heading: 0, line: 4 },
    { heading: 1, line: 8 },
  ])
  // a rerank keeps each answer once, with its own why
  const ids = c.map((x) => x.id)
  const picked = parseRerank('{"answers":[{"id":"c2","why":"star"},{"id":"c1","why":"intro"}]}', ids.length)!
  const state: AskState = {
    question: "alpha?",
    phase: "reranked",
    queries: ["alpha"],
    order: picked.map((p) => ids[p.i]!),
    why: Object.fromEntries(picked.map((p) => [ids[p.i]!, p.why])),
  }
  const rows = askRows({
    question: "alpha?",
    cut: false,
    target: { host: "h" },
    state,
    cands: c,
    cost: "",
    indexing: false,
  })
  const answers = rows.filter((r): r is AnswerRow => r.kind === "answer")
  expect(answers.map((r) => [r.heading, r.right])).toEqual([
    [0, "star"],
    [-1, "intro"],
    [1, "1/1"],
  ])
})

describe("askLocate", () => {
  const c = { heading: 1, key: "usage", ord: 1, query: "CLI" }
  test("the section is found again by key and occurrence, then the first line holding the query", () => {
    const before = indexNote("# Usage\n\nold\n\n# Usage\n\nrun the cli here\n", 1, 1)
    expect(askLocate(before, c)).toEqual({ heading: 1, line: 6 })
    const after = indexNote("# Intro\n\n# Usage\n\nold\n\n# Usage\n\nmore\nrun the cli here\n", 1, 1)
    expect(askLocate(after, c)).toEqual({ heading: 2, line: 9 })
  })
  test("the heading gone → null; no line with the query → line null; the lead-in stays -1", () => {
    const before = indexNote("# Usage\n\nold\n\n# Usage\n\nrun the cli here\n", 1, 1)
    expect(askLocate(indexNote("# Usage\n\nonly one\n", 1, 1), c)).toBeNull()
    expect(askLocate(before, { ...c, query: "absent" })).toEqual({ heading: 1, line: null })
    expect(askLocate(indexNote("intro x\n# A\n", 1, 1), { heading: -1, key: "", ord: 0, query: "X" })).toEqual({
      heading: -1,
      line: 0,
    })
    expect(askLocate(before, { heading: -1, key: "", ord: 0, query: "cli" })).toEqual({ heading: -1, line: null })
  })
})

describe("rerank", () => {
  const C = askCandidates(V.ix, V.tree, ["single file", "path", "open"])
  test("rerankMessage: the question, then c<n> · note › heading path and the section's text on one line", () => {
    const m = rerankMessage("how do I open one file", C, V.ix)
    expect(m).toBe(
      "Question: how do I open one file\n\n" +
        "c1 · getting-started › Getting started › Open a single file\nPass a file path. A single file opens alone.\n\n" +
        "c2 · getting-started › Getting started › Open a folder\nPass a folder path.\n\n" +
        "c3 · README › README › Quick start\nbrothy path\n\n" +
        "c4 · path\n",
    )
  })
  test("rerankMessage: excerpts cut at EXCERPT code points, at most MAX_CANDIDATES", () => {
    const long = vault([["a.md", "# H\n\n" + "wörd ".repeat(200) + "\n"]])
    const lc = askCandidates(long.ix, long.tree, ["wörd"])
    expect([...rerankMessage("q", lc, long.ix).split("\n")[3]!].length).toBe(EXCERPT)
    const many = rerankMessage("q", [...C, ...C, ...C, ...C], V.ix)
    expect(many).toContain("c12 · ")
    expect(many).not.toContain("c13 · ")
  })
  test("rerankRequest: RERANK_PROMPT and rerankMessage; cleanReply, at most MAX_RERANK", () => {
    expect(rerankRequest("q", C, V.ix)).toEqual({
      system: RERANK_PROMPT,
      user: rerankMessage("q", C, V.ix),
      maxOut: MAX_RERANK,
      clean: cleanReply,
    })
  })
  test("rerankCost is the token estimate of exactly what tier 1 sends", () => {
    const want = fmtTokens(tokens(RERANK_PROMPT) + tokens(rerankMessage("q", C, V.ix)))
    expect(rerankCost("q", C, V.ix)).toBe(want)
    expect(want.startsWith("~")).toBe(true)
  })
  test("parseRerank: known ids in the model's order, the first of duplicates, why cleaned and cut", () => {
    const long = "x".repeat(60)
    const raw = `<think>hm</think>\`\`\`json\n{"answers": [{"id": "c3", "why": "**the cli** takes a path"}, {"id": "c9"}, {"id": "c3", "why": "dup"}, {"id": "c1", "why": "${long}"}, {"id": 2}, "c2", {"id": "c0"}, {"id": "c4", "why": "a\\u001bb"}]}\n\`\`\``
    expect(parseRerank(raw, 4)).toEqual([
      { i: 2, why: "the cli takes a path" },
      { i: 0, why: truncate(long, WHY_W) },
      { i: 3, why: "a�b" },
    ])
  })
  test("parseRerank: no valid id → null", () => {
    for (const raw of [
      "",
      "nope",
      '{"answers": []}',
      '{"answers": [{"id": "c0"}, {"id": "c5"}]}',
      '{"queries": ["x"]}',
    ])
      expect(parseRerank(raw, 4)).toBeNull()
  })
})

describe("askRows", () => {
  const C = askCandidates(V.ix, V.tree, ["single file", "path", "open"])
  const Q = ["single file", "path", "open"]
  const base: AskView = {
    question: "how do I open one file",
    cut: false,
    target: { host: "openrouter.ai" },
    state: undefined,
    cands: [],
    cost: "~1.3k tokens",
    indexing: false,
  }
  const result: AskState = { question: base.question, phase: "result", queries: Q, model: "anthropic/claude-haiku-5-5" }
  const show = (rows: SwitchRow[]) =>
    rows.map((r) => {
      if (r.kind === "header") return `# ${r.title} ${r.count}`
      if (r.kind === "askNote") return `~ ${r.text}`
      if (r.kind === "askAction") return `${r.act}${r.error ? " ✗" : ""}: ${r.text}${r.note}`
      if (r.kind === "answer") return `${r.name}${r.heading < 0 ? "" : " › " + r.text} | ${r.right}`
      return "?"
    })
  const SEARCHED = "~ searched: single file · path · open"

  test("AI off, too short, idle, no key", () => {
    expect(show(askRows({ ...base, target: null }))).toEqual([`~ AI off · set "ai" in config.json`])
    expect(show(askRows({ ...base, question: "ab" }))).toEqual(["~ type a question"])
    expect(show(askRows(base))).toEqual(["ask: ⏎ ask · only the question → openrouter.ai"])
    expect(show(askRows({ ...base, cut: true }))).toEqual(["ask: ⏎ ask · only the question… → openrouter.ai"])
    expect(show(askRows({ ...base, target: { error: "AI: set OPENROUTER_API_KEY" } }))).toEqual([
      "~ AI: set OPENROUTER_API_KEY",
    ])
  })
  test("asking, and a result while the index is still building", () => {
    expect(show(askRows({ ...base, state: { question: base.question, phase: "asking" } }))).toEqual(["~ asking…"])
    expect(show(askRows({ ...base, state: result, cands: C, indexing: true }))).toEqual(["~ asking…"])
  })
  test("result: Answers with hits/all, the rerank row with its cost, the queries", () => {
    expect(show(askRows({ ...base, state: result, cands: C }))).toEqual([
      "# Answers 4",
      "getting-started › Open a single file | 3/3",
      "getting-started › Open a folder | 2/3",
      "README › Quick start | 1/3",
      "path | 1/3",
      "rerank: ↻ rerank with excerpts · ~1.3k tokens",
      SEARCHED,
    ])
    const a = askRows({ ...base, state: result, cands: C })[1] as AnswerRow
    expect(a).toMatchObject({
      path: "/v/guides/getting-started.md",
      heading: 2,
      key: "open a single file",
      ord: 0,
      id: C[0]!.id,
      query: "single file",
    })
    expect(a.hits).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  })
  test("reranking replaces the rerank row", () => {
    expect(show(askRows({ ...base, state: { ...result, phase: "reranking" }, cands: C })).at(-2)).toBe("~ reranking…")
  })
  test("reranked: the model's order with its why, the rest under Other matches, no rerank row", () => {
    const state: AskState = {
      ...result,
      phase: "reranked",
      order: [C[2]!.id, C[0]!.id],
      why: { [C[2]!.id]: "quick start runs it" },
    }
    expect(show(askRows({ ...base, state, cands: C }))).toEqual([
      "# Answers 2",
      "README › Quick start | quick start runs it",
      "getting-started › Open a single file | ",
      "# Other matches 2",
      "getting-started › Open a folder | 2/3",
      "path | 1/3",
      SEARCHED,
    ])
    // ids gone after an index refresh: back to the local order
    const gone: AskState = { ...state, order: ["/v/x.md#x#0"] }
    expect(show(askRows({ ...base, state: gone, cands: C }))[0]).toBe("# Answers 4")
  })
  test("nothing found, and an error", () => {
    expect(show(askRows({ ...base, state: result, cands: [] }))).toEqual([
      "~ nothing found · searched: single file · path · open",
    ])
    expect(
      show(askRows({ ...base, state: { question: base.question, phase: "error", error: "AI: rate limited" } })),
    ).toEqual(["ask ✗: AI: rate limited · ⏎ asks again"])
  })
})

test("askSection: tab goes from an answer to the action row, else to the next section", () => {
  const C = askCandidates(V.ix, V.tree, ["single file", "path", "open"])
  const st: AskState = { question: "q", phase: "result", queries: ["single file", "path", "open"] }
  const v: AskView = {
    question: "how do I",
    cut: false,
    target: { host: "h" },
    state: st,
    cands: C,
    cost: "~1k tokens",
    indexing: false,
  }
  const rows = askRows(v) // 0 header · 1–4 answers · 5 rerank · 6 searched
  expect(askSection(rows, 1)).toBe(5)
  expect(askSection(rows, 4)).toBe(5)
  expect(askSection(rows, 5)).toBe(1)
  const rr = askRows({ ...v, state: { ...st, phase: "reranked", order: [C[0]!.id], why: {} } }) // 0 h · 1 · 2 h · 3–5 · 6
  expect(askSection(rr, 1)).toBe(3)
  expect(askSection(rr, 4)).toBe(1)
})

test("askTitleNote: nothing when AI is off, index progress, the answering model, else the note count", () => {
  const st: AskState = { question: "q", phase: "result", queries: ["a"], model: "anthropic/claude-haiku-5-5" }
  expect(askTitleNote({ off: true, state: st, indexing: null, notes: "6 notes" })).toBeUndefined()
  expect(askTitleNote({ off: false, state: st, indexing: "indexing 3/9", notes: "6 notes" })).toBe("indexing 3/9")
  expect(askTitleNote({ off: false, state: st, indexing: null, notes: "6 notes" })).toBe("claude-haiku-5-5")
  expect(askTitleNote({ off: false, state: { ...st, phase: "reranked" }, indexing: null, notes: "6 notes" })).toBe(
    "claude-haiku-5-5",
  )
  expect(
    askTitleNote({ off: false, state: { question: "q", phase: "asking" }, indexing: null, notes: "6 notes" }),
  ).toBe("6 notes")
  expect(askTitleNote({ off: false, state: undefined, indexing: null, notes: "6 notes" })).toBe("6 notes")
})
