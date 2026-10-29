// Note statistics for Info and the Ctrl-P peek: words, reading time, headings, links, code blocks, tables and
// tasks. Pure; `stats` lexes through the shared marked instance, `wordStats` does not lex.

import type { Token } from "marked"

import { lexBlocks, normalize, stripComments, tokenOf } from "./lexer"

/** What Info shows about a note; `tasks` is [done, all]. */
export interface Stats {
  words: number
  lines: number
  headings: number
  links: number
  codeBlocks: number
  tables: number
  tasks: [number, number]
  minutes: number
}

/** Reading pace behind the minutes (zen's default too). */
const WORDS_PER_MINUTE = 220

/** `stats`' words and reading minutes alone, without lexing (the Ctrl-P peek); `src` already normalized and without comments. */
function countWords(src: string): { words: number; minutes: number } {
  const words = (
    src
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\[[ xX]\]/g, "")
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
  ).length
  return { words, minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)) }
}

/** The same `words` and `minutes` as `stats(src)`. */
export const wordStats = (src: string) => countWords(stripComments(normalize(src)))

/** Counts over the note as Preview lexes it (comments cut, though `lines` counts theirs); wikilinks count as links. */
export function stats(src: string): Stats {
  const lines = normalize(src).split("\n").length
  src = stripComments(normalize(src))
  const tokens = lexBlocks(src)
  const s: Stats = { words: 0, lines, headings: 0, links: 0, codeBlocks: 0, tables: 0, tasks: [0, 0], minutes: 0 }
  const walk = (toks: Token[]) => {
    for (const tok of toks) {
      if (tok.type === "heading") s.headings++
      if (tok.type === "link") s.links++
      if (tok.type === "code") s.codeBlocks++
      if (tok.type === "table") {
        s.tables++
        const tb = tokenOf(tok, "table")
        for (const cell of [...tb.header, ...tb.rows.flat()]) walk(cell.tokens)
      }
      if (tok.type === "list")
        for (const it of tokenOf(tok, "list").items)
          if (it.task || /^\[[ xX]\]$/.test(it.text.trim())) {
            s.tasks[1]++
            if (it.task ? it.checked : !/^\[ \]$/.test(it.text.trim())) s.tasks[0]++
          }
      if ("tokens" in tok && tok.tokens) walk(tok.tokens)
      if ("items" in tok && tok.items) walk(tok.items)
    }
  }
  walk(tokens)
  Object.assign(s, countWords(src))
  // wikilinks (`[[note]]`, `![[embed]]`) are links too; marked leaves them as text
  s.links += (stripCode(src).match(/!?\[\[[^[\]\n]+\]\]/g) ?? []).length
  return s
}

/**
 * The source with fenced code blocks (``` or ~~~, unclosed ones run to the end) and inline
 * code spans removed, so text that only looks like markup inside code is ignored.
 */
export function stripCode(src: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of src.split("\n")) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const t = line.trim()
      if (t.length >= fence.length && [...t].every((c) => c === fence![0])) fence = null
      continue
    }
    if (open) {
      fence = open[1]!
      continue
    }
    out.push(line.replace(/`[^`\n]*`/g, ""))
  }
  return out.join("\n")
}
