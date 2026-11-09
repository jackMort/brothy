// Chat about the open note, pure: what a thread holds, what one send carries (the notes clipped to the budget, the
// earlier turns, the question), the prompt, and the reply taken apart into text, marks and verified quotes.
// The app side is app/pill.ts; drawing is ui/pill.ts.
import { type ChatReq, cleanReply, clip, type Msg, tokens } from "./client"
import { keepSentences } from "./gloss"

/** characters of one note sent at most */
export const CHAT_NOTE_MAX = 24_000
/** the share of `maxChars` the earlier turns may use */
const CHAT_TURNS_SHARE = 0.25
/** the cleaned reply's cap; a longer one is kept to its last finished sentence */
export const MAX_CHAT = 6000
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
interface Cite {
  n: number
  path: string
  quote: string
  line: number
}
/** Answer text, or a cite number. */
type Part = string | number
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

/** Each note in chip order, clipped to CHAT_NOTE_MAX and to what is `left`; one left with nothing is empty and clipped. */
function clipNotes(texts: readonly string[], chips: readonly Chip[], left: number): SentNote[] {
  return chips.map((chip, i) => {
    const full = texts[i] ?? ""
    const cap = Math.min(CHAT_NOTE_MAX, left)
    const n = cp(full)
    left = Math.max(0, left - Math.min(n, cap))
    if (cap <= 0) return { chip, text: "", clipped: true }
    return { chip, text: clip(full, cap), clipped: n > cap }
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
  const r = chatRequest({ notes, turns: sent }, question)
  return { notes, turns: sent, size: tokens(r.system + sent.map((m) => m.content).join("") + question) }
}

/** A `title` attribute's value: no double quote can end it. */
const attr = (s: string) => s.replace(/"/g, "'")

/** The request for `question` over `ctx`: the notes as `<note>` tags after the prompt, the turns, the question. */
export function chatRequest(ctx: Pick<SentContext, "notes" | "turns">, question: string): ChatReq {
  const notes = ctx.notes.map((n, i) => `<note id="${i + 1}" title="${attr(n.chip.title)}">\n${n.text}\n</note>`)
  return {
    system: `${CHAT_PROMPT}\n\n${notes.join("\n")}`,
    turns: ctx.turns,
    user: question,
    maxOut: MAX_CHAT,
    clean: cleanReply,
    keep: (s) => keepSentences(s, MAX_CHAT),
  }
}
