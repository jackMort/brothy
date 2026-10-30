import { describe, expect, test } from "bun:test"
import {
  ASK_MEMO,
  ASK_PROMPT,
  type AskState,
  type AskView,
  askCandidates,
  askLocate,
  askPaneLines,
  askRequest,
  askRows,
  askSection,
  askStage,
  askTitleNote,
  EXCERPT,
  landedSpans,
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
import type { Span } from "../../src/lib/spans"
import { truncate } from "../../src/lib/text"
import { noteSections, sectionId } from "../../src/markdown/sections"
import type { FileNode } from "../../src/notes/files"
import { type AnswerRow, emptyIndex, indexNote, type SwitchRow, type VaultIndex } from "../../src/notes/vault"
import { brothy } from "../helpers/theme"

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
/** One line per ask row, by kind, for comparing whole lists. */
const SHOW: { [K in SwitchRow["kind"]]: (r: Extract<SwitchRow, { kind: K }>) => string } = {
  header: (r) => `# ${r.title} ${r.count}${r.right === undefined ? "" : ` | ${r.right}`}`,
  askNote: (r) => `~${r.tone ? ` ${r.tone}` : ""} ${r.lead ?? ""}${r.text}`,
  askAction: (r) => `${r.act}${r.error ? " ✗" : ""}: ${r.text}${r.note}`,
  answer: (r) => `${r.n ?? ""}${r.name}${r.heading < 0 ? "" : " › " + r.text} | ${r.right}`,
  rule: () => "────",
  footnote: (r) => `${r.n}) ${r.text}`,
  askWait: (r) => `▍ ${r.text}`,
  note: () => "?",
  heading: () => "?",
  text: () => "?",
}
/** An idle ask view of the three-note vault `V` beside a pane. */
const VIEW: AskView = {
  question: "how do I open one file",
  cut: false,
  target: { host: "openrouter.ai", model: "anthropic/claude-haiku-5-5", ollama: false },
  state: undefined,
  cands: [],
  cost: "",
  indexing: false,
  secs: 0,
  notes: "3 notes",
  width: 60,
  pane: true,
}
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
    { heading: -1, line: 0, moved: false },
    { heading: 0, line: 4, moved: false },
    { heading: 1, line: 8, moved: false },
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
  const rows = askRows({ ...VIEW, question: "alpha?", state, cands: c })
  const answers = rows.filter((r): r is AnswerRow => r.kind === "answer")
  expect(answers.map((r) => [r.heading, r.n, r.right])).toEqual([
    [0, 1, ""],
    [-1, 2, ""],
    [1, undefined, "alpha"],
  ])
  expect(rows.flatMap((r) => (r.kind === "footnote" ? [`${r.n} ${r.text}`] : []))).toEqual(["1 star", "2 intro"])
})

describe("askLocate", () => {
  const c = { heading: 1, key: "usage", ord: 1, query: "CLI" }
  test("the section is found again by key and occurrence, then the first line holding the query", () => {
    const before = indexNote("# Usage\n\nold\n\n# Usage\n\nrun the cli here\n", 1, 1)
    expect(askLocate(before, c)).toEqual({ heading: 1, line: 6, moved: false })
    const after = indexNote("# Intro\n\n# Usage\n\nold\n\n# Usage\n\nmore\nrun the cli here\n", 1, 1)
    expect(askLocate(after, c)).toEqual({ heading: 2, line: 9, moved: false })
  })
  test("no line with the query → line null; the lead-in stays -1", () => {
    const before = indexNote("# Usage\n\nold\n\n# Usage\n\nrun the cli here\n", 1, 1)
    expect(askLocate(before, { ...c, query: "absent" })).toEqual({ heading: 1, line: null, moved: false })
    expect(askLocate(indexNote("intro x\n# A\n", 1, 1), { heading: -1, key: "", ord: 0, query: "X" })).toEqual({
      heading: -1,
      line: 0,
      moved: false,
    })
    expect(askLocate(before, { heading: -1, key: "", ord: 0, query: "cli" })).toEqual({
      heading: -1,
      line: null,
      moved: false,
    })
  })
  test("the heading renamed: the first line holding the word, in the section above it, moved; nowhere → null", () => {
    const renamed = indexNote("# Usage\n\nold\n\n# Running it\n\nrun the cli here\n", 1, 1)
    expect(askLocate(renamed, c)).toEqual({ heading: 1, line: 6, moved: true })
    expect(askLocate(indexNote("cli first\n# Usage\n\nonly one\n", 1, 1), c)).toEqual({
      heading: -1,
      line: 0,
      moved: true,
    })
    expect(askLocate(indexNote("# Usage\n\nonly one\n", 1, 1), c)).toBeNull()
  })
})

test("landedSpans: the mark, the why and ^p answers; muted when moved; ^p matches before the rerank", () => {
  const t = brothy
  const l = { path: "/v/a.md", n: 1, why: "chicken, beef and fish times", moved: false, heading: 2 }
  const txt = (sp: Span[]) => sp.map((x) => x.text).join("")
  expect(txt(landedSpans(t, l))).toBe("¹ chicken, beef and fish times · ^p answers")
  expect(landedSpans(t, l)[0]!.fg).toBe(t.primary)
  expect(landedSpans(t, { ...l, moved: true })[0]!.fg).toBe(t.textMuted)
  expect(txt(landedSpans(t, { ...l, why: "" }))).toBe("¹ ^p answers")
  expect(txt(landedSpans(t, { ...l, n: null, why: "" }))).toBe("^p matches")
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
  const base: AskView = { ...VIEW, question: "how do I open one file", cost: "~1.3k tokens" }
  const result: AskState = { question: base.question, phase: "result", queries: Q, model: "anthropic/claude-haiku-5-5" }
  const show = (rows: SwitchRow[]) => rows.map((r) => (SHOW[r.kind] as (r: SwitchRow) => string)(r))
  const SEARCHED = "~ text searched: single file · path · open"

  test("AI off, too short, a target error, idle", () => {
    expect(show(askRows({ ...base, target: null }))).toEqual([`~ AI off · set "ai" in config.json`])
    expect(show(askRows({ ...base, question: "ab" }))).toEqual(["~ type a question"])
    expect(show(askRows({ ...base, target: { error: "AI: set OPENROUTER_API_KEY" } }))).toEqual([
      "~ error AI: set OPENROUTER_API_KEY",
    ])
    expect(show(askRows(base))).toEqual(["ask: ⏎ ask · only the question → openrouter.ai"])
    expect(show(askRows({ ...base, cut: true }))).toEqual([
      `ask: ⏎ ask · only the first ${QUESTION_MAX} characters → openrouter.ai`,
    ])
  })
  test("idle without a pane: two muted notes under the row, wrapped with a 2-column hang", () => {
    expect(show(askRows({ ...base, pane: false, width: 40 }))).toEqual([
      "ask: ⏎ ask · only the question → openrouter.ai",
      "~ · only the question goes out; rerank",
      "~   adds short excerpts",
      "~ · nothing is written to disk",
    ])
  })
  test("asking: a rule, then the waiting row where the first result goes; seconds from 1 s", () => {
    const asking: AskState = { question: base.question, phase: "asking", model: "anthropic/claude-haiku-5-5" }
    expect(show(askRows({ ...base, state: asking }))).toEqual(["────", "▍ asking claude-haiku-5-5"])
    expect(show(askRows({ ...base, state: asking, secs: 3 })).at(-1)).toBe("▍ asking claude-haiku-5-5 · 3 s")
    // the index still building: the result waits under the same row
    expect(show(askRows({ ...base, state: result, cands: C, indexing: true }))).toEqual([
      "────",
      "▍ asking claude-haiku-5-5",
    ])
  })
  test("result: Matches, the matched word on the right, the rule, the rerank row with its cost, the queries", () => {
    expect(show(askRows({ ...base, state: result, cands: C }))).toEqual([
      "# Matches 4",
      "getting-started › Open a single file | single file",
      "getting-started › Open a folder | open",
      "README › Quick start | path",
      "path | path",
      "────",
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
      line: 13,
    })
    expect(a.n).toBeUndefined()
    expect(a.hits).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  })
  test("the matched word is cut at 12 columns", () => {
    const long = askCandidates(V.ix, V.tree, ["a single file opens"])
    expect(show(askRows({ ...base, state: { ...result, queries: ["a single file opens"] }, cands: long }))[1]).toBe(
      "getting-started › Open a single file | a single fi…",
    )
  })
  test("reranking: the rerank row becomes a waiting row naming the excerpts sent", () => {
    const rows = show(askRows({ ...base, state: { ...result, phase: "reranking" }, cands: C, secs: 2 }))
    expect(rows.slice(-3)).toEqual(["────", "▍ ranking 4 excerpts · claude-haiku-5-5 · 2 s", SEARCHED])
  })
  test("reranked: Answers marked in the model's order, their whys as footnotes under a rule, then Other matches", () => {
    const state: AskState = {
      ...result,
      phase: "reranked",
      order: [C[2]!.id, C[0]!.id],
      why: { [C[2]!.id]: "quick start runs it", [C[0]!.id]: "" },
    }
    expect(show(askRows({ ...base, state, cands: C }))).toEqual([
      "# Answers 2 | claude-haiku-5-5",
      "1README › Quick start | ",
      "2getting-started › Open a single file | ",
      "────",
      "1) quick start runs it",
      "# Other matches 2",
      "getting-started › Open a folder | open",
      "path | path",
      SEARCHED,
    ])
    // ids gone after an index refresh: back to the local order
    const gone: AskState = { ...state, order: ["/v/x.md#x#0"] }
    expect(show(askRows({ ...base, state: gone, cands: C }))[0]).toBe("# Matches 4")
  })
  test("nothing found: says so, the words searched, then next steps under a rule", () => {
    expect(show(askRows({ ...base, state: result, cands: [] }))).toEqual([
      "~ text Nothing in your notes",
      SEARCHED,
      "────",
      "~ · the question may not be in this folder (3 notes)",
      "~ · edit it and ⏎ to ask again, or drop the ? to search names",
      "~   and text yourself",
    ])
  })
  test("an error: the headline asks again, whether anything left, where to look (ollama or not)", () => {
    const failed: AskState = { question: base.question, phase: "error", error: "can't reach localhost:11434" }
    const ollama: AskView = { ...base, target: { host: "localhost:11434", model: "llama3.2", ollama: true } }
    expect(show(askRows({ ...ollama, state: failed }))).toEqual([
      "ask ✗: can't reach localhost:11434",
      "~ nothing was sent",
      "────",
      "~ · is ollama running? ⏎ tries again",
      "~ · the ai block lives in config.json; r re-reads it",
    ])
    expect(show(askRows({ ...base, state: { ...failed, error: "500 from openrouter.ai", sent: true } }))).toEqual([
      "ask ✗: 500 from openrouter.ai",
      "~ the question was sent to openrouter.ai",
      "────",
      "~ · check the endpoint and key · ⏎ tries again",
      "~ · the ai block lives in config.json; r re-reads it",
    ])
  })
})

test("askStage follows the rows: every state of the ask", () => {
  const C = askCandidates(V.ix, V.tree, ["path"])
  const st: AskState = { question: "q", phase: "result", queries: ["path"] }
  const v = { ...VIEW, cands: C }
  expect(askStage({ ...v, target: null })).toBe("off")
  expect(askStage({ ...v, question: "ab" })).toBe("short")
  expect(askStage({ ...v, target: { error: "x" } })).toBe("target")
  expect(askStage(v)).toBe("idle")
  expect(askStage({ ...v, state: { ...st, phase: "asking" } })).toBe("asking")
  expect(askStage({ ...v, state: st, indexing: true })).toBe("asking")
  expect(askStage({ ...v, state: st })).toBe("result")
  expect(askStage({ ...v, state: st, cands: [] })).toBe("none")
  expect(askStage({ ...v, state: { ...st, phase: "reranking" } })).toBe("reranking")
  expect(askStage({ ...v, state: { ...st, phase: "reranked", order: [C[0]!.id] } })).toBe("reranked")
  expect(askStage({ ...v, state: { ...st, phase: "reranked", order: ["gone"] } })).toBe("result")
  expect(askStage({ ...v, state: { ...st, phase: "error" } })).toBe("error")
})

test("askSection: tab goes from an answer to the action row, else to the next section", () => {
  const C = askCandidates(V.ix, V.tree, ["single file", "path", "open"])
  const st: AskState = { question: "q", phase: "result", queries: ["single file", "path", "open"] }
  const v: AskView = { ...VIEW, question: "how do I", state: st, cands: C }
  const rows = askRows(v) // 0 header · 1–4 answers · 5 rule · 6 rerank · 7 searched
  expect(askSection(rows, 1)).toBe(6)
  expect(askSection(rows, 4)).toBe(6)
  expect(askSection(rows, 6)).toBe(1)
  // 0 h · 1 answer · 2 rule · 3 footnote · 4 h · 5–7 · 8 searched
  const rr = askRows({ ...v, state: { ...st, phase: "reranked", order: [C[0]!.id], why: { [C[0]!.id]: "w" } } })
  expect(askSection(rr, 1)).toBe(5)
  expect(askSection(rr, 6)).toBe(1)
})

test("askTitleNote: nothing when AI is off, index progress, the answering model, else the note count", () => {
  const st: AskState = { question: "q", phase: "result", queries: ["a"], model: "anthropic/claude-haiku-5-5" }
  expect(askTitleNote({ off: true, state: st, indexing: null, notes: "6 notes" })).toBeUndefined()
  expect(askTitleNote({ off: false, state: st, indexing: "indexing 3/9", notes: "6 notes" })).toBe("indexing 3/9")
  expect(askTitleNote({ off: false, state: st, indexing: null, notes: "6 notes" })).toBe("claude-haiku-5-5")
  expect(askTitleNote({ off: false, state: { ...st, phase: "reranked" }, indexing: null, notes: "6 notes" })).toBe(
    "claude-haiku-5-5",
  )
  // the model from the moment the request is out; an error goes back to the note count
  expect(askTitleNote({ off: false, state: { ...st, phase: "asking" }, indexing: null, notes: "6 notes" })).toBe(
    "claude-haiku-5-5",
  )
  expect(askTitleNote({ off: false, state: { ...st, phase: "error" }, indexing: null, notes: "6 notes" })).toBe(
    "6 notes",
  )
  expect(askTitleNote({ off: false, state: undefined, indexing: null, notes: "6 notes" })).toBe("6 notes")
})

test("askPaneLines: idle says what ⏎ sends and what comes back; asking shows exactly what went out", () => {
  const t = brothy
  const txt = (rs: Span[][] | null) => (rs ?? []).map((r) => r.map((x) => x.text).join(""))
  const idle = txt(askPaneLines(t, VIEW, 40))
  expect(idle[0]).toBe("Ask your notes")
  expect(idle.join(" ")).toContain("⏎ sends only the question to claude-haiku-5-5 on openrouter.ai.")
  expect(idle.join(" ")).toContain(`(about ${EXCERPT} characters)`)
  expect(idle.at(-1)).toBe("Nothing is written to disk.")
  expect(Math.max(...idle.map((l) => l.length))).toBeLessThanOrEqual(40)
  const asking: AskState = { question: VIEW.question, phase: "asking", model: "m" }
  const sent = txt(askPaneLines(t, { ...VIEW, state: asking }, 40))
  expect(sent[0]).toBe("sent to openrouter.ai")
  expect(sent).toContain("“how do I open one file”")
  expect(sent).toContain(`${[...VIEW.question].length} characters · nothing else`)
  expect(sent.join(" ")).toContain("the model never sees them unless you rerank.")
  const C = askCandidates(V.ix, V.tree, ["path"])
  expect(
    askPaneLines(t, { ...VIEW, state: { ...asking, phase: "result", queries: ["path"] }, cands: C }, 40),
  ).toBeNull()
  expect(askPaneLines(t, { ...VIEW, target: null }, 40)).toBeNull()
})
