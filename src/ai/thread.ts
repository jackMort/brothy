// Chat about the open note, pure: what a thread holds, what one send carries (the notes clipped to the budget, the
// earlier turns, the question), the prompt, and the reply taken apart into text, marks and verified quotes.
// The app side is app/pill.ts; drawing is ui/pill.ts.

import { parseFrontMatter } from "../markdown/frontmatter"
import { normalize, scanComments } from "../markdown/lexer"
import { decode } from "../markdown/render"
import { type NoteSection, noteSections } from "../markdown/sections"
import { plainLine } from "../notes/vault"
import { type Flat, flatten, spanIn } from "../ui/nav"
import { sameText } from "../ui/status"
import { type ChatReq, cleanReply, clip, type Msg, tokensOf } from "./client"
import { keepSentences } from "./gloss"

/** characters of one note sent at most */
export const CHAT_NOTE_MAX = 24_000
/** the share of `maxChars` the earlier turns may use */
const CHAT_TURNS_SHARE = 0.25
/** the cleaned reply's cap; a longer one is kept to its last finished sentence */
export const MAX_CHAT = 6000
/** notes one thread holds at most (its chips) */
export const CHAT_MAX_CHIPS = 6
/** words of one quote the prompt asks for at most */
const QUOTE_MAX_WORDS = 20

/** The chat's system prompt: bump `PROMPTS.chat` (ai/config.ts) with any change. */
export const CHAT_PROMPT = `You answer questions about the user's notes, given below between \`<note>\` tags. Answer from the notes; where they say nothing, say so in one sentence before anything else you add. Plain text, at most 150 words unless the question asks for more; no headings, lists or tables. After each claim taken from a note put a mark like [1]. Then write a line \`Sources:\` and, for each mark, one line \`[n] note <id>: "<exact words>"\`, copying at most ${QUOTE_MAX_WORDS} words character for character from that note. Write in the language of the question.`

/** A note in the thread's context: its path, and the title its chip and `<note>` tag show (stem, or the piped document's). */
export interface Chip {
  path: string
  title: string
}
/** A verified mark: `n` 1..k after renumbering, the note and the words it rests on, the source line they start on. */
export interface Cite {
  n: number
  path: string
  quote: string
  line: number
}
/** Answer text, or a cite number. */
export type Part = string | number
/** One question and its answer. */
export interface Exchange {
  q: string
  at: number
  model: string
  /** the cleaned reply as the model wrote it: sent back as the assistant turn */
  raw: string | null
  /** the shown answer and its verified cites, set when done */
  parts: Part[]
  cites: Cite[]
  /** aiMessage(…, noun "answer") */
  error: string | null
  /** when the marks start to glow */
  doneAt: number | null
}
/** A chat thread: the note it belongs to, the notes it carries, its exchanges. */
export interface Thread {
  path: string
  chips: Chip[]
  turns: Exchange[]
}
interface SentNote {
  chip: Chip
  text: string
  clipped: boolean
}
/** What one send carries: the notes as clipped, the earlier turns, and its size in tokens. */
export interface SentContext {
  notes: SentNote[]
  turns: Msg[]
  size: number
}

const cp = (s: string) => [...s].length

/** The newest answered exchanges whose characters fit `room`, oldest first, as user/assistant pairs. */
function recentTurns(turns: readonly Exchange[], room: number): Msg[] {
  const out: Msg[] = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const e = turns[i]!
    if (e.raw === null || e.error !== null) continue
    const n = cp(e.q) + cp(e.raw)
    if (used + n > room) break
    used += n
    out.unshift({ role: "user", content: e.q }, { role: "assistant", content: e.raw })
  }
  return out
}

/** Code points of `s`, counted to `max + 1` at most: enough to tell whether `clip` cuts it at `max`. */
function cpUpTo(s: string, max: number): number {
  if (s.length <= max) return cp(s)
  let n = 0
  for (let i = 0; i < s.length && n <= max; n++) i += s.codePointAt(i)! > 0xffff ? 2 : 1
  return n
}

/** Each note in chip order, clipped to CHAT_NOTE_MAX and to what is `left`; one left with nothing is empty and clipped. */
function clipNotes(texts: readonly string[], chips: readonly Chip[], left: number): SentNote[] {
  return chips.map((chip, i) => {
    const full = texts[i] ?? ""
    const cap = Math.min(CHAT_NOTE_MAX, left)
    const n = cpUpTo(full, Math.max(0, cap))
    left = Math.max(0, left - Math.min(n, cap))
    if (cap <= 0) return { chip, text: "", clipped: true }
    return n > cap ? { chip, text: clip(full, cap), clipped: true } : { chip, text: full, clipped: false }
  })
}

/** What `⏎` would send for `question`: the turns first (their share), the notes in what is left, and the size. */
export function chatContext(
  texts: readonly string[],
  chips: readonly Chip[],
  turns: readonly Exchange[],
  question: string,
  maxChars: number,
): SentContext {
  const sent = recentTurns(turns, Math.floor(maxChars * CHAT_TURNS_SHARE))
  const used = cp(CHAT_PROMPT) + cp(question) + sent.reduce((n, m) => n + cp(m.content), 0)
  const notes = clipNotes(texts, chips, maxChars - used)
  return { notes, turns: sent, size: tokensOf(used + systemTail(notes)) }
}

/** A `title` attribute's value: no double quote can end it. */
const attr = (s: string) => s.replace(/"/g, "'")
/** Note `i`'s tag around its text. */
const noteOpen = (n: SentNote, i: number) => `<note id="${i + 1}" title="${attr(n.chip.title)}">\n`
const NOTE_CLOSE = "\n</note>"
/** The system message after CHAT_PROMPT: the blank line, then the notes' tags one per line. */
const SYSTEM_GAP = "\n\n"

/** Code points the system message holds past CHAT_PROMPT, counted from its parts rather than built. */
const systemTail = (notes: readonly SentNote[]) =>
  notes.reduce((k, n, i) => k + (i ? 1 : 0) + cp(noteOpen(n, i)) + cp(n.text) + NOTE_CLOSE.length, SYSTEM_GAP.length)

/** The request for `question` over `ctx`: the notes as `<note>` tags after the prompt, the turns, the question. */
export function chatRequest(ctx: Pick<SentContext, "notes" | "turns">, question: string): ChatReq {
  const notes = ctx.notes.map((n, i) => `${noteOpen(n, i)}${n.text}${NOTE_CLOSE}`)
  return {
    system: `${CHAT_PROMPT}${SYSTEM_GAP}${notes.join("\n")}`,
    turns: ctx.turns,
    user: question,
    maxOut: MAX_CHAT,
    clean: cleanReply,
    keep: (s) => keepSentences(s, MAX_CHAT),
  }
}

/** The line that starts the sources: `Sources:`, `**Sources**`, any case. */
const SOURCES = /^\s*\**sources:?\**\s*$/i
/** A last line that may still become SOURCES while it streams. */
const isSourcesStart = (line: string) => {
  const s = line.trim().toLowerCase().replace(/^\*+/, "")
  return s.length > 0 && "sources:".startsWith(s)
}

/** The reply split at its last SOURCES line; before one exists, all body (`streaming`: a last line still becoming one is held back). */
export function splitReply(text: string, streaming = false): { body: string; sources: string } {
  const lines = text.split("\n")
  const at = lines.findLastIndex((l) => SOURCES.test(l))
  if (at >= 0) return { body: lines.slice(0, at).join("\n").trimEnd(), sources: lines.slice(at + 1).join("\n") }
  if (streaming && lines.length > 1 && isSourcesStart(lines.at(-1) ?? "")) lines.pop()
  return { body: lines.join("\n").trimEnd(), sources: "" }
}

/** `[n]`, `[n, m]`, n 1–99: the marks; anything else in brackets is text. */
const MARK = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g

/**
 * The body as text runs and mark numbers (`[1][2]` is two marks); a mark attaches to the word before it, the blanks
 * before it dropped. `starts`: where each part starts in `body` (a mark's numbers all at its `[`), so the dropped
 * blanks still count.
 */
export function bodyRuns(body: string): { parts: Part[]; starts: number[] } {
  const parts: Part[] = []
  const starts: number[] = []
  const push = (p: Part, at: number) => {
    parts.push(p)
    starts.push(at)
  }
  let last = 0
  for (const m of body.matchAll(MARK)) {
    const run = body.slice(last, m.index).replace(/[ \t]+$/, "")
    if (run) push(run, last)
    for (const n of (m[1] ?? "").split(",")) push(Number(n.trim()), m.index)
    last = m.index + m[0].length
  }
  if (last < body.length) push(body.slice(last), last)
  return { parts, starts }
}

/** `bodyRuns`' parts alone. */
export const bodyParts = (body: string): Part[] => bodyRuns(body).parts

/** One `[n] note <id>: "words"` line, as parsed. */
export interface Source {
  n: number
  note: number
  quote: string
}
const SOURCE_LINE = /^\s*\[(\d{1,2})\]\s*(?:note\s*)?(\d+)\s*[:\-–]?\s*["“](.*)["”]\s*$/i

/** The source lines that parse; the rest are dropped. */
export function parseSources(sources: string): Source[] {
  return sources.split("\n").flatMap((line) => {
    const m = SOURCE_LINE.exec(line)
    const quote = m?.[3]?.trim()
    return m && quote ? [{ n: Number(m[1]), note: Number(m[2]), quote }] : []
  })
}

/** A blockquote's `>` run at a line's start, and a callout's `[!kind]` header after it. */
const QUOTE_BAR = /^\s*(?:>\s?)+(?:\[![^\]\n]*\][+-]?\s*)?/
/** A Markdown link (not an image): its text stays. */
const LINK = /(?<!!)\[([^\]\n]*)\]\([^)\n]*\)/g

/**
 * A line as the note reads, for quotes (a source line, or a quote): `plainLine`'s marks, and quote bars and callout
 * headers, link targets, `~~` and entities gone. The vault index keeps `plainLine` alone.
 */
export const seenLine = (line: string): string =>
  decode(plainLine(line.replace(QUOTE_BAR, "")).replace(LINK, "$1").replace(/~~/g, ""))

/**
 * One string per source line, as quotes are checked against it: front matter and comments blank, `seenLine`, code
 * kept. With `shown`, only up to the line where the `shown`th line of `noteText` (no front matter, comment-only lines
 * or leading blank lines) ends: what a clipped send reached.
 */
export function quoteLines(src: string, shown = Number.POSITIVE_INFINITY): string[] {
  const lines = normalize(src).split("\n")
  const { offset } = parseFrontMatter(src)
  const { kept, hidden } = scanComments(lines, offset)
  const out: string[] = []
  for (let i = 0, n = 0; i < lines.length && n < shown; i++) {
    const line = i < offset || hidden[i] ? null : (kept[i] ?? "")
    out.push(line === null ? "" : seenLine(line))
    if (line !== null && (n > 0 || line.trim())) n++
  }
  return out
}

/** Append `text` to `out`; right after a dropped mark, a blank before punctuation goes. */
function pushText(out: Part[], text: string, dropped: boolean) {
  const prev = out.at(-1)
  if (typeof prev !== "string") return void out.push(text)
  out[out.length - 1] = dropped && /^[.,;:!?)]/.test(text) ? prev.trimEnd() + text : prev + text
}

/** A note an answer's quotes are checked against: its source, and, from a send, the text sent and whether it was clipped. */
export interface QuotedNote {
  chip: Chip
  src: string
  text?: string
  clipped?: boolean
}

/** The note's `quoteLines` as one `Flat`, over the lines its sent text reached: each `\n` of a clipped one is a line sent. */
function noteFlat(note: QuotedNote): Flat {
  const shown = note.clipped ? (note.text ?? "").split("\n").length - 1 : Number.POSITIVE_INFINITY
  const lines = quoteLines(note.src, shown)
  return flatten(lines, 0, lines.length)
}

/** Each source's mark whose quote occurs in its note's `quoteLines`; the first source for a mark wins. Each cited note is read once. */
function verified(sources: readonly Source[], notes: readonly QuotedNote[]): Map<number, Cite> {
  const flats = new Map<number, Flat>()
  const out = new Map<number, Cite>()
  for (const s of sources) {
    const note = notes[s.note - 1]
    if (out.has(s.n) || !note) continue
    const flat = flats.get(s.note) ?? noteFlat(note)
    flats.set(s.note, flat)
    const at = spanIn(flat, seenLine(s.quote))
    if (at) out.set(s.n, { n: 0, path: note.chip.path, quote: s.quote, line: at.row })
  }
  return out
}

/** The answer with only verified marks, renumbered 1..k by first appearance, and their cites. */
export function verifyCites(
  parts: Part[],
  sources: readonly Source[],
  notes: readonly QuotedNote[],
): { parts: Part[]; cites: Cite[] } {
  const found = verified(sources, notes)
  const num = new Map<number, number>()
  const cites: Cite[] = []
  const out: Part[] = []
  let dropped = false
  for (const p of parts) {
    const c = typeof p === "number" ? found.get(p) : undefined
    if (typeof p === "string") pushText(out, p, dropped)
    else if (c) {
      if (!num.has(p)) {
        cites.push({ ...c, n: cites.length + 1 })
        num.set(p, cites.length)
      }
      out.push(num.get(p) ?? 0)
    }
    dropped = typeof p === "number" && !c
  }
  const last = out.at(-1)
  if (dropped && typeof last === "string") out[out.length - 1] = last.trimEnd()
  return { parts: out, cites }
}

/** The section of `src` whose own lines hold `line`; the lead-in (index -1) when none does. */
export function citeSection(src: string, line: number): NoteSection {
  const secs = noteSections(src)
  return secs.findLast((s) => s.own[0] <= line && line < s.own[1]) ?? secs[0]!
}

/**
 * A cite's place for its card row: the heading in the thread's note, `<title> › <heading>` in another (the title alone
 * when the heading repeats it), the title for a lead-in.
 */
export function citeWhere(cite: Cite, threadPath: string, src: string, title: string): string {
  const sec = citeSection(src, cite.line)
  if (sec.index < 0) return title
  const heading = plainLine(sec.text)
  if (cite.path === threadPath) return heading
  return sameText(heading, title) ? title : `${title} › ${heading}`
}
