// The one marked instance and what feeds it: input normalisation, the Obsidian extensions (`==highlight==`,
// `[[wikilinks]]`), the capped lexers and `%%comments%%`. Pure. Every lex in brothy goes through here, so Preview,
// the Source outline and stats see the same tokens; never lex with `new Lexer` or `Lexer.lexInline`.

import { Marked, type MarkedToken, type Token, type Tokens, type TokenizerExtension } from "marked"

import { safe } from "./spans"

/** Drop a BOM and unify line endings so every later stage can split on "\n". */
export const normalize = (s: string) => safe(s.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"))

/** Obsidian `==highlight==`: no space just inside either mark, one line at most. */
const highlightExt: TokenizerExtension = {
  name: "highlight",
  level: "inline",
  start: (src) => {
    const i = src.indexOf("==")
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    const m = /^==(?=[^\s=])([^\n]*?[^\s=])==(?!=)/.exec(src)
    if (!m) return undefined
    return { type: "highlight", raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) }
  },
}

export interface Wikilink {
  target: string
  heading?: string
  block?: string
  alias?: string
}

/** `target#heading|alias` (or `target#^block`); a `H1#H2` path keeps the last heading, like Obsidian. */
export function parseWikilink(inner: string): Wikilink {
  const bar = inner.indexOf("|")
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() : ""
  const ref = bar >= 0 ? inner.slice(0, bar) : inner
  const hash = ref.indexOf("#")
  const target = (hash >= 0 ? ref.slice(0, hash) : ref).trim()
  const frag = hash >= 0 ? ref.slice(hash + 1).trim() : ""
  const w: Wikilink = { target }
  if (frag.startsWith("^")) w.block = frag.slice(1)
  else if (frag) w.heading = frag.split("#").at(-1)!.trim()
  if (alias) w.alias = alias
  return w
}

/** What a wikilink shows: the alias, else the note's name (`Note › Heading` for heading links). */
export function wikiLabel(w: Wikilink): string {
  if (w.alias) return w.alias
  const name = w.target.split("/").at(-1)!.replace(/\.(md|markdown|mdx)$/i, "")
  if (w.heading) return name ? `${name} › ${w.heading}` : w.heading
  return name || (w.block ? `^${w.block}` : "")
}

/** The token `wikilinkExt` makes: the parsed link, and whether it was an `![[embed]]`. */
export interface WikilinkToken extends Wikilink {
  type: "wikilink"
  raw: string
  embed: boolean
}

/** Is `tok` a `[[wikilink]]`? Marked types extension tokens as `Tokens.Generic`, so this narrows to ours. */
export const isWikilink = (tok: Token): tok is Tokens.Generic & WikilinkToken => tok.type === "wikilink"

/** Obsidian `[[target#heading|alias]]` and `![[embed]]`. */
const wikilinkExt: TokenizerExtension = {
  name: "wikilink",
  level: "inline",
  start: (src) => {
    const i = src.search(/!?\[\[/)
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    const m = /^(!?)\[\[([^\[\]\n]+)\]\]/.exec(src)
    if (!m) return undefined
    return { type: "wikilink", raw: m[0], embed: m[1] === "!", ...parseWikilink(m[2]!) } satisfies WikilinkToken
  },
}

/** Marked's own token for a `type`: `TokenOf<"heading">` is `Tokens.Heading`. */
export type TokenOf<K extends MarkedToken["type"]> = Extract<MarkedToken, { type: K }>

/**
 * `tok` as the marked token its `type` names, for a caller that has checked `type` (each `case` of a switch on it).
 * `Token` includes `Tokens.Generic`, whose `type` is any string, so checking `type` alone never narrows it.
 */
export const tokenOf = <K extends MarkedToken["type"]>(tok: Token, ..._types: K[]): TokenOf<K> => tok as TokenOf<K>

/** The one marked instance: every lex goes through it so Preview, Source outline and stats see the same tokens. */
const md = new Marked({ gfm: true, extensions: [highlightExt, wikilinkExt] })

/**
 * Inline parsing is super-linear on unbalanced input (marked's emphasis and link scans, the
 * `[[` and `==` tokenizers), so one run of inline text is parsed up to this many characters and
 * the rest is plain text. 4000 is more than 600 words, longer than any prose paragraph; at that
 * size even a quadratic scan costs milliseconds, and a document of many such paragraphs stays linear.
 */
const INLINE_CAP = 4000

class CappedLexer extends md.Lexer {
  override inlineTokens(src: string, tokens: Token[] = []): Token[] {
    if (src.length <= INLINE_CAP) return super.inlineTokens(src, tokens)
    // cut at a space when there is one near the cap, never inside a surrogate pair
    let cut = src.lastIndexOf(" ", INLINE_CAP)
    if (cut < INLINE_CAP / 2) cut = INLINE_CAP - (/[\udc00-\udfff]/.test(src[INLINE_CAP]!) ? 1 : 0)
    const rest = src.slice(cut)
    super.inlineTokens(src.slice(0, cut), tokens)
    tokens.push({ type: "text", raw: rest, text: rest })
    return tokens
  }
}

export const lexBlocks = (src: string): Token[] => new CappedLexer(md.defaults).lex(src)

/** `lexBlocks` for the outline: only headings get their inline pass, as nothing else is read from the inline tokens. */
export function lexOutline(src: string): Token[] {
  const lx = new CappedLexer(md.defaults)
  const tokens = lx.blockTokens(src, lx.tokens)
  const wanted = new Set<Token[]>()
  const find = (toks: Token[]) => {
    for (const tok of toks) {
      if (tok.type === "heading") wanted.add(tokenOf(tok, "heading").tokens)
      else if (tok.type === "blockquote") find(tokenOf(tok, "blockquote").tokens)
      else if (tok.type === "list") for (const item of tokenOf(tok, "list").items) find(item.tokens)
    }
  }
  find(tokens)
  for (const q of lx.inlineQueue) if (wanted.has(q.tokens)) lx.inlineTokens(q.src, q.tokens)
  return tokens
}
export const lexInline = (src: string): Token[] => new CappedLexer(md.defaults).inlineTokens(src)

/**
 * Obsidian `%%comments%%`: closed pairs only, outside fenced code and code spans (an unclosed
 * `%%` stays literal). `kept[i]` is line i without its comments; `hidden[i]` marks a line that
 * had text and none of it is left, which the preview drops and the source outline skips.
 * Lines before `from` (front matter) are left alone, as the preview never sees them.
 */
export function scanComments(lines: string[], from = 0): { kept: string[]; hidden: boolean[] } {
  const marks: [number, number][] = []
  let fence: string | null = null
  lines.forEach((line, i) => {
    if (i < from) return
    if (fence) {
      const tr = line.trim()
      if (tr.length >= fence.length && [...tr].every((c) => c === fence![0])) fence = null
      return
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (open) {
      fence = open[1]!
      return
    }
    const code = [...line.matchAll(/`[^`\n]*`/g)].map((m): [number, number] => [m.index!, m.index! + m[0].length])
    for (const m of line.matchAll(/%%/g)) if (!code.some(([a, b]) => m.index! >= a && m.index! < b)) marks.push([i, m.index!])
  })
  if (marks.length % 2) marks.pop()
  const kept = [...lines]
  const touched = new Set<number>()
  // cut from the last pair back, so offsets earlier on a shared line stay valid
  for (let k = marks.length - 2; k >= 0; k -= 2) {
    const [l1, c1] = marks[k]!
    const [l2, c2] = marks[k + 1]!
    for (let i = l1; i <= l2; i++) touched.add(i)
    if (l1 === l2) kept[l1] = kept[l1]!.slice(0, c1) + kept[l1]!.slice(c2 + 2)
    else {
      kept[l1] = kept[l1]!.slice(0, c1)
      for (let i = l1 + 1; i < l2; i++) kept[i] = ""
      kept[l2] = kept[l2]!.slice(c2 + 2)
    }
  }
  const hidden = lines.map((l, i) => touched.has(i) && kept[i]!.trim() === "" && l.trim() !== "")
  return { kept, hidden }
}

/** The source without `%%comments%%`; lines that held only a comment are removed. */
export function stripComments(src: string): string {
  const { kept, hidden } = scanComments(src.split("\n"))
  return kept.filter((_, i) => !hidden[i]).join("\n")
}
