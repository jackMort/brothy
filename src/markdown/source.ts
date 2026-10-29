// The Source view and the outline read off source lines: which lines are headings, fences and code (a line-based
// reader for simple notes, the shared lexer for the rest), the switcher's `sourceScan`, and `renderSource`. Pure.
// Outline parity: these headings are Preview's, in the same order, so anything Preview hides is skipped here too.

import type { Token } from "marked"
import { themes, type Theme } from "../theme/theme"

import { parseFrontMatter } from "./frontmatter"
import { lexInline, lexOutline, normalize, parseWikilink, scanComments, tokenOf } from "./lexer"
import { CALLOUT_KINDS, calloutKind, calloutOf, inline, pad, plainOf, type Heading, type Line, type RenderOpts, type Rendered } from "./render"
import { A, type Span } from "../lib/spans"
import { wrap } from "../lib/text"

/** A heading found on source lines, keyed by its first line. */
interface SourceHeading {
  depth: number
  text: string
  /** Last source line of the heading (differs from the first for setext). */
  end: number
  setext: boolean
}

/** A heading's outline title from its inline tokens: Preview's text (NBSP read as a space), which no theme changes. */
const titleOf = (tokens: Token[] | undefined, t: Theme) => plainOf(inline(tokens, t)).replace(/\u00a0/g, " ")

/** The line-based reader's state: what it found so far, the open fence and the open paragraph's lines. */
interface LineScan {
  headings: Map<number, SourceHeading>
  fenceLines: Set<number>
  codeLines: Set<number>
  // fences and paragraphs remember their quote depth: a quote ending closes a fence, and an
  // underline only makes a setext heading at its paragraph's depth
  fence: { ch: string; len: number; depth: number } | null
  para: number[]
  paraDepth: number
  /** each line read so far without its quote markers */
  bodies: string[]
  title: (raw: string) => string
}

/** A line inside a fence: the closing fence (same char, at least as long, same quote depth), else a code line. */
function fenceLine(s: LineScan, i: number, body: string, depth: number) {
  const fence = s.fence!
  const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body)
  if (close && depth === fence.depth && close[1]![0] === fence.ch && close[1]!.length >= fence.len) {
    s.fence = null
    s.fenceLines.add(i)
  } else s.codeLines.add(i)
}

/** Whether line `i` opens a fence (an info string with a backtick does not), recording it. */
function openFence(s: LineScan, i: number, body: string, depth: number): boolean {
  const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body)
  if (!open || (open[1]![0] === "`" && open[2]!.includes("`"))) return false
  s.fence = { ch: open[1]![0]!, len: open[1]!.length, depth }
  s.fenceLines.add(i)
  return true
}

/** Whether line `i` is an ATX heading, recording it. */
function atxHeading(s: LineScan, i: number, body: string): boolean {
  const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(body)
  if (!atx) return false
  const text = (atx[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim()
  s.headings.set(i, { depth: atx[1]!.length, text: s.title(text), end: i, setext: false })
  return true
}

/** Whether line `i` underlines the open paragraph (at its quote depth) into a setext heading, recording it. */
function setextHeading(s: LineScan, i: number, body: string, depth: number): boolean {
  // one `-` is enough: an empty list item can't interrupt a paragraph, so `Para\n-` is a setext h2
  const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(body)
  if (!underline || !s.para.length || depth !== s.paraDepth) return false
  const text = s.para
    .map((k) => s.bodies[k]!.trimStart())
    .join("\n")
    .trimEnd()
  s.headings.set(s.para[0]!, { depth: underline[1]![0] === "=" ? 1 : 2, text: s.title(text), end: i, setext: true })
  return true
}

/** Whether line `i` ends the open paragraph: a fence, blank line, heading, rule, list item, table row or lazy line. */
function endsParagraph(s: LineScan, i: number, body: string, depth: number): boolean {
  if (openFence(s, i, body, depth)) return true
  if (/^[ \t]*$/.test(body)) return true
  if (atxHeading(s, i, body)) return true
  if (setextHeading(s, i, body, depth)) return true
  if (/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(body) || /^ {0,3}([-*+]|\d{1,9}[.)])([ \t]|$)/.test(body) || /^ {0,3}\|/.test(body)) return true
  // a lazy line continues a quoted paragraph, which can no longer take an underline
  return s.para.length > 0 && depth < s.paraDepth
}

/** A line that may join the open paragraph, or start one at its quote depth. */
function paragraphLine(s: LineScan, i: number, body: string, depth: number) {
  // a callout's `[!type]` line is its title, never part of a paragraph
  if (depth && !s.para.length && /^\[![\w-]+\]/.test(body)) return
  if (!s.para.length && /^( {4}|\t)/.test(body)) return // indented code
  if (!s.para.length) s.paraDepth = depth
  s.para.push(i)
}

/**
 * Line-based mirror of the Markdown block rules that matter for the outline, for notes whose
 * blocks are only headings, fences, quotes and paragraphs (`needsLexer` says when that does not hold):
 * fences (matching char and length), ATX and setext headings, quotes. `lines` have their
 * `%%comments%%` cut (`scanComments().kept`), so titles and structure match what Preview lexes.
 */
export function sourceStructureLines(lines: string[], from: number, t: Theme, hidden: boolean[]) {
  const s: LineScan = {
    headings: new Map(),
    fenceLines: new Set(),
    codeLines: new Set(),
    fence: null,
    para: [],
    paraDepth: 0,
    bodies: [],
    title: (raw) => titleOf(lexInline(raw), t),
  }
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!
    const quote = /^ {0,3}(?:> ?)+/.exec(line)
    const depth = quote ? quote[0].split(">").length - 1 : 0
    const body = quote ? line.slice(quote[0].length) : line
    s.bodies[i] = body
    if (s.fence && depth < s.fence.depth) s.fence = null
    if (s.fence) {
      fenceLine(s, i, body, depth)
      continue
    }
    // Preview never sees a comment-only line, so the lines around it meet
    if (hidden[i]) continue
    if (s.para.length && depth > s.paraDepth) s.para = [] // a quote interrupts the paragraph
    if (endsParagraph(s, i, body, depth)) s.para = []
    else paragraphLine(s, i, body, depth)
  }
  return { headings: s.headings, fenceLines: s.fenceLines, codeLines: s.codeLines }
}

/** Deepest list indent (spaces) the line-based reader follows; past it a marker may be code, so the lexer decides. */
const MAX_LIST_INDENT = 8

/**
 * Whether `live` (the lines Preview lexes) has anything the line-based reader cannot follow, so
 * the lexer must read the note. The line-based path (several times faster on big notes, which
 * matters for the vault index) is for notes made of headings, fences, rules, paragraphs and
 * the simplest quotes and lists: a `> ` or list marker followed by a word, nested markers
 * indented by spaces. Everything that could hide or nest a block goes to the lexer: tabs, tables,
 * HTML, link definitions, other indented lines, quote or item bodies that open with markup, callouts,
 * task items, and a rule or underline right under a line (it may underline a lazy continuation).
 */
export function needsLexer(live: string[]): boolean {
  let lists = false
  let prevBlank = true
  let prevQuote = false
  for (const line of live) {
    if (/^[ \t]*$/.test(line)) {
      prevBlank = true
      prevQuote = false
      continue
    }
    if (/\t|\||^ {0,3}[<[]/.test(line)) return true
    const item = /^( *)(?:[-*+]|\d{1,9}[.)])[ \t]+(.?)/.exec(line)
    const quote = /^ {0,3}>[ \t]?(.?)/.exec(line)
    if (item) {
      if (item[1]!.length > MAX_LIST_INDENT || !/^[\p{L}]$/u.test(item[2]!)) return true
      lists = true
      prevQuote = false
    } else if (quote) {
      if (!/^[\p{L}]$/u.test(quote[1]!)) return true
      prevQuote = true
    } else {
      if (/^ /.test(line)) return true
      // a line right under a quote or an item may be its lazy continuation
      if (prevQuote) return true
      if (!prevBlank && lists && /^(?:=+|-+|\*{3,}|_{3,})[ \t]*$/.test(line)) return true
      prevQuote = false
    }
    prevBlank = false
  }
  return false
}

/** Line breaks in `s`. */
const newlines = (s: string) => s.split("\n").length - 1

/**
 * The structure Preview sees, read back onto source lines: the same lexer runs over `lines`
 * (comment-only lines dropped, as `stripComments` does), and the tokens are walked, so headings
 * (also inside quotes, callouts and list items), fences and HTML blocks agree with Preview by
 * construction. `lines` have their `%%comments%%` cut (`scanComments().kept`).
 */
function sourceStructure(lines: string[], from: number, t: Theme, hidden: boolean[]) {
  const live = from || hidden.includes(true) ? lines.filter((_, i) => i >= from && !hidden[i]) : lines
  return needsLexer(live) ? sourceStructureLexed(lines, from, t, hidden) : sourceStructureLines(lines, from, t, hidden)
}

/** `sourceStructure` through the lexer: the path for every note `needsLexer` flags. */
export function sourceStructureLexed(lines: string[], from: number, t: Theme, hidden: boolean[]) {
  const headings = new Map<number, SourceHeading>()
  const fenceLines = new Set<number>()
  const codeLines = new Set<number>()
  const at: number[] = []
  const body: string[] = []
  for (let i = from; i < lines.length; i++)
    if (!hidden[i]) {
      at.push(i)
      body.push(lines[i]!)
    }
  /**
   * `tokens` were lexed from `text`, which starts on lexed line `line0`. Each token is located by
   * searching its raw from the previous one: marked rewrites the raw of a quote's last tokens
   * (lazy lines), so summing raw lengths drifts, while the order of the pieces holds.
   */
  const walk = (tokens: Token[], text: string, line0: number) => {
    let pos = 0
    let seen = 0 // newlines in text before `from`, counted incrementally (a rescan per token is quadratic)
    let from = 0
    for (const tok of tokens) {
      let i = text.indexOf(tok.raw, pos)
      if (i < 0) i = text.indexOf(tok.raw.trimEnd(), pos)
      if (i < 0) i = pos
      seen += newlines(text.slice(from, i))
      from = i
      const line = line0 + seen
      pos = Math.min(text.length, i + tok.raw.length)
      const rowsOf = () => tok.raw.replace(/\n+$/, "").split("\n").length
      switch (tok.type) {
        case "heading": {
          const h = tokenOf(tok, "heading")
          const title = titleOf(h.tokens, t)
          headings.set(at[line]!, { depth: h.depth, text: title, end: at[line + rowsOf() - 1] ?? at[line]!, setext: !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(tok.raw) })
          break
        }
        case "code": {
          if (tokenOf(tok, "code").codeBlockStyle === "indented") break
          const rows = rowsOf()
          const last = tok.raw.replace(/\n+$/, "").split("\n")
          const open = /^ {0,3}(`{3,}|~{3,})/.exec(last[0]!)
          const close = last.length > 1 ? /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(last[last.length - 1]!) : null
          const closed = !!open && !!close && close[1]![0] === open[1]![0] && close[1]!.length >= open[1]!.length
          fenceLines.add(at[line]!)
          for (let k = 1; k < rows; k++) (k === rows - 1 && closed ? fenceLines : codeLines).add(at[line + k]!)
          break
        }
        case "blockquote": {
          const q = tokenOf(tok, "blockquote")
          const c = calloutOf(q)
          if (c) walk(lexOutline(c.body), c.body, line + 1)
          else walk(q.tokens, q.text, line)
          break
        }
        case "list": {
          const l = tokenOf(tok, "list")
          let at0 = 0
          let seen = 0
          let from = 0
          for (const item of l.items) {
            let j = l.raw.indexOf(item.raw, at0)
            if (j < 0) j = at0
            seen += newlines(l.raw.slice(from, j))
            from = j
            walk(item.tokens, item.text, line + seen)
            at0 = Math.min(l.raw.length, j + item.raw.length)
          }
          break
        }
      }
    }
  }
  const text = body.join("\n")
  walk(lexOutline(text), text, 0)
  return { headings, fenceLines, codeLines }
}

/** What the switcher's index keeps of a note. */
export interface SourceScan {
  /** the Source outline (same headings, same order as `renderSource`), with each heading's first and last source line */
  headings: { depth: number; text: string; line: number; end: number }[]
  /**
   * Per source line, what the Preview can show as prose: comments cut; front matter,
   * comment-only lines, fence lines and fenced code blank. Line numbers match `renderSource`.
   */
  text: string[]
}

/**
 * A note's outline and searchable lines without laying it out (the switcher's index). The theme only feeds the
 * title pass, whose text no theme changes, so callers without one (sections, the vault index) can leave it out.
 */
export function sourceScan(src: string, t: Theme = themes[0]!): SourceScan {
  src = normalize(src)
  const fmLines = parseFrontMatter(src).offset
  const lines = src.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  const { kept, hidden } = scanComments(lines, fmLines)
  const { headings, fenceLines, codeLines } = sourceStructure(kept, fmLines, t, hidden)
  return {
    headings: [...headings].sort((a, b) => a[0] - b[0]).map(([line, h]) => ({ depth: h.depth, text: h.text, line, end: h.end })),
    text: lines.map((_, i) => (i < fmLines || hidden[i] || fenceLines.has(i) || codeLines.has(i) ? "" : kept[i]!)),
  }
}

/** Source: `[[…]]` and `![[…]]` in `info` (`textMuted` when `exists` says the note is missing), the text around them untouched. */
function tintWikilinks(spans: Span[], t: Theme, exists?: (target: string) => boolean): Span[] {
  const tint = (part: string) => {
    const target = parseWikilink(part.replace(/^!?\[\[|\]\]$/g, "")).target
    return !target || !exists || exists(target) ? t.info : t.textMuted
  }
  return spans.flatMap((s) =>
    s.text
      .split(/(!?\[\[[^[\]\n]+\]\])/)
      .filter(Boolean)
      .map((part) => (/^!?\[\[/.test(part) && part.endsWith("]]") ? { ...s, text: part, fg: tint(part) } : { ...s, text: part })),
  )
}

/** Raw Markdown with a line-number gutter and light syntax coloring. */
export function renderSource(src: string, max: number, t: Theme, opts: RenderOpts = {}): Rendered {
  src = normalize(src)
  const fmLines = parseFrontMatter(src).offset
  const orig = src.split("\n")
  if (orig[orig.length - 1] === "") orig.pop()
  const raw = orig.map((l) => l.replace(/\t/g, "    ").replace(/^ +/, (m) => "\u00a0".repeat(m.length)))
  const { kept, hidden } = scanComments(orig, fmLines)
  const { headings: found, fenceLines, codeLines } = sourceStructure(kept, fmLines, t, hidden)
  const gw = String(raw.length).length
  const lines: Line[] = []
  const headings: Heading[] = []
  const srcRow: number[] = []
  const hcolor = (d: number) => [t.primary, t.secondary, t.accent][d - 1] ?? t.text
  let setext: SourceHeading | null = null
  raw.forEach((text, i) => {
    srcRow.push(lines.length)
    let spans: Span[]
    const h = found.get(i)
    if (h?.setext) setext = h
    else if (setext && i > setext.end) setext = null
    if (i < fmLines) spans = [{ text, fg: t.textMuted }]
    else if (hidden[i]) spans = [{ text, fg: t.textMuted, attr: A.ITALIC }]
    else if (fenceLines.has(i)) spans = [{ text, fg: t.textMuted }]
    else if (codeLines.has(i)) spans = [{ text, fg: t.accent }]
    else if (setext) spans = [{ text, fg: hcolor(setext.depth), attr: A.BOLD }]
    else if (h) {
      const m = /^([^#]*#{1,6})(.*)$/.exec(text)
      spans = m
        ? [
            { text: m[1]!, fg: t.textMuted, attr: A.BOLD },
            { text: m[2]!, fg: hcolor(h.depth), attr: A.BOLD },
          ]
        : [{ text, fg: hcolor(h.depth), attr: A.BOLD }]
    } else if (/^\s*>/.test(text)) {
      const m = /^(\s*(?:>\s*)+)(\[!([\w-]+)\][-+]?)(.*)$/.exec(text)
      spans = m
        ? [
            { text: m[1]!, fg: t.textMuted, attr: A.ITALIC },
            { text: m[2]!, fg: t[CALLOUT_KINDS[calloutKind(m[3]!)]!.color], attr: A.BOLD },
            { text: m[4]!, fg: t.textMuted, attr: A.ITALIC },
          ]
        : [{ text, fg: t.textMuted, attr: A.ITALIC }]
    } else if (/^\s*([-*+]|\d+\.)\s/.test(text)) {
      const m = /^(\s*(?:[-*+]|\d+\.))(.*)$/.exec(text)
      spans = m
        ? [
            { text: m[1]!, fg: t.primary },
            { text: m[2]!, fg: t.text },
          ]
        : [{ text, fg: t.text }]
    } else if (/^\s*\|/.test(text)) spans = [{ text, fg: t.info }]
    else spans = [{ text, fg: t.text }]
    if (i >= fmLines && !hidden[i] && !fenceLines.has(i) && !codeLines.has(i) && !h && !setext) spans = tintWikilinks(spans, t, opts.exists)
    const idx = h ? headings.push({ depth: h.depth, text: h.text, line: lines.length }) - 1 : -1
    const gutter = { text: String(i + 1).padStart(gw) + "  ", fg: t.textMuted }
    const rows = wrap(spans, max, [gutter], [{ text: pad(gw + 2) }])
    rows.forEach((r, k) => lines.push(k === 0 && idx >= 0 ? { spans: r, heading: idx } : { spans: r }))
  })
  return {
    lines,
    headings,
    plain: lines.map((l) =>
      plainOf(l.spans)
        .replace(/\u00a0/g, " ")
        .toLowerCase(),
    ),
    srcRow,
  }
}
