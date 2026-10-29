/**
 * A note's sections in source lines, for the AI features: what a gloss sends, what a reload
 * compares, a stable id per section. Pure; built on `sourceScan`, so by outline parity section
 * `i` is heading `i` in Preview, Source and the switcher's index.
 */

import { parseFrontMatter } from "./frontmatter"
import { normalize, scanComments } from "./lexer"
import { sourceScan } from "./source"

/** Heading text as a lenient key: lowercase, `#` dropped, dashes and runs of spaces as one space, punctuation removed. */
export const headingKey = (s: string) =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/#/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/[\s-]+/g, " ")
    .trim()

/** Ranges are `[from, to)` source lines; `line`…`end` is the heading itself (two lines for setext). */
export interface NoteSection {
  /** heading index; -1 is the lead-in before the first heading (always there, maybe empty) */
  index: number
  depth: number
  text: string
  key: string
  /** occurrence of `key` among equal keys, from 0 (duplicate headings); the lead-in counts as key "" */
  ord: number
  line: number
  end: number
  /** up to the next heading of any depth */
  own: [number, number]
  /** up to the next heading of the same or a higher level; the lead-in's is its own */
  tree: [number, number]
}

/** `[0]` is the lead-in, `[i + 1]` heading `i`. */
export function noteSections(src: string): NoteSection[] {
  const { headings, text } = sourceScan(src)
  const n = text.length
  const seen = new Map<string, number>()
  const ordOf = (key: string) => {
    const o = seen.get(key) ?? 0
    seen.set(key, o + 1)
    return o
  }
  const lead = headings[0]?.line ?? n
  const out: NoteSection[] = [
    { index: -1, depth: 0, text: "", key: "", ord: ordOf(""), line: 0, end: -1, own: [0, lead], tree: [0, lead] },
  ]
  // headings whose subtree is still open, deepest last: a heading closes every one at its depth or deeper
  const open: NoteSection[] = []
  headings.forEach((h, i) => {
    while (open.length && open.at(-1)!.depth >= h.depth) open.pop()!.tree[1] = h.line
    const next = headings[i + 1]?.line ?? n
    const key = headingKey(h.text)
    const s: NoteSection = {
      index: i,
      depth: h.depth,
      text: h.text,
      key,
      ord: ordOf(key),
      line: h.line,
      end: h.end,
      own: [h.line, next],
      tree: [h.line, n],
    }
    out.push(s)
    open.push(s)
  })
  return out
}

/** Section `i`'s source lines without front matter, comments or its own heading, trimmed; "" when there is none. `secs` is `noteSections(src)`, when the caller has it. */
export function sectionSource(src: string, i: number, scope: "own" | "tree", secs = noteSections(src)): string {
  const s = i >= -1 ? secs[i + 1] : undefined
  if (!s) return ""
  const lines = normalize(src).split("\n") // the lines sourceScan numbered
  const fm = parseFrontMatter(src).offset
  const { kept, hidden } = scanComments(lines, fm)
  const [from, to] = s[scope]
  const out: string[] = []
  for (let k = Math.max(from, fm); k < to; k++) if (!hidden[k] && (k < s.line || k > s.end)) out.push(kept[k]!)
  return out.join("\n").trim()
}

/** The heading the reading line is in: the last with `line <= line + 1` (derive()'s `currentHeading`), else -1. */
export function sectionOf(headings: readonly { line: number }[], line: number): number {
  let at = -1
  for (let i = 0; i < headings.length; i++) if (headings[i]!.line <= line + 1) at = i
  return at
}

/** Stable across inserts elsewhere in the note: the index alone shifts, the key alone collides. */
export const sectionId = (path: string, s: Pick<NoteSection, "key" | "ord">) => `${path}#${s.key}#${s.ord}`
