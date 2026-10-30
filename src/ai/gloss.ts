// Zen gloss, pure: which text is sent for the section under the reading line, how it is asked for and kept, and how its
// note reads, in the bottom sheet or in the margin (the print language is ui/footnote.ts).

import { type Span, safeLine } from "../lib/spans"
import { truncate } from "../lib/text"
import { noteSections, sectionId, sectionSource } from "../markdown/sections"
import type { Theme } from "../theme/theme"
import {
  CARET,
  type FootInk,
  footInk,
  footnoteRule,
  MODEL_W,
  noteRows,
  noteSpans,
  type SideNote,
  type Stale,
  sidenoteLayout,
  staleTail,
  type Tail,
  waitText,
} from "../ui/footnote"
import { cached } from "../ui/nav"
import { headingPath } from "../ui/zen"
import { type Glosses, isFresh, textHash } from "./cache"
import { type ChatReq, cleanSummary, clip } from "./client"
import { type GlossStyle, PROMPTS } from "./config"

/** text rows of the sheet, and expanded (`a` more) */
export const GLOSS_ROWS = 3
export const GLOSS_ROWS_OPEN = 8
/** cleaned characters a gloss keeps: a longer reply stops there and keeps its finished sentences (`keepSentences`) */
export const GLOSS_MAX = 400
/** ms the reading line stays in a section before its cached gloss shows by itself (skimming stays quiet) */
export const GLOSS_DWELL = 600
/** code points sent at most, below the preset's `maxChars` */
export const GLOSS_CHARS = 12_000
/** a section with fewer words of its own sends its subtree */
const GLOSS_MIN_WORDS = 20

/** `ai.gloss` in config.json (validated by ai/config.ts); anything unrecognised is `explain`. */
export { parseGlossStyle } from "./config"

const PLAIN = "Plain text only: no markdown, no lists, no preamble."
const SAME = "Write in the same language as the section."

/** Bump `PROMPTS.gloss` (ai/config.ts) whenever one of these changes. */
export function glossSystem(style: GlossStyle): string {
  if (style === "simplify")
    return `Restate this section in plain, simple words in 1–2 sentences, at most 35 words. ${PLAIN} ${SAME}`
  if (style.startsWith("translate:"))
    return `Give the gist of this section in ${style.slice("translate:".length)} in 1–2 sentences, at most 35 words. ${PLAIN}`
  return `Explain this section of a note to its reader in 1–2 sentences, at most 35 words: what it says and why it matters. ${PLAIN} ${SAME}`
}

/** The request: the system prompt and the one user message (the lead-in, an empty trail, is named by the note title), cleaned to plain text, a longer reply kept to GLOSS_MAX. */
export function glossRequest(
  style: GlossStyle,
  title: string,
  trail: string[],
  text: string,
  maxChars: number,
): ChatReq {
  const section = trail.length ? trail.join(" › ") : title
  const user = `Note: ${title}\nSection: ${section}\n\n${clip(text, Math.min(maxChars, GLOSS_CHARS))}`
  return { system: glossSystem(style), user, maxOut: GLOSS_MAX, clean: cleanSummary, keep: keepSentences }
}

/** What `a` glosses: the section's stable id, its label, its heading path and the exact text sent (before clipping). */
export interface GlossTarget {
  id: string
  index: number
  heading: string
  trail: string[]
  text: string
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length
/** Zen asks each time the reading line crosses a heading, mostly of the same text. */
const sectionsOf = cached(noteSections)

/** Section `index` of `src` (`-1`: the lead-in), or null when it is missing or has nothing to send. */
export function glossTarget(src: string, index: number, path: string, title: string): GlossTarget | null {
  const secs = sectionsOf(src)
  const s = secs.find((x) => x.index === index)
  if (!s) return null
  let text = sectionSource(src, index, "own", secs)
  if (words(text) < GLOSS_MIN_WORDS) text = sectionSource(src, index, "tree", secs)
  if (!text) return null
  // position = index once the lead-in is dropped, which is what headingPath expects
  const heads = secs.filter((x) => x.index >= 0)
  return {
    id: sectionId(path, s),
    index,
    heading: index < 0 ? title : s.text,
    trail: index < 0 ? [] : headingPath(heads, index),
    text,
  }
}

/** Cache key: the section and the style it was glossed in. */
export const glossKey = (id: string, style: GlossStyle) => `${id}#${style}`

/** Where the gloss of the reading section stands; derived every frame, never stored. */
type GlossState = "waiting" | "streaming" | "result" | "outdated"

/** The reading section's note as drawn: its section, text so far, expanded, fading, and what its rule says. */
export interface GlossView {
  state: GlossState
  /** the section's outline index (`view.headings`), -1 for the lead-in */
  index: number
  text: string
  /** regenerating: the cached text, kept dimmed under the caret row until the first token ("" when none) */
  old: string
  open: boolean
  fadeAt: number | null
  /** shortModel's name of the model asked */
  model: string
  secs: number
  stale: Stale | null
}

/** A finished sentence's end: its mark, any closing quotes or brackets, then a space or the end of the text. */
const SENTENCE_END = /[.!?…。！？]["')\]”’»]*(?=\s|$)/g

/**
 * `text` within `max` characters: unchanged when it fits; else up to its last finished sentence that fits (an end is
 * `. ! ? … 。 ！ ？`, closing quotes or brackets, then a space or the end, so `3.14` is none); else cut at a space with
 * `…`; else cut hard, never inside a surrogate pair. Idempotent.
 */
export function keepSentences(text: string, max = GLOSS_MAX): string {
  if (text.length <= max) return text
  let end = 0
  for (const m of text.matchAll(SENTENCE_END)) {
    if (m.index + m[0].length > max) break
    end = m.index + m[0].length
  }
  if (end) return text.slice(0, end).trimEnd()
  const space = text.slice(0, max - 1).search(/\s\S*$/)
  if (space > 0) return `${text.slice(0, space).replace(/[\s,;:–-]+$/, "")}…`
  const hard = /[\uD800-\uDBFF]/.test(text[max - 2] ?? "") ? max - 2 : max - 1
  return `${text.slice(0, hard)}…`
}

/** Whether `text` as a note (`¹ ` and a hanging indent) takes more than `rows` rows of `width_`. */
export const overflows = (text: string, width_: number, rows: number) =>
  noteRows(text, width_, 1, rows + 1).length > rows

/** The rule's right end, keyed on `a` (zen's footer is ghosted, so the key stays and the status goes first). */
export function glossTail(
  v: Pick<GlossView, "state" | "model" | "secs" | "stale">,
  overflow: boolean,
  open: boolean,
): Tail | null {
  const a = (word: string): Tail => ({ key: "a", word, drop: "status" })
  if (v.state === "waiting")
    return { ...a("cancel"), status: waitText(v.model, v.secs), model: truncate(safeLine(v.model), MODEL_W) }
  if (v.state === "streaming") return a("cancel")
  if (v.state === "outdated") return { ...staleTail(v.stale ?? "edited", "a"), drop: "status" }
  if (open) return a("less")
  return overflow ? a("more") : null
}

/**
 * The sheet in `CH` body rows: the reading row and the one under it stay clear, so the room is what is left below;
 * under 2 rows no sheet, at 2 the rule and one row, else a gap row, the rule and up to `want` rows.
 */
export function sheetFit(want: number, CH: number): { gap: boolean; text: number } | null {
  const room = CH - Math.floor(CH / 2) - 1
  if (room < 2) return null
  return room === 2 ? { gap: false, text: 1 } : { gap: true, text: Math.min(want, room - 2) }
}

/** Text rows a note wants: the caret row while waiting (and the old text under it), more when expanded. */
const sheetWant = (v: GlossView) => {
  if (v.state === "waiting") return v.old ? 1 + GLOSS_ROWS : 1
  return v.state === "result" && v.open ? GLOSS_ROWS_OPEN : GLOSS_ROWS
}

/** The text a note draws: "" while waiting, a stream ending in its caret. */
export const drawnText = (v: GlossView) => (v.state === "streaming" ? v.text + CARET : v.text)

/** The note's text rows, at most `max`: `¹` and a hanging indent; regenerating keeps the old text dimmed under `¹ ▍`. */
function sheetText(v: GlossView, CW: number, max: number, c: FootInk): Span[][] {
  if (v.state === "waiting" && v.old) {
    const old = noteSpans(v.old, CW, 1, max - 1, { mark: c.stale, text: c.stale, caret: c.caret })
    const caret: Span[] = [{ text: "¹", fg: c.markStale }, { text: " " }, { text: CARET, fg: c.caret }]
    return [caret, ...old.map((r, i) => (i ? r : [{ text: " " }, ...r.slice(1)]))]
  }
  const fg = v.state === "outdated" ? { mark: c.markStale, text: c.stale } : { mark: c.mark, text: c.note }
  return noteSpans(drawnText(v), CW, 1, max, { ...fg, caret: c.caret })
}

/**
 * The bottom sheet, top to bottom (`[]` when it does not fit): a blank gap row, the rule with its tail, then `¹` and the
 * text with a hanging indent, `CW` columns, the zen gutter excluded. `ink` (the fade) goes over every colour.
 */
export function sheetRows(t: Theme, v: GlossView, CW: number, CH: number, ink?: (c: string) => string): Span[][] {
  const c = footInk(t, ink)
  const fit = sheetFit(sheetText(v, CW, sheetWant(v), c).length, CH)
  if (!fit) return []
  const rule = footnoteRule(t, CW, glossTail(v, overflows(v.text, CW, GLOSS_ROWS), v.open), ink)
  return [...(fit.gap ? [[]] : []), rule, ...sheetText(v, CW, fit.text, c)]
}

/** A note for the margin: its section and where its heading's last row is on screen. */
export type MarginNote = Omit<SideNote, "n"> & { index: number }

/**
 * The margin's notes laid out and numbered by row, top to bottom, over the notes actually drawn (an expanded reading
 * note hides the ones it covers, which take no number): laid out once to find the order, then again with the numbers.
 * `marks` gives each drawn section its number, for the heading's mark.
 */
export function marginLayout(t: Theme, notes: readonly MarginNote[], CH: number, open: boolean) {
  const first = sidenoteLayout(
    t,
    notes.map((x, i) => ({ ...x, n: i + 1 })),
    CH,
    { open },
  )
  const numbered = first.map((p, k) => ({ ...notes[p.n - 1]!, n: k + 1 }))
  const placed = sidenoteLayout(t, numbered, CH, { open })
  return { placed, marks: numbered.map((x) => ({ index: x.index, n: x.n })) }
}

/** The sections of `src` whose cached gloss in `style` is fresh: the margin's other notes. */
export function freshGlosses(src: string, path: string, glosses: Glosses, style: GlossStyle) {
  return sectionsOf(src).flatMap((s) => {
    const g = glossTarget(src, s.index, path, "")
    const e = g && glosses[glossKey(g.id, style)]
    return g && e && isFresh(e, textHash(g.text), PROMPTS.gloss) ? [{ index: s.index, text: e.gloss }] : []
  })
}
