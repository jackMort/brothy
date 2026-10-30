// Ask → jump (`?` in the `C-p` switcher). The model turns a question into search queries (tier 0)
// or orders excerpts brothy picked (tier 1); every answer is a place the local index found. Pure.

import { isRecord } from "../lib/json"
import { A, lineText, type Span, safeLine } from "../lib/spans"
import { truncate, wrap } from "../lib/text"
import { headingKey, sectionId } from "../markdown/sections"
import { type FileNode, SCORE_SUBSEQUENCE, scoreName, stem } from "../notes/files"
import {
  type AnswerRow,
  type AskNoteRow,
  foldSame,
  headingAt,
  lineOf,
  type NoteDoc,
  nextSection,
  notesOf,
  SWITCH_CAP,
  type SwitchRow,
  type VaultIndex,
} from "../notes/vault"
import type { Theme } from "../theme/theme"
import { MODEL_W, waitText } from "../ui/footnote"
import { headingPath } from "../ui/zen"
import { type ChatReq, cleanReply, cleanSummary, extractJSON, fmtTokens, shortModel, tokens } from "./client"

/** `PROMPTS.ask` (ai/config.ts): bump it with any change. */
export const ASK_PROMPT =
  'Turn the user\'s question about their own notes into 3–8 short search queries (1–3 words each) that are likely to appear verbatim in the notes or their headings: key terms, synonyms, likely heading words. Use the question\'s language, and add English variants if it is not English. Reply with JSON only: {"queries": ["…"]}.'
/** `PROMPTS.rerank` (ai/config.ts): bump it with any change. */
export const RERANK_PROMPT =
  'Given a question and numbered excerpts from the user\'s notes, pick the excerpts that help answer it, best first. Reply with JSON only: {"answers": [{"id": "c3", "why": "at most 8 words"}]}. Use only ids from the list; leave out excerpts that don\'t help.'

/** Code points of a question that are sent; longer ones are cut. */
export const QUESTION_MAX = 300
/** Fewest code points a question needs before it can be asked. */
export const ASK_MIN = 3
export const MAX_QUERIES = 8
/** Code points a query must have, at least and at most, to be kept. */
const QUERY_MIN = 2
const QUERY_MAX = 40
/** Sections ranked locally and offered to the rerank. */
export const MAX_CANDIDATES = 12
/** Code points of a section's text sent per candidate (tier 1). */
export const EXCERPT = 300
/** Columns of a rerank `why`. */
export const WHY_W = 40
/** Session memos: tier 0 queries per question, tier 1 orders per question and candidate list. */
export const ASK_MEMO = 50
export const RERANK_MEMO = 20
/** `chat`'s `maxOut` for tier 0 (a few queries) and tier 1 (an id and a why per candidate). */
export const MAX_ASK = 1000
export const MAX_RERANK = 2000

/** A switcher query whose first non-space character is `?` is a question: the rest, trimmed, cut at QUESTION_MAX. */
export function questionOf(q: string): { text: string; cut: boolean } | null {
  const s = q.trimStart()
  if (!s.startsWith("?")) return null
  const cps = [...s.slice(1).trim()]
  return { text: cps.slice(0, QUESTION_MAX).join(""), cut: cps.length > QUESTION_MAX }
}

/** Tier 0's request: the question alone; the reply is parsed from `raw`. */
export function askRequest(question: string): ChatReq {
  return { system: ASK_PROMPT, user: question, maxOut: MAX_ASK, clean: cleanReply }
}

/** Tier 0's reply: QUERY_MIN–QUERY_MAX code points each, deduped by `foldSame`, at most MAX_QUERIES; null when none is usable. */
export function parseQueries(raw: string): string[] | null {
  const j = extractJSON(raw)
  if (!isRecord(j) || !Array.isArray(j.queries)) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const q of j.queries) {
    if (typeof q !== "string") continue
    const s = safeLine(q).trim()
    const n = [...s].length
    if (n < QUERY_MIN || n > QUERY_MAX) continue
    const k = foldSame(s)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
    if (out.length === MAX_QUERIES) break
  }
  return out.length ? out : null
}

/** Set `k` as the newest entry of `m` and drop the oldest past `cap` (a Map keeps insertion order). */
export function putNewest<K, V>(m: Map<K, V>, k: K, v: V, cap: number): void {
  m.delete(k)
  m.set(k, v)
  while (m.size > cap) m.delete(m.keys().next().value as K)
}

// ------------------------------------------------------------- local ranking

/** A section that answers some of the queries; `heading` indexes `NoteDoc.headings` (= `view.headings` once open), -1 the lead-in. */
export interface Candidate {
  path: string
  /** note name without extension */
  name: string
  heading: number
  /** heading text; "" for the lead-in */
  text: string
  /** `headingKey(text)` and its occurrence among equal keys in the note ("" / 0 for the lead-in) */
  key: string
  ord: number
  /** `sectionId(path, { key, ord })`: stable across edits elsewhere in the note */
  id: string
  score: number
  /** distinct queries that hit the section */
  queries: number
  /** the best-scoring query (the earlier one on ties) and its first text line in the section */
  best: { query: string; line?: number }
}

const HEAD = 3
const TEXT = 1
const NAME = 1

/** `scoreName`'s substring tier only: its subsequence tier would find a short query in most long headings. */
const sub = (name: string, q: string) => {
  const m = scoreName(name, q)
  return m && m.score > SCORE_SUBSEQUENCE ? m : null
}

/** Each heading's identity: its key and how many equal keys come before it; the lead-in counts as key "", as in `noteSections`. */
function keysOf(doc: NoteDoc): { key: string; ord: number }[] {
  const seen = new Map<string, number>([["", 1]])
  return doc.headings.map((h) => {
    const key = headingKey(h.text)
    const ord = seen.get(key) ?? 0
    seen.set(key, ord + 1)
    return { key, ord }
  })
}

/** Source lines [from, to) of section `i` (-1: the lead-in): up to the next heading of any depth. */
function sectionLines(doc: NoteDoc, i: number): [number, number] {
  const from = i < 0 ? 0 : doc.headings[i]!.line + 1
  return [from, doc.headings[i + 1]?.line ?? doc.starts.length]
}

type Hits = Map<number, { kinds: Map<string, number>; lines: Map<string, number> }>

/** The sections of `doc` holding a query, by heading index (-1: the lead-in, where a name hit lands): the best kind per query, and its first text line. */
function noteHits(doc: NoteDoc, name: string, queries: readonly string[]): Hits {
  const secs: Hits = new Map()
  const hit = (heading: number, q: string, kind: number, line?: number) => {
    let a = secs.get(heading)
    if (!a) secs.set(heading, (a = { kinds: new Map(), lines: new Map() }))
    if ((a.kinds.get(q) ?? 0) < kind) a.kinds.set(q, kind)
    if (line !== undefined && !a.lines.has(q)) a.lines.set(q, line)
  }
  for (const q of queries) {
    if (sub(name, q)) hit(-1, q, NAME)
    doc.headings.forEach((h, i) => void (sub(h.text, q) && hit(i, q, HEAD)))
    const want = foldSame(q.trim())
    let from = 0
    for (let k = 0; doc.lower && k < SWITCH_CAP.perNote; k++) {
      const at = doc.lower.indexOf(want, from)
      if (at < 0) break
      const line = lineOf(doc.starts, at)
      hit(headingAt(doc.headings, line) ?? -1, q, TEXT, line)
      from = doc.starts[line + 1] ?? doc.lower.length // one hit per line
    }
  }
  return secs
}

/** One note's sections that hold a query, in heading order. */
function noteCandidates(n: FileNode, doc: NoteDoc, queries: readonly string[]): Candidate[] {
  const name = stem(n.name)
  const ids = keysOf(doc)
  const out: Candidate[] = []
  for (const [heading, a] of [...noteHits(doc, name, queries)].sort(([x], [y]) => x - y)) {
    let best = ""
    let top = 0
    for (const q of queries) {
      const k = a.kinds.get(q) ?? 0
      if (k > top) [top, best] = [k, q]
    }
    const { key, ord } = heading < 0 ? { key: "", ord: 0 } : ids[heading]!
    const line = a.lines.get(best)
    out.push({
      path: n.path,
      name,
      heading,
      text: heading < 0 ? "" : doc.headings[heading]!.text,
      key,
      ord,
      id: sectionId(n.path, { key, ord }),
      score: [...a.kinds.values()].reduce((x, y) => x + y, 0),
      queries: a.kinds.size,
      best: line === undefined ? { query: best } : { query: best, line },
    })
  }
  return out
}

/**
 * Sections of the vault for the model's queries, best first, at most MAX_CANDIDATES. Per query: a
 * heading holding it scores 3, a text line 1 (first SWITCH_CAP.perNote lines per note), the note's
 * name 1 (for its lead-in); a section sums its best kind per distinct query. Ties: more queries, then tree order.
 */
export function askCandidates(ix: VaultIndex, tree: FileNode, queries: readonly string[]): Candidate[] {
  const out: (Candidate & { order: number })[] = []
  for (const n of notesOf(tree)) {
    const doc = ix.docs.get(n.path)
    if (doc) for (const c of noteCandidates(n, doc, queries)) out.push({ ...c, order: out.length })
  }
  out.sort((a, b) => b.score - a.score || b.queries - a.queries || a.order - b.order)
  return out.slice(0, MAX_CANDIDATES).map(({ order: _, ...c }) => c)
}

/**
 * Where an answer lands in `doc`, the note as it is now: its section found again by key and
 * occurrence, then the first line there holding `query`. null when the heading is gone.
 */
export function askLocate(
  doc: NoteDoc,
  a: { heading: number; key: string; ord: number; query: string },
): { heading: number; line: number | null } | null {
  const i = a.heading < 0 ? -1 : keysOf(doc).findIndex((x) => x.key === a.key && x.ord === a.ord)
  if (a.heading >= 0 && i < 0) return null
  const [from, to] = sectionLines(doc, i)
  const want = foldSame(a.query.trim())
  for (let l = from; l < to && l < doc.starts.length; l++) {
    const end = l + 1 < doc.starts.length ? doc.starts[l + 1]! - 1 : doc.lower.length
    if (doc.lower.slice(doc.starts[l]!, end).includes(want)) return { heading: i, line: l }
  }
  return { heading: i, line: null }
}

// ------------------------------------------------------------- tier 1

/** Section `heading`'s searchable text (front matter, comments and heading lines already blank) on one line, cut to EXCERPT code points. */
function excerpt(doc: NoteDoc, heading: number): string {
  if (!doc.starts.length) return ""
  const [from, to] = sectionLines(doc, heading)
  const a = doc.starts[from] ?? doc.text.length
  const b = to < doc.starts.length ? doc.starts[to]! : doc.text.length
  return [...doc.text.slice(a, b).replace(/\s+/g, " ").trim()].slice(0, EXCERPT).join("")
}

/** Tier 1's user message: the question, then per candidate `c<n> · <note> › <heading path>` and its excerpt. */
export function rerankMessage(question: string, cands: readonly Candidate[], ix: VaultIndex): string {
  const parts = cands.slice(0, MAX_CANDIDATES).map((c, k) => {
    const doc = ix.docs.get(c.path)
    const path = doc && c.heading >= 0 ? headingPath(doc.headings, c.heading) : []
    return `c${k + 1} · ${[c.name, ...path].join(" › ")}\n${doc ? excerpt(doc, c.heading) : ""}`
  })
  return `Question: ${question}\n\n${parts.join("\n\n")}`
}

/** Tier 1's request; its `user` is `rerankMessage`, and the reply is parsed from `raw`. */
export function rerankRequest(question: string, cands: readonly Candidate[], ix: VaultIndex): ChatReq {
  return { system: RERANK_PROMPT, user: rerankMessage(question, cands, ix), maxOut: MAX_RERANK, clean: cleanReply }
}

/** The rerank row's cost: input tokens of exactly what tier 1 would send. */
export const rerankCost = (question: string, cands: readonly Candidate[], ix: VaultIndex) =>
  fmtTokens(tokens(RERANK_PROMPT) + tokens(rerankMessage(question, cands, ix)))

/** Tier 1's reply: positions (0-based, from `c1…c<n>`) best first, each with its why; null when none is valid. */
export function parseRerank(raw: string, n: number): { i: number; why: string }[] | null {
  const j = extractJSON(raw)
  const list = isRecord(j) && Array.isArray(j.answers) ? j.answers : []
  const out: { i: number; why: string }[] = []
  const seen = new Set<number>()
  for (const it of list) {
    if (!isRecord(it) || typeof it.id !== "string") continue
    const m = /^c(\d{1,2})$/.exec(it.id.trim())
    const i = m ? Number(m[1]) - 1 : -1
    if (i < 0 || i >= n || seen.has(i)) continue
    seen.add(i)
    out.push({ i, why: typeof it.why === "string" ? truncate(safeLine(cleanSummary(it.why)), WHY_W) : "" })
  }
  return out.length ? out : null
}

// ------------------------------------------------------------- rows

/** `ui.switcher.ask`: absent while idle; any edit of the query drops it. */
export interface AskState {
  question: string
  phase: "asking" | "result" | "reranking" | "reranked" | "error"
  /** tier 0's queries (memoized per question) */
  queries?: string[]
  /** the model asked, then the one that answered (full id; shown through shortModel) */
  model?: string
  /** tier 1: section ids, best first, and each one's why */
  order?: string[]
  why?: Record<string, string>
  /** the failed ask: what went wrong (`aiMessage`, no `AI:` prefix), and whether the question had reached the host */
  error?: string
  sent?: boolean
}
/** Where `⏎` sends the question (the host, the model, whether it is ollama), why it can't (resolveAI's toast), or null without an `ai` block. */
export type AskTarget = { host: string; model: string; ollama: boolean } | { error: string } | null
export interface AskView {
  question: string
  /** the question was cut at QUESTION_MAX */
  cut: boolean
  target: AskTarget
  state: AskState | undefined
  /** askCandidates for `state.queries` on a complete index */
  cands: readonly Candidate[]
  /** rerankCost of `cands` */
  cost: string
  /** the vault index is still building: ranking waits for it */
  indexing: boolean
  /** whole seconds the running request has waited */
  secs: number
  /** the folder's size, `10 notes` */
  notes: string
  /** the list's text columns: notes and next steps wrap to them */
  width: number
  /** a pane beside the list explains the ask, so the idle row needs no notes under it */
  pane: boolean
}

/** What the ask shows: the rows, the footer and the pane follow it. */
export type AskStage =
  | "off"
  | "short"
  | "target"
  | "idle"
  | "asking"
  | "result"
  | "none"
  | "reranking"
  | "reranked"
  | "error"

/** The candidates the model picked that are still listed, in its order (ids gone after an index refresh are dropped). */
function picked(v: Pick<AskView, "state" | "cands">): Candidate[] {
  if (v.state?.phase !== "reranked") return []
  const byId = new Map(v.cands.map((c) => [c.id, c]))
  return (v.state.order ?? []).flatMap((id) => byId.get(id) ?? [])
}

export function askStage(v: Pick<AskView, "question" | "target" | "state" | "cands" | "indexing">): AskStage {
  const st = v.state
  if (!v.target) return "off"
  if ([...v.question].length < ASK_MIN) return "short"
  if (!st) return "error" in v.target ? "target" : "idle"
  if (st.phase === "error") return "error"
  if (st.phase === "asking" || v.indexing) return "asking"
  if (!v.cands.length) return "none"
  if (picked(v).length) return "reranked"
  return st.phase === "reranking" ? "reranking" : "result"
}

/** The model's display name: the one asked or that answered, else the configured one. */
const askModel = (v: Pick<AskView, "target" | "state">) =>
  shortModel(v.state?.model ?? (v.target && "model" in v.target ? v.target.model : ""))

const hostOf = (v: Pick<AskView, "target">) => (v.target && "host" in v.target ? v.target.host : "")

/** Columns of the matched word on a row's right. */
const WORD_W = 12
const RULE_ROW: SwitchRow = { kind: "rule" }

const note = (text: string, tone?: AskNoteRow["tone"], lead?: string): SwitchRow => ({
  kind: "askNote",
  text,
  ...(tone ? { tone } : {}),
  ...(lead ? { lead } : {}),
})

/** `text` (a `· ` bullet) as muted rows of `w` columns, continuation rows hung 2 columns in. */
const bullets = (text: string, w: number): SwitchRow[] =>
  wrap([{ text }], Math.max(4, w), [], [{ text: "  " }]).map((r) => note(lineText({ spans: r }).trimEnd()))

function answer(c: Candidate, right: string, n?: number): AnswerRow {
  const { path, name, heading, text, key, ord, id } = c
  const hits = heading < 0 ? [] : (sub(text, c.best.query)?.hits ?? [])
  const line = c.best.line === undefined ? {} : { line: c.best.line }
  return {
    kind: "answer",
    path,
    name,
    heading,
    text,
    key,
    ord,
    id,
    query: c.best.query,
    hits,
    ...line,
    right,
    ...(n ? { n } : {}),
  }
}
const matched = (c: Candidate) => answer(c, truncate(c.best.query, WORD_W))

function idleRows(v: AskView): SwitchRow[] {
  const what = v.cut ? `only the first ${QUESTION_MAX} characters` : "only the question"
  const row: SwitchRow = { kind: "askAction", act: "ask", text: "⏎ ask", note: ` · ${what} → ${hostOf(v)}` }
  if (v.pane) return [row]
  return [
    row,
    ...bullets("· only the question goes out; rerank adds short excerpts", v.width),
    ...bullets("· nothing is written to disk", v.width),
  ]
}

/** A failed ask: the headline (`⏎` asks again), whether anything left, then where to look. */
function askErrorRows(st: AskState, host: string, ollama: boolean, w: number): SwitchRow[] {
  return [
    { kind: "askAction", act: "ask", text: st.error ?? "", note: "", error: true },
    note(st.sent ? `the question was sent to ${host}` : "nothing was sent"),
    RULE_ROW,
    ...bullets(ollama ? "· is ollama running? ⏎ tries again" : "· check the endpoint and key · ⏎ tries again", w),
    ...bullets("· the ai block lives in config.json; r re-reads it", w),
  ]
}

function noneRows(v: AskView, searched: SwitchRow): SwitchRow[] {
  return [
    note("Nothing in your notes", "text"),
    searched,
    RULE_ROW,
    ...bullets(`· the question may not be in this folder (${v.notes})`, v.width),
    ...bullets("· edit it and ⏎ to ask again, or drop the ? to search names and text yourself", v.width),
  ]
}

/** Reranked: the model's picks marked ¹ ² ³ with their whys as footnotes under a rule, then the other matches. */
function rerankedRows(v: AskView, top: Candidate[], searched: SwitchRow): SwitchRow[] {
  const shown = new Set(top.map((c) => c.id))
  const rest = v.cands.filter((c) => !shown.has(c.id))
  const why = v.state?.why ?? {}
  return [
    { kind: "header", title: "Answers", count: String(top.length), right: askModel(v) },
    ...top.map((c, i) => answer(c, "", i + 1)),
    RULE_ROW,
    ...top.flatMap((c, i): SwitchRow[] => (why[c.id] ? [{ kind: "footnote", n: i + 1, text: why[c.id]! }] : [])),
    ...(rest.length
      ? [{ kind: "header" as const, title: "Other matches", count: String(rest.length) }, ...rest.map(matched)]
      : []),
    searched,
  ]
}

/** The switcher's rows for a `?` question, for every stage (`askStage`). */
export function askRows(v: AskView): SwitchRow[] {
  const stage = askStage(v)
  const model = askModel(v)
  const searched = note((v.state?.queries ?? []).join(" · "), "text", "searched: ")
  const secs = v.secs >= 1 ? ` · ${v.secs} s` : ""
  switch (stage) {
    case "off":
      return [note(`AI off · set "ai" in config.json`)]
    case "short":
      return [note("type a question")]
    case "target":
      return [note(v.target && "error" in v.target ? v.target.error : "", "error")]
    case "idle":
      return idleRows(v)
    case "asking":
      return [RULE_ROW, { kind: "askWait", text: waitText(model, v.secs) }]
    case "error":
      return askErrorRows(v.state!, hostOf(v), !!v.target && "ollama" in v.target && v.target.ollama, v.width)
    case "none":
      return noneRows(v, searched)
    case "reranked":
      return rerankedRows(v, picked(v), searched)
  }
  const tail: SwitchRow =
    stage === "reranking"
      ? { kind: "askWait", text: `ranking ${v.cands.length} excerpts · ${truncate(model, MODEL_W)}${secs}` }
      : { kind: "askAction", act: "rerank", text: "↻ rerank with excerpts", note: ` · ${v.cost}` }
  return [
    { kind: "header", title: "Matches", count: String(v.cands.length) },
    ...v.cands.map(matched),
    RULE_ROW,
    tail,
    searched,
  ]
}

/** `text` wrapped to `w` columns in `fg`. */
const para = (text: string, fg: string, w: number): Span[][] => wrap([{ text, fg }], Math.max(4, w))

/**
 * The pane beside the list (from PEEK_MIN_W) before there are answers to peek: idle, what `⏎` sends and what comes
 * back; asking, exactly what went out, which is only the question. null for the other stages (the row's peek).
 */
export function askPaneLines(t: Theme, v: AskView, w: number): Span[][] | null {
  const stage = askStage(v)
  const host = hostOf(v)
  if (stage === "idle")
    return [
      [{ text: "Ask your notes", fg: t.text, attr: A.BOLD }],
      [],
      ...para(
        `⏎ sends only the question to ${askModel(v)} on ${host}. It replies with search words; brothy looks them up here, in your notes.`,
        t.textMuted,
        w,
      ),
      [],
      ...para(
        `Then ↻ rerank can send a short excerpt of each match (about ${EXCERPT} characters) so the model picks the best.`,
        t.textMuted,
        w,
      ),
      [],
      ...para("Nothing is written to disk.", t.textMuted, w),
    ]
  if (stage !== "asking") return null
  return [
    [{ text: truncate(`sent to ${host}`, w), fg: t.textMuted }],
    [],
    ...para(`“${v.question}”`, t.text, w),
    [{ text: `${[...v.question].length} characters · nothing else`, fg: t.textMuted }],
    [],
    ...para(
      "The answers will be sections of your notes, found here; the model never sees them unless you rerank.",
      t.textMuted,
      w,
    ),
  ]
}

/** `tab` in ask mode: from an answer to the next action row, else to the next section (wrapping). */
export function askSection(rows: readonly SwitchRow[], cur: number): number {
  if (rows[cur]?.kind === "answer") {
    const k = rows.findIndex((r, i) => i > cur && r.kind === "askAction")
    if (k >= 0) return k
  }
  return nextSection(rows, cur)
}

/** Right of the `Ask` title, before `esc`: nothing when AI is off, index progress, the answering model, else the note count. */
export function askTitleNote(v: {
  off: boolean
  state: AskState | undefined
  indexing: string | null
  notes: string
}): string | undefined {
  if (v.off) return undefined
  if (v.indexing) return v.indexing
  const p = v.state?.phase
  if (v.state?.model && p !== "error") return shortModel(v.state.model)
  return v.notes
}
