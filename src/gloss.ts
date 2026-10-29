// Zen gloss, pure: which text is sent for the section under the reading line, how it is asked for, how the sheet reads.

import { clip, cleanSummary, type ChatReq } from "./ai"
import * as aiConfig from "./ai-config"
import type { GlossStyle } from "./ai-config"
import { truncate, width, wrap } from "./text"
import { cached } from "./nav"
import { noteSections, sectionId, sectionSource } from "./sections"
import { safeLine } from "./spans"
import { headingPath } from "./zen"

/** muted rows under the sheet's rule */
export const GLOSS_ROWS = 3
/** cleaned characters before a gloss is `too long` */
export const GLOSS_MAX = 400
/** code points sent at most, below the preset's `maxChars` */
export const GLOSS_CHARS = 12_000
/** a section with fewer words of its own sends its subtree */
export const GLOSS_MIN_WORDS = 20

/** `ai.gloss` in config.json (validated by ai-config.ts); anything unrecognised is `explain`. */
export const parseGlossStyle = (raw: unknown): GlossStyle => aiConfig.parseGlossStyle(raw, "explain")

const PLAIN = "Plain text only: no markdown, no lists, no preamble."
const SAME = "Write in the same language as the section."

/** Bump `PROMPTS.gloss` (ai-config.ts) whenever one of these changes. */
export function glossSystem(style: GlossStyle): string {
  if (style === "simplify") return `Restate this section in plain, simple words in 1–2 sentences, at most 35 words. ${PLAIN} ${SAME}`
  if (style.startsWith("translate:"))
    return `Give the gist of this section in ${style.slice("translate:".length)} in 1–2 sentences, at most 35 words. ${PLAIN}`
  return `Explain this section of a note to its reader in 1–2 sentences, at most 35 words: what it says and why it matters. ${PLAIN} ${SAME}`
}

/** The request: the system prompt and the one user message (the lead-in, an empty trail, is named by the note title), cleaned to plain text, at most GLOSS_MAX. */
export function glossRequest(style: GlossStyle, title: string, trail: string[], text: string, maxChars: number): ChatReq {
  const section = trail.length ? trail.join(" › ") : title
  const user = `Note: ${title}\nSection: ${section}\n\n${clip(text, Math.min(maxChars, GLOSS_CHARS))}`
  return { system: glossSystem(style), user, maxOut: GLOSS_MAX, clean: cleanSummary }
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
  return { id: sectionId(path, s), index, heading: index < 0 ? title : s.text, trail: index < 0 ? [] : headingPath(heads, index), text }
}

/** Cache key: the section and the style it was glossed in. */
export const glossKey = (id: string, style: GlossStyle) => `${id}#${style}`

export type GlossState = "loading" | "result" | "outdated"

const TAILS: Record<GlossState, string> = { loading: " · explaining…", result: "", outdated: " · outdated · a" }

/** The sheet's first row as [lead, label, rule]: `┈ gloss · <heading>[ · state] ┈┈┈`, `width` columns in all. */
export function glossRule(state: GlossState, heading: string, width_: number): [string, string, string] {
  const head = "gloss · "
  const tail = TAILS[state]
  const room = Math.max(1, width_ - 4 - width(head) - width(tail)) // "┈ " before, " ┈" after at least
  const label = head + truncate(safeLine(heading), room) + tail
  return ["┈ ", label, " " + "┈".repeat(Math.max(1, width_ - 3 - width(label)))]
}

/** The gloss as at most `max` rows of `width_` columns; the last row ends in `…` when text is left over. */
export function glossRows(text: string, width_: number, max = GLOSS_ROWS): string[] {
  const t = safeLine(text).trim()
  if (!t) return []
  // truncate guards a single token wider than the row
  const rows = wrap([{ text: t }], width_).map((r) => truncate(r.map((x) => x.text).join("").trimEnd(), width_))
  if (rows.length <= max) return rows
  return [...rows.slice(0, max - 1), truncate(rows[max - 1]! + " …", width_)]
}
