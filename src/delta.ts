/**
 * Explain a live reload, the pure side: which sections of the open note changed since its
 * baseline, the hunks sent to the model, and what of its reply is kept.
 */

import { cleanSummary, stripThink } from "./ai"
import { noteSections, type NoteSection } from "./sections"
import { truncate } from "./status"
import { plainLine } from "./vault"

/** One line of a diff: unchanged (" "), removed ("-") or added ("+"). */
export type Op = { op: " " | "-" | "+"; text: string }
/** A changed run with its context lines. */
export interface Hunk {
  ops: Op[]
}

/** LCS cells allowed (changed old lines × changed new lines); over it a section is sent as `rewritten`. */
export const DIFF_CELLS = 1_000_000
/** LCS cells allowed for a whole reload, all sections together (~60 ms); over it the reload is not compared. */
export const DIFF_BUDGET = 4 * DIFF_CELLS

/** Lengths of the common head and tail (not overlapping). */
function common(a: string[], b: string[]): [head: number, tail: number] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return [head, tail]
}

/** The LCS cells `lineDiff(a, b)` needs: changed old lines × changed new lines. */
export function diffCells(a: string[], b: string[]): number {
  const [head, tail] = common(a, b)
  return (a.length - head - tail) * (b.length - head - tail)
}

/**
 * Line diff by longest common subsequence (no dependency). The common head and tail are cut
 * first, so the cap applies to the changed middle only; null when that middle is over `cap` cells.
 * Removals come before additions where both fit.
 */
export function lineDiff(a: string[], b: string[], cap = DIFF_CELLS): Op[] | null {
  const [head, tail] = common(a, b)
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const n = x.length
  const m = y.length
  if (n * m > cap) return null
  // lcs[i * w + j]: length of the LCS of x[i..] and y[j..]
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
  const ops: Op[] = a.slice(0, head).map((text) => ({ op: " ", text }))
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push({ op: " ", text: x[i]! })
      i++
      j++
    } else if (i < n && (j === m || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) ops.push({ op: "-", text: x[i++]! })
    else ops.push({ op: "+", text: y[j++]! })
  }
  for (const text of a.slice(a.length - tail)) ops.push({ op: " ", text })
  return ops
}

/** The changed runs with `context` unchanged lines on each side; runs whose context touches merge. */
export function hunks(ops: Op[], context = 1): Hunk[] {
  const spans: { from: number; to: number }[] = []
  ops.forEach((o, k) => {
    if (o.op === " ") return
    const from = Math.max(0, k - context)
    const to = Math.min(ops.length, k + 1 + context)
    const last = spans.at(-1)
    if (last && from <= last.to) last.to = Math.max(last.to, to)
    else spans.push({ from, to })
  })
  return spans.map((s) => ({ ops: ops.slice(s.from, s.to) }))
}

export type ChangeStatus = "edited" | "added" | "removed"
/** One section that differs between the baseline and the note on disk. */
export interface Change {
  status: ChangeStatus
  /** outline index in the new text (in the old one for `removed`); -1: the lead-in before the first heading */
  index: number
  /** heading texts from the top level down ([] for the lead-in) */
  path: string[]
  key: string
  ord: number
  /** changed lines: added / removed */
  plus: number
  minus: number
  /** edited: the changed runs with 1 context line; added / removed: one hunk of all its lines; rewritten: [] */
  hunks: Hunk[]
  /** an edit whose line diff was over the cell cap: sent as its new text only */
  rewritten: boolean
  /** the section's lines in the new text, heading line included ("" for removed) */
  newText: string
}

/** Above this many UTF-16 units on either side, a reload is not compared (as the vault's BODY_LIMIT). */
export const DIFF_LIMIT = 2 * 1024 * 1024

interface Sec {
  s: NoteSection
  /** heading line first, trailing whitespace trimmed, no blank lines at either end */
  lines: string[]
  path: string[]
}

function sectionsOf(text: string): Sec[] {
  const lines = text.split("\n").map((l) => l.trimEnd())
  const stack: string[] = []
  const out: Sec[] = []
  for (const s of noteSections(text)) {
    let from = s.index < 0 ? s.own[0] : s.line
    let to = s.own[1]
    while (from < to && !lines[from]) from++
    while (to > from && !lines[to - 1]) to--
    if (s.index < 0 && from === to) continue // no lead-in
    let path: string[] = []
    if (s.index >= 0) {
      stack.splice(s.depth - 1)
      stack[s.depth - 1] = s.text
      path = stack.filter((x) => x !== undefined)
    }
    out.push({ s, lines: lines.slice(from, to), path })
  }
  return out
}

/** Sections match by heading key and occurrence; the lead-in matches the lead-in. */
const idOf = (x: Sec) => (x.s.index < 0 ? "\0lead" : `${x.s.key}\0${x.s.ord}`)
const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i])
const all = (op: Op["op"], lines: string[]): Op[] => lines.map((text) => ({ op, text }))

function change(status: ChangeStatus, x: Sec, rest: Pick<Change, "plus" | "minus" | "hunks" | "rewritten" | "newText">): Change {
  return { status, index: x.s.index, path: x.path, key: x.s.key, ord: x.s.ord, ...rest }
}

/**
 * The sections of `after` that differ from `before` (both `noteText`): matched by `(key, ord)`;
 * unmatched old → removed, unmatched new → added, matched with other lines → edited. A renamed
 * heading is removed + added. Null when either side is over `DIFF_LIMIT`, or when the edited
 * sections' line diffs need over `DIFF_BUDGET` cells together (a rewritten section needs none).
 */
export function diffSections(before: string, after: string): Change[] | null {
  if (before.length > DIFF_LIMIT || after.length > DIFF_LIMIT) return null
  if (before === after) return []
  const olds = sectionsOf(before)
  const news = sectionsOf(after)
  const oldById = new Map(olds.map((x) => [idOf(x), x]))
  const newIds = new Set(news.map(idOf))
  // a removed section is listed after the nearest earlier section both texts share
  const removedAfter = new Map<string | null, Sec[]>()
  let anchor: string | null = null
  for (const o of olds) {
    if (newIds.has(idOf(o))) anchor = idOf(o)
    else {
      const list = removedAfter.get(anchor)
      if (list) list.push(o)
      else removedAfter.set(anchor, [o])
    }
  }
  const out: Change[] = []
  let budget = DIFF_BUDGET
  const pushRemoved = (list: Sec[] | undefined) => {
    for (const o of list ?? []) out.push(change("removed", o, { plus: 0, minus: o.lines.length, hunks: [{ ops: all("-", o.lines) }], rewritten: false, newText: "" }))
  }
  pushRemoved(removedAfter.get(null))
  for (const n of news) {
    const o = oldById.get(idOf(n))
    const newText = n.lines.join("\n")
    if (!o) out.push(change("added", n, { plus: n.lines.length, minus: 0, hunks: [{ ops: all("+", n.lines) }], rewritten: false, newText }))
    else if (!sameLines(o.lines, n.lines)) {
      const cells = diffCells(o.lines, n.lines)
      if (cells <= DIFF_CELLS && (budget -= cells) < 0) return null
      const ops = cells <= DIFF_CELLS ? lineDiff(o.lines, n.lines) : null
      out.push(
        ops
          ? change("edited", n, { plus: ops.filter((x) => x.op === "+").length, minus: ops.filter((x) => x.op === "-").length, hunks: hunks(ops), rewritten: false, newText })
          : change("edited", n, { plus: n.lines.length, minus: o.lines.length, hunks: [], rewritten: true, newText }),
      )
    }
    pushRemoved(removedAfter.get(idOf(n)))
  }
  return out
}

/** `PROMPTS.delta` (ai.ts) is its version; nothing is cached, so a change needs no bump to be safe, but bump it anyway. */
export const DELTA_PROMPT =
  'You are shown the sections of a note that changed, as line diffs (`-` removed, `+` added, two spaces = unchanged context), each with an id like §2. First write 1–2 sentences, at most 40 words, on what changed overall and why it matters to a reader. Then one line per section id you can describe, at most 10 of them, the changes that matter most: `§<id>: <at most 12 words>`, optionally followed by ` | "<a short phrase copied exactly from a + line>"`. Plain text, no markdown. Same language as the note.'
/** The user message stays within this many code points (or the target's `maxChars`, if lower), unless the `Note:` line alone is longer. */
export const DELTA_MAX = 16_000
/** Lines of a removed section that are sent. */
export const REMOVED_LINES = 20
/** `chat`'s `maxOut`: a summary and the prompt's 10 section lines fit; past it App keeps the finished part. */
export const MAX_DELTA = 2000

const codePoints = (s: string) => {
  let n = 0
  for (const _ of s) n++
  return n
}
const opLine = (o: Op) => (o.op === " " ? "  " : o.op + " ") + o.text

function sectionBody(c: Change): string[] {
  if (c.rewritten) return c.newText.split("\n").map((t) => "+ " + t)
  const ops = c.hunks.flatMap((h) => h.ops)
  if (c.status === "removed") return [...ops.slice(0, REMOVED_LINES).map(opLine), ...(ops.length > REMOVED_LINES ? ["- …"] : [])]
  if (c.status === "added") return ops.map(opLine)
  return c.hunks.flatMap((h) => ["@@", ...h.ops.map(opLine)])
}

/**
 * The user message: `Note: <title>`, then `§n <status> · <path>` and its lines; past `max` code
 * points, headings only, and once those no longer fit either, one unnumbered `… and N more
 * sections` line (the model is never given an id it could describe without seeing it listed).
 */
export function deltaMessage(title: string, changes: Change[], max: number): string {
  const out = [`Note: ${title}`]
  let used = codePoints(out[0]!)
  const more = (n: number) => `… and ${n} more section${n === 1 ? "" : "s"}`
  /** whether `text` fits, leaving room for the line that would count the sections after it */
  const fits = (text: string, i: number) => {
    const left = changes.length - i - 1
    return used + 1 + codePoints(text) + (left ? 1 + codePoints(more(left)) : 0) <= max
  }
  const add = (text: string) => {
    out.push(text)
    used += 1 + codePoints(text)
  }
  let full = true
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!
    const head = `§${i + 1} ${c.rewritten ? "rewritten" : c.status} · ${c.path.length ? c.path.join(" › ") : title}`
    if (full) {
      const block = [head, ...sectionBody(c)].join("\n")
      if (fits(block, i)) {
        add(block)
        continue
      }
      full = false
    }
    if (!fits(`${head} (not shown)`, i)) {
      out.push(more(changes.length - i))
      break
    }
    add(`${head} (not shown)`)
  }
  return out.join("\n")
}

export interface DeltaNote {
  what: string
  /** a phrase of the section's + lines (whitespace collapsed): where `⏎` lands; never displayed */
  quote?: string
}
/** `notes[i]` belongs to `changes[i]` (`§(i + 1)`). */
export interface DeltaParse {
  summary: string
  notes: (DeltaNote | undefined)[]
}

const SUMMARY_MAX = 300
const WHAT_MAX = 80
const QUOTE_MIN = 8
const isIdLine = (l: string) => /^[\s>*_\-•]*§/.test(l)
const ID_LINE = /^[\s>*_\-•]*§\s*(\d+)\s*(?:\*\*)?\s*[:.)–—-]?\s*(?:\*\*)?\s*(.*)$/
const collapse = (s: string) => s.replace(/\s+/g, " ").trim()
const unquote = (s: string) => collapse(s.trim().replace(/^["“”'`]+|["“”'`]+$/g, ""))

/** The + lines of a change, as one whitespace-collapsed text (quotes must occur in it). */
function plusText(c: Change): string {
  const lines = c.rewritten || c.status === "added" ? c.newText.split("\n") : c.hunks.flatMap((h) => h.ops.filter((o) => o.op === "+").map((o) => o.text))
  return collapse(lines.join(" "))
}

/**
 * What of the model's reply is kept: the text before the first `§` line as the summary, and one
 * note per `§n` that was sent (first wins). `partial`: the reply is still streaming, so an
 * unfinished last `§` line is ignored. Null when there is neither a summary nor a valid note.
 */
export function parseDelta(raw: string, changes: Change[], partial = false): DeltaParse | null {
  let text = stripThink(raw)
  if (/^\s*<think>/.test(text)) text = "" // only the first block is dropped: a second one means nothing usable
  const lines = text.split("\n")
  const first = lines.findIndex(isIdLine)
  const ids = first < 0 ? [] : lines.slice(first).filter(isIdLine)
  if (partial && ids.length && isIdLine(lines.at(-1)!)) ids.pop()
  let summary = cleanSummary((first < 0 ? lines : lines.slice(0, first)).join("\n"))
  if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX - 1).trimEnd() + "…"
  const notes: (DeltaNote | undefined)[] = changes.map(() => undefined)
  let any = false
  for (const l of ids) {
    const m = ID_LINE.exec(l)
    if (!m) continue
    const i = Number(m[1]) - 1
    const c = changes[i]
    if (!c || notes[i]) continue
    const bar = m[2]!.lastIndexOf(" | ")
    const what = truncate(cleanSummary(bar < 0 ? m[2]! : m[2]!.slice(0, bar)), WHAT_MAX)
    if (!what) continue
    const quote = bar < 0 || c.status === "removed" ? "" : unquote(m[2]!.slice(bar + 3))
    notes[i] = quote.length >= QUOTE_MIN && plusText(c).includes(quote) ? { what, quote } : { what }
    any = true
  }
  return summary || any ? { summary, notes } : null
}

/** The live-reload toast (spec: After a reload). */
export function reloadToast(changes: Change[] | null, propsChanged: boolean, ai: boolean): string {
  if (changes === null) return "reloaded · too large to compare"
  const n = changes.length
  if (n) return `reloaded · ${n} section${n === 1 ? "" : "s"} changed${ai ? " · D explains" : ""}`
  return propsChanged ? "reloaded · properties changed" : "reloaded from disk"
}

/** Local `HH:MM`. */
export const hhmm = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** What `findQuote` looks for: Source rows show the Markdown as written; Preview drops list/task markers and inline marks. */
export const quoteNeedle = (quote: string, source: boolean) =>
  source ? quote : plainLine(quote.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""))
