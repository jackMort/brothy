// The `C-p` switcher's vault index and search: per note its aliases, Source-outline headings and
// searchable text. Pure apart from `fsIO`; App owns the lifecycle.

import { statSync } from "node:fs"
import { dirname, sep } from "node:path"
import { rankNotes, scoreName, stem, type FileNode } from "./files"
import { parseProperties } from "../markdown/frontmatter"
import { parseWikilink, wikiLabel } from "../markdown/lexer"
import { sourceScan } from "../markdown/source"

/** Notes larger than this (bytes) are indexed by name and headings only. */
export const BODY_LIMIT = 2 * 1024 * 1024
/** Files read between yields to the event loop while indexing. */
export const CHUNK = 25

export interface NoteDoc {
  mtime: number
  size: number
  aliases: string[]
  /** the Source outline: index i is `view.headings[i]` once the note is open (outline parity) */
  headings: { text: string; line: number; depth: number }[]
  /** searchable source lines (`sourceScan().text`, heading lines blank, `plainLine`) joined by "\n"; "" over BODY_LIMIT */
  text: string
  /** `text` case-folded with `foldSame`, so offsets carry over */
  lower: string
  /** offset in `text` where each source line starts */
  starts: number[]
}
export interface VaultIndex {
  docs: Map<string, NoteDoc>
}
export const emptyIndex = (): VaultIndex => ({ docs: new Map() })

/** Lowercase without changing the UTF-16 length: a character whose lowercase is longer (İ) stays. */
export function foldSame(s: string): string {
  const l = s.toLowerCase()
  if (l.length === s.length) return l
  return s.replace(/[\s\S]/gu, (c) => {
    const x = c.toLowerCase()
    return x.length === c.length ? x : c
  })
}

const blank = (c: string | undefined) => c === undefined || /\s/.test(c)
const wordy = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c)

/**
 * A source line as the reader sees it: wikilinks by their label, code backticks and a heading's
 * leading `#`s gone, and `*`/`_`/`==` runs dropped where they open or close emphasis (a run with
 * blanks on both sides, like `2 * 3`, or inside a word, like `snake_case`, stays).
 */
export function plainLine(line: string): string {
  const s = line
    .replace(/!?\[\[([^\]\n]+)\]\]/g, (_, inner: string) => wikiLabel(parseWikilink(inner)))
    .replace(/`+/g, "")
    .replace(/^(\s*(?:>\s?)*)#{1,6}(?:\s+|$)/, "$1")
  return s.replace(/\*+|_+|==/g, (run, at: number) => {
    const prev = s[at - 1]
    const next = s[at + run.length]
    if (blank(prev) && blank(next)) return run
    return wordy(prev) && wordy(next) ? run : ""
  })
}

export function indexNote(src: string, mtime: number, size: number): NoteDoc {
  const sc = sourceScan(src)
  const raw = parseProperties(src).find(([k]) => /^alias(es)?$/i.test(k))?.[1] ?? []
  const aliases = (Array.isArray(raw) ? raw : [raw]).map((a) => a.trim()).filter(Boolean)
  const headings = sc.headings.map(({ text, line, depth }) => ({ text, line, depth }))
  if (size > BODY_LIMIT) return { mtime, size, aliases, headings, text: "", lower: "", starts: [] }
  // Headings already answer in their own section, so their lines are not text
  const heads = new Set(sc.headings.flatMap((h) => Array.from({ length: h.end - h.line + 1 }, (_, k) => h.line + k)))
  const lines = sc.text.map((l, i) => (heads.has(i) ? "" : plainLine(l)))
  const starts: number[] = []
  let at = 0
  for (const l of lines) {
    starts.push(at)
    at += l.length + 1
  }
  const text = lines.join("\n")
  return { mtime, size, aliases, headings, text, lower: foldSame(text), starts }
}

export interface IndexIO {
  stat(path: string): { mtime: number; size: number } | null
  read(path: string): Promise<string>
}
export const fsIO: IndexIO = {
  stat(p) {
    try {
      const s = statSync(p)
      return { mtime: s.mtimeMs, size: s.size }
    } catch {
      return null
    }
  },
  read: (p) => Bun.file(p).text(),
}

/** Every note under `tree`, in tree order. */
export function notesOf(tree: FileNode): FileNode[] {
  const out: FileNode[] = []
  const walk = (n: FileNode) => n.children.forEach((c) => (c.dir ? walk(c) : out.push(c)))
  walk(tree)
  return out
}

/**
 * Bring `ix` up to date with `tree`: notes gone from the tree, or unreadable, are dropped;
 * new notes and notes whose mtime or size changed are (re-)read. Yields every CHUNK reads
 * after reporting progress, and stops (resolving false) once `live()` is false.
 */
export async function refreshIndex(
  ix: VaultIndex,
  tree: FileNode,
  io: IndexIO = fsIO,
  progress: (done: number, total: number) => void = () => {},
  live: () => boolean = () => true,
): Promise<boolean> {
  const notes = notesOf(tree)
  const keep = new Set(notes.map((n) => n.path))
  for (const p of ix.docs.keys()) if (!keep.has(p)) ix.docs.delete(p)
  let reads = 0
  for (let i = 0; i < notes.length; i++) {
    const p = notes[i]!.path
    const st = io.stat(p)
    const old = ix.docs.get(p)
    if (!st) {
      ix.docs.delete(p)
      continue
    }
    if (old && old.mtime === st.mtime && old.size === st.size) continue
    let src: string
    try {
      src = await io.read(p)
    } catch {
      ix.docs.delete(p)
      continue
    }
    if (!live()) return false
    ix.docs.set(p, indexNote(src, st.mtime, st.size))
    if (++reads % CHUNK === 0) {
      progress(i + 1, notes.length)
      await new Promise((r) => setTimeout(r, 0))
      if (!live()) return false
    }
  }
  progress(notes.length, notes.length)
  return true
}

// ------------------------------------------------------------- search

export const SWITCH_CAP = { notes: 30, headings: 30, text: 50, perNote: 3 }
/** Fewest code points a query needs before note bodies are searched. */
const TEXT_MIN = 3
/** Code points of context kept before a text match. */
const BEFORE = 20

interface HitBase {
  path: string
  /** note name without extension */
  name: string
  /** folder of the note, "/"-joined; "" at the root */
  folder: string
}
export type NoteHit = HitBase & { kind: "note"; hits: number[]; alias?: { text: string; hits: number[] } }
/** `heading` indexes the Source outline, which is `view.headings` once open */
export type HeadingHit = HitBase & { kind: "heading"; heading: number; text: string; hits: number[] }
/** `line` is the source line; `heading` the outline index of its section (null before the first heading) */
export type TextHit = HitBase & { kind: "text"; heading: number | null; line: number; context: string; hits: number[] }
export type SwitchHit = NoteHit | HeadingHit | TextHit
export interface Section {
  title: string
  /** shown right of the title: "12", "30 of 112", "50+" */
  count: string
  hits: SwitchHit[]
}

const base = (n: FileNode): HitBase => {
  const d = dirname(n.rel)
  return { path: n.path, name: stem(n.name), folder: d === "." ? "" : d.split(sep).join("/") }
}
const countOf = (shown: number, total: number) => (total > shown ? `${shown} of ${total}` : String(shown))

/** The switcher's sections for `q`, empty ones left out: Notes, Headings, Text. `open`'s text hits come first. */
export function searchVault(ix: VaultIndex | null, tree: FileNode, q: string, open: string | null = null): Section[] {
  const needle = q.trim()
  if (!needle) return []
  const out: Section[] = []
  const ranked = rankNotes(tree, needle, SWITCH_CAP.notes, (n) => ix?.docs.get(n.path)?.aliases ?? [])
  if (ranked.rows.length)
    out.push({
      title: "Notes",
      count: countOf(ranked.rows.length, ranked.total),
      hits: ranked.rows.map((r): NoteHit => ({ kind: "note", ...base(r.node), hits: r.hits, ...(r.alias ? { alias: r.alias } : {}) })),
    })
  if (!ix) return out
  const notes = notesOf(tree)
  const heads: (HeadingHit & { score: number })[] = []
  for (const n of notes)
    ix.docs.get(n.path)?.headings.forEach((h, i) => {
      const m = scoreName(h.text, needle)
      if (m) heads.push({ kind: "heading", ...base(n), heading: i, text: h.text, hits: m.hits, score: m.score })
    })
  // stable sort: ties keep tree order, shorter headings first
  heads.sort((a, b) => b.score - a.score || [...a.text].length - [...b.text].length)
  if (heads.length)
    out.push({
      title: "Headings",
      count: countOf(Math.min(heads.length, SWITCH_CAP.headings), heads.length),
      hits: heads.slice(0, SWITCH_CAP.headings).map(({ score: _, ...h }) => h),
    })
  if ([...needle].length >= TEXT_MIN) {
    const text = textHits(ix, notes, needle, open)
    if (text.hits.length) out.push({ title: "Text", count: text.full ? `${SWITCH_CAP.text}+` : String(text.hits.length), hits: text.hits })
  }
  return out
}

function textHits(ix: VaultIndex, notes: FileNode[], needle: string, open: string | null) {
  const want = foldSame(needle)
  const order = open ? [...notes.filter((n) => n.path === open), ...notes.filter((n) => n.path !== open)] : notes
  const hits: TextHit[] = []
  for (const n of order) {
    const doc = ix.docs.get(n.path)
    if (!doc?.lower) continue
    let from = 0
    for (let k = 0; k < SWITCH_CAP.perNote; k++) {
      const at = doc.lower.indexOf(want, from)
      if (at < 0) break
      const line = lineOf(doc.starts, at)
      const start = doc.starts[line]!
      const end = line + 1 < doc.starts.length ? doc.starts[line + 1]! - 1 : doc.text.length
      hits.push({ kind: "text", ...base(n), heading: headingAt(doc.headings, line), line, ...snippet(doc.text.slice(start, end), at - start, want.length) })
      if (hits.length === SWITCH_CAP.text) return { hits, full: true }
      from = end + 1 // one hit per line
    }
  }
  return { hits, full: false }
}

/**
 * Matches of `needle` the Preview shows in a text hit's section before the hit: its heading's
 * title, then one per earlier line (Preview's find counts lines). Picks the hit's own occurrence.
 */
export function hitOrdinal(doc: NoteDoc, hit: TextHit, needle: string): number {
  const want = foldSame(needle.trim())
  const head = hit.heading === null ? null : doc.headings[hit.heading]
  let k = head && foldSame(head.text).includes(want) ? 1 : 0
  for (let i = head ? head.line + 1 : 0; i < hit.line && i < doc.starts.length; i++) {
    const end = i + 1 < doc.starts.length ? doc.starts[i + 1]! - 1 : doc.lower.length
    if (doc.lower.slice(doc.starts[i]!, end).includes(want)) k++
  }
  return k
}

/** Index of the line holding offset `at` (binary search over line starts). */
export function lineOf(starts: number[], at: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= at) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Outline index of the last heading at or above `line`, else null. */
export function headingAt(hs: { line: number }[], line: number): number | null {
  let i = -1
  hs.forEach((h, k) => {
    if (h.line <= line) i = k
  })
  return i < 0 ? null : i
}

/** The line around a match: up to BEFORE code points before it ("…" when cut, else leading space trimmed). */
function snippet(line: string, col: number, len: number): { context: string; hits: number[] } {
  line = line.replace(/\t/g, " ")
  let head = [...line.slice(0, col)]
  const cut = head.length > BEFORE
  if (cut) head = head.slice(-BEFORE)
  const lead = cut ? "…" + head.join("") : head.join("").trimStart()
  const start = [...lead].length
  const n = [...line.slice(col, col + len)].length
  return { context: lead + line.slice(col), hits: Array.from({ length: n }, (_, j) => start + j) }
}

/** Empty query: notes opened this run (newest first), then the open note's folder-mates; never the open note. */
export function recentSection(tree: FileNode, recent: readonly string[], open: string | null): Section[] {
  const notes = notesOf(tree)
  const byPath = new Map(notes.map((n) => [n.path, n]))
  const dir = open ? dirname(open) : null
  const seen = new Set(open ? [open] : [])
  const hits: NoteHit[] = []
  for (const p of [...recent, ...notes.filter((n) => dirname(n.path) === dir).map((n) => n.path)]) {
    const n = byPath.get(p)
    if (!n || seen.has(p)) continue
    seen.add(p)
    hits.push({ kind: "note", ...base(n), hits: [] })
    if (hits.length === SWITCH_CAP.notes) break
  }
  return hits.length ? [{ title: "Recent", count: String(hits.length), hits }] : []
}

/** How many recent notes the ring keeps. */
const RECENT_CAP = 20

/** `path` moved to the front of the recent ring (same array when it already is). */
export function remember(recent: readonly string[], path: string | null, max = RECENT_CAP): readonly string[] {
  if (!path || recent[0] === path) return recent
  return [path, ...recent.filter((p) => p !== path)].slice(0, max)
}

// ------------------------------------------------------------- rows

/** Ask mode (`ask.ts`): a section the local index found for the model's queries; `heading` -1 is the lead-in */
export type AnswerRow = {
  kind: "answer"
  path: string
  name: string
  heading: number
  /** heading text; "" for the lead-in */
  text: string
  /** the section's identity: `headingKey(text)` and its occurrence among equal keys */
  key: string
  ord: number
  id: string
  /** the best-scoring query: where `⏎` lands and what find highlights */
  query: string
  /** code points of `text` that match `query` */
  hits: number[]
  /** muted, right-aligned: `hits/all` queries, or the rerank's why */
  right: string
}
/** Ask mode: `⏎` asks (again) or reranks; `error` leads with a ✗ */
export type AskActionRow = { kind: "askAction"; act: "ask" | "rerank"; text: string; note: string; error?: boolean }
/** Ask mode: a muted line that is never highlighted (states, `searched: …`) */
export type AskNoteRow = { kind: "askNote"; text: string }
export type SwitchRow = { kind: "header"; title: string; count: string } | SwitchHit | AnswerRow | AskActionRow | AskNoteRow

/** Rows the highlight can rest on: not section titles, not ask notes. */
export const isStop = (r: { kind: string }) => r.kind !== "header" && r.kind !== "askNote"

export const switchRows = (sections: Section[]): SwitchRow[] =>
  sections.flatMap((s): SwitchRow[] => [{ kind: "header", title: s.title, count: s.count }, ...s.hits])

/** First stop row at or after `from`; -1 when there is none. */
export const firstHit = (rows: readonly { kind: string }[], from = 0): number => rows.findIndex((r, k) => k >= from && isStop(r))

/** The next stop row from `cur` in `dir`, skipping headers and notes; stays put at either end. */
export function stepRow(rows: readonly { kind: string }[], cur: number, dir: 1 | -1): number {
  for (let k = cur + dir; k >= 0 && k < rows.length; k += dir) if (isStop(rows[k]!)) return k
  return cur
}

/** First hit of the section after the one holding `cur`; past the last section, the first one. */
export function nextSection(rows: readonly { kind: string }[], cur: number): number {
  for (let k = cur + 1; k < rows.length; k++) if (rows[k]!.kind === "header") return firstHit(rows, k)
  return firstHit(rows)
}
