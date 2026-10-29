// Ask → jump (`?` in the `C-p` switcher). The model turns a question into search queries (tier 0)
// or orders excerpts brothy picked (tier 1); every answer is a place the local index found. Pure.

import { cleanReply, cleanSummary, extractJSON, fmtTokens, shortModel, tokens, type ChatReq } from "./ai"
import { SCORE_SUBSEQUENCE, scoreName, stem, type FileNode } from "./files"
import { isRecord } from "./json"
import { headingKey } from "./panel"
import { sectionId } from "./sections"
import { safeLine } from "./spans"
import { truncate } from "./status"
import { SWITCH_CAP, foldSame, headingAt, lineOf, nextSection, notesOf, type AnswerRow, type NoteDoc, type SwitchRow, type VaultIndex } from "./vault"
import { headingPath } from "./zen"

/** `PROMPTS.ask` (ai-config.ts): bump it with any change. */
export const ASK_PROMPT =
  'Turn the user\'s question about their own notes into 3–8 short search queries (1–3 words each) that are likely to appear verbatim in the notes or their headings: key terms, synonyms, likely heading words. Use the question\'s language, and add English variants if it is not English. Reply with JSON only: {"queries": ["…"]}.'
/** `PROMPTS.rerank` (ai-config.ts): bump it with any change. */
export const RERANK_PROMPT =
  'Given a question and numbered excerpts from the user\'s notes, pick the excerpts that help answer it, best first. Reply with JSON only: {"answers": [{"id": "c3", "why": "at most 8 words"}]}. Use only ids from the list; leave out excerpts that don\'t help.'

/** Code points of a question that are sent; longer ones are cut. */
export const QUESTION_MAX = 300
/** Fewest code points a question needs before it can be asked. */
export const ASK_MIN = 3
/** Queries kept from tier 0's reply. */
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
export const sub = (name: string, q: string) => {
  const m = scoreName(name, q)
  return m && m.score > SCORE_SUBSEQUENCE ? m : null
}

/** Each heading's identity: its key and how many equal keys come before it; the lead-in counts as key "", as in `noteSections`. */
export function keysOf(doc: NoteDoc): { key: string; ord: number }[] {
  const seen = new Map<string, number>([["", 1]])
  return doc.headings.map((h) => {
    const key = headingKey(h.text)
    const ord = seen.get(key) ?? 0
    seen.set(key, ord + 1)
    return { key, ord }
  })
}

/** Source lines [from, to) of section `i` (-1: the lead-in): up to the next heading of any depth. */
export function sectionLines(doc: NoteDoc, i: number): [number, number] {
  const from = i < 0 ? 0 : doc.headings[i]!.line + 1
  return [from, doc.headings[i + 1]?.line ?? doc.starts.length]
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
    if (!doc) continue
    const secs = new Map<number, { kinds: Map<string, number>; lines: Map<string, number> }>()
    const hit = (heading: number, q: string, kind: number, line?: number) => {
      let a = secs.get(heading)
      if (!a) secs.set(heading, (a = { kinds: new Map(), lines: new Map() }))
      if ((a.kinds.get(q) ?? 0) < kind) a.kinds.set(q, kind)
      if (line !== undefined && !a.lines.has(q)) a.lines.set(q, line)
    }
    const name = stem(n.name)
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
    const ids = keysOf(doc)
    for (const [heading, a] of [...secs].sort(([x], [y]) => x - y)) {
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
        order: out.length,
      })
    }
  }
  out.sort((a, b) => b.score - a.score || b.queries - a.queries || a.order - b.order)
  return out.slice(0, MAX_CANDIDATES).map(({ order: _, ...c }) => c)
}

/**
 * Where an answer lands in `doc`, the note as it is now: its section found again by key and
 * occurrence, then the first line there holding `query`. null when the heading is gone.
 */
export function askLocate(doc: NoteDoc, a: { heading: number; key: string; ord: number; query: string }): { heading: number; line: number | null } | null {
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
export function excerpt(doc: NoteDoc, heading: number): string {
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

export type AskPhase = "asking" | "result" | "reranking" | "reranked" | "error"
/** `ui.switcher.ask`: absent while idle; any edit of the query drops it. */
export interface AskState {
  question: string
  phase: AskPhase
  /** tier 0's queries (memoized per question) */
  queries?: string[]
  /** the model that answered (full id; shown through shortModel) */
  model?: string
  /** tier 1: section ids, best first, and each one's why */
  order?: string[]
  why?: Record<string, string>
  /** the toast of the failed ask */
  error?: string
}
export interface AskView {
  question: string
  /** the question was cut at QUESTION_MAX */
  cut: boolean
  /** where tier 0 goes, why it can't (resolveAI's toast), or null without an `ai` block */
  target: { host: string } | { error: string } | null
  state: AskState | undefined
  /** askCandidates for `state.queries` on a complete index */
  cands: readonly Candidate[]
  /** rerankCost of `cands` */
  cost: string
  /** the vault index is still building: ranking waits for it */
  indexing: boolean
}

const note = (text: string): SwitchRow => ({ kind: "askNote", text })

function answer(c: Candidate, right: string): AnswerRow {
  const { path, name, heading, text, key, ord, id } = c
  const hits = heading < 0 ? [] : (sub(text, c.best.query)?.hits ?? [])
  return { kind: "answer", path, name, heading, text, key, ord, id, query: c.best.query, hits, right }
}

/** The switcher's rows for a `?` question, for every state of the spec's UX table. */
export function askRows(v: AskView): SwitchRow[] {
  const st = v.state
  if (!v.target) return [note(`AI off · set "ai" in config.json`)]
  if ([...v.question].length < ASK_MIN) return [note("type a question")]
  if (!st) {
    if ("error" in v.target) return [note(v.target.error)]
    return [{ kind: "askAction", act: "ask", text: "⏎ ask", note: ` · only the question${v.cut ? "…" : ""} → ${v.target.host}` }]
  }
  if (st.phase === "error") return [{ kind: "askAction", act: "ask", text: `${st.error ?? ""} · ⏎ asks again`, note: "", error: true }]
  if (st.phase === "asking" || v.indexing) return [note("asking…")]
  const queries = st.queries ?? []
  const searched = `searched: ${queries.join(" · ")}`
  if (!v.cands.length) return [note(`nothing found · ${searched}`)]
  const hits = (c: Candidate) => `${c.queries}/${queries.length}`
  const byId = new Map(v.cands.map((c) => [c.id, c]))
  const top = st.phase === "reranked" ? (st.order ?? []).flatMap((id) => byId.get(id) ?? []) : []
  if (top.length) {
    const shown = new Set(top.map((c) => c.id))
    const rest = v.cands.filter((c) => !shown.has(c.id))
    return [
      { kind: "header", title: "Answers", count: String(top.length) },
      ...top.map((c) => answer(c, st.why?.[c.id] ?? "")),
      ...(rest.length ? [{ kind: "header" as const, title: "Other matches", count: String(rest.length) }, ...rest.map((c) => answer(c, hits(c)))] : []),
      note(searched),
    ]
  }
  return [
    { kind: "header", title: "Answers", count: String(v.cands.length) },
    ...v.cands.map((c) => answer(c, hits(c))),
    st.phase === "reranking" ? note("reranking…") : { kind: "askAction", act: "rerank", text: "↻ rerank with excerpts", note: ` · ${v.cost}` },
    note(searched),
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
export function askTitleNote(v: { off: boolean; state: AskState | undefined; indexing: string | null; notes: string }): string | undefined {
  if (v.off) return undefined
  if (v.indexing) return v.indexing
  const p = v.state?.phase
  if (v.state?.model && (p === "result" || p === "reranking" || p === "reranked")) return shortModel(v.state.model)
  return v.notes
}
