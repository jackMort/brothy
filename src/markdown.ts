import { Marked, type Token, type Tokens, type TokenizerExtension } from "marked"
import type { Theme } from "./theme"

import { isMarkdown } from "./files"
import { codeSpans, type HighlightRequest } from "./highlight"
import { A, safe, safeLine, type Span } from "./spans"

export { A }
export type { Span }

export interface Line {
  spans: Span[]
  /** Background painted across the full row (code blocks). */
  fill?: string
  /** Index into `headings` when this line starts a heading. */
  heading?: number
}

export interface Heading {
  depth: number
  text: string
  line: number
}

export interface Rendered {
  lines: Line[]
  headings: Heading[]
  plain: string[] // lowercase plain text per line, for search
  /** Code blocks drawn without their parser highlighting because it was not cached yet. */
  pending?: HighlightRequest[]
  /** link targets in document order; `Span.link` indexes this (Preview only) */
  links?: LinkTarget[]
  /** Source only: the first row of each source line (jumping to a source line) */
  srcRow?: number[]
}

/** Blocks `r` is still waiting on: `await ensureHighlights(...)`, then re-render if it returns true. */
export const pendingHighlights = (r: Rendered): HighlightRequest[] => r.pending ?? []

export interface FrontMatter {
  entries: [string, string][]
  body: string
  offset: number // number of source lines consumed by front matter
}

export const width = (s: string) => Bun.stringWidth(s)

/** Drop a BOM and unify line endings so every later stage can split on "\n". */
const normalize = (s: string) => safe(s.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"))

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
    if (m) return { type: "highlight", raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) }
  },
}

export type LinkTarget =
  | { kind: "wiki"; target: string; heading?: string; embed: boolean }
  | { kind: "md"; href: string }
  | { kind: "url"; href: string }

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
    if (m) return { type: "wikilink", raw: m[0], embed: m[1] === "!", ...parseWikilink(m[2]!) }
  },
}

/** Where `inline()` records link targets while rendering; absent for outline titles. */
interface LinkSink {
  links: LinkTarget[]
  exists?: (target: string) => boolean
}

export interface RenderOpts {
  /** whether a wikilink target resolves to a note; unresolved links are drawn muted */
  exists?: (target: string) => boolean
}

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

const lexBlocks = (src: string): Token[] => new CappedLexer(md.defaults).lex(src)

/** `lexBlocks` for the outline: only headings get their inline pass, as nothing else is read from the inline tokens. */
function lexOutline(src: string): Token[] {
  const lx = new CappedLexer(md.defaults)
  const tokens = lx.blockTokens(src, lx.tokens)
  const wanted = new Set<Token[]>()
  const find = (toks: Token[]) => {
    for (const tok of toks) {
      if (tok.type === "heading") wanted.add((tok as Tokens.Heading).tokens)
      else if (tok.type === "blockquote") find((tok as Tokens.Blockquote).tokens)
      else if (tok.type === "list") for (const item of (tok as Tokens.List).items) find(item.tokens)
    }
  }
  find(tokens)
  for (const q of lx.inlineQueue) if (wanted.has(q.tokens)) lx.inlineTokens(q.src, q.tokens)
  return tokens
}
const lexInline = (src: string): Token[] => new CappedLexer(md.defaults).inlineTokens(src)

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

const maxOf = (xs: number[], init = 0) => xs.reduce((m, x) => (x > m ? x : m), init)

const FRONT = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

export function parseFrontMatter(src: string): FrontMatter {
  src = normalize(src)
  const m = FRONT.exec(src)
  if (!m) return { entries: [], body: src, offset: 0 }
  const entries: [string, string][] = []
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(line)
    if (kv) entries.push([kv[1]!, safeLine(kv[2]!.replace(/^["']|["']$/g, ""))])
  }
  return { entries, body: src.slice(m[0].length), offset: m[0].replace(/\r?\n$/, "").split("\n").length }
}

export type Property = [string, string | string[]]
/** Keys whose plain `a, b` values are lists (Obsidian writes `tags: a, b`). */
const LIST_KEYS = new Set(["tags", "tag", "aliases", "alias", "cssclasses"])
const unquote = (s: string) => {
  const t = safeLine(s).trim()
  return t.length >= 2 && /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t
}

/**
 * Front-matter properties, tolerant of the YAML Obsidian writes: `k: v` scalars (quotes
 * stripped), flow lists `[a, b]`, comma lists for list-like keys, and block lists (`k:` then
 * `  - a` lines). Other nested YAML is skipped.
 */
export function parseProperties(src: string): Property[] {
  const m = FRONT.exec(normalize(src))
  if (!m) return []
  const lines = (m[1] ?? "").split(/\r?\n/)
  const out: Property[] = []
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    const key = kv[1]!
    const raw = kv[2]!.trim()
    if (raw === "") {
      const items: string[] = []
      while (i + 1 < lines.length && /^\s*-(\s|$)/.test(lines[i + 1]!)) {
        const item = unquote(lines[++i]!.replace(/^\s*-\s*/, ""))
        if (item) items.push(item)
      }
      out.push([key, items.length ? items : ""])
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      out.push([key, raw.slice(1, -1).split(",").map(unquote).filter(Boolean)])
    } else if (LIST_KEYS.has(key.toLowerCase()) && raw.includes(",")) {
      out.push([key, raw.split(",").map(unquote).filter(Boolean)])
    } else out.push([key, unquote(raw)])
  }
  return out
}

// ---------------------------------------------------------------- wrapping

const same = (a: Span, b: Span) => a.fg === b.fg && a.bg === b.bg && (a.attr ?? 0) === (b.attr ?? 0) && a.link === b.link

function push(spans: Span[], s: Span) {
  if (!s.text) return
  const last = spans[spans.length - 1]
  if (last && same(last, s)) last.text += s.text
  else spans.push({ ...s })
}

const spanWidth = (spans: Span[]) => spans.reduce((n, s) => n + width(s.text), 0)

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const graphemes = (s: string) => Array.from(segmenter.segment(s), (x) => x.segment)

/**
 * Word-wrap styled spans to `max` columns. `first`/`rest` are prefixes drawn
 * on the first and following rows (indentation, bullets, quote bars).
 * A "\n" inside a span forces a hard break. With `preserve`, whitespace is
 * kept verbatim and rows break only at "\n" or by hard-chopping (code).
 * Text is cut on grapheme boundaries and measured per grapheme.
 */
export function wrap(spans: Span[], max: number, first: Span[] = [], rest: Span[] = first, preserve = false): Span[][] {
  const rows: Span[][] = []
  let row: Span[] = first.map((s) => ({ ...s }))
  let w = spanWidth(first)
  let base = w
  let pendingSpace: Span | null = null
  const newRow = () => {
    rows.push(row)
    row = rest.map((s) => ({ ...s }))
    w = spanWidth(rest)
    base = w
    pendingSpace = null
  }
  /** Place text grapheme by grapheme, starting a new row when one would overflow. */
  const place = (s: Span, text: string) => {
    for (const g of graphemes(text)) {
      const gw = width(g)
      if (w + gw > max && w > base) newRow()
      push(row, { ...s, text: g })
      w += gw
    }
  }
  if (preserve) {
    for (const s of spans) {
      s.text.split("\n").forEach((seg, i) => {
        if (i > 0) newRow()
        place(s, seg)
      })
    }
    rows.push(row)
    return rows
  }
  for (const s of spans) {
    const parts = s.text.split(/(\n|[ \t]+)/)
    for (const part of parts) {
      if (!part) continue
      if (part === "\n") {
        newRow()
        continue
      }
      if (/^[ \t]+$/.test(part)) {
        if (w > base) pendingSpace = { ...s, text: " " }
        continue
      }
      const pw = width(part)
      const sp = pendingSpace ? 1 : 0
      if (w > base && w + sp + pw > max) newRow()
      else if (pendingSpace) {
        push(row, pendingSpace)
        w += 1
      }
      pendingSpace = null
      if (pw > max - base) place(s, part)
      else {
        push(row, { ...s, text: part })
        w += pw
      }
    }
  }
  rows.push(row)
  return rows
}

// ---------------------------------------------------------------- inline

/** HTML tags brothy strips (their text stays); anything else is shown literally, so `Promise<void>` survives. */
const HTML_TAGS = new Set([
  "div", "span", "p", "img", "br", "kbd", "sup", "sub", "u", "mark", "small", "b", "i", "em", "strong", "a",
  "center", "font", "details", "summary", "iframe", "video", "audio", "picture", "source", "figure", "figcaption", "hr",
])
/** Closing these ends a line. */
const HTML_BLOCKS = new Set(["div", "p", "figure", "figcaption", "details", "summary", "center"])
const HTML_TAG = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g

/** Block HTML as text: comments and known tags removed, `<br>` and block closers become line breaks. */
export function stripTags(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(HTML_TAG, (m, close: string, name: string) => {
    const n = name.toLowerCase()
    if (!HTML_TAGS.has(n)) return m
    if (n === "br" || n === "hr" || (close && HTML_BLOCKS.has(n))) return "\n"
    return ""
  })
}

function inline(tokens: Token[] | undefined, t: Theme, base: Omit<Span, "text"> = { fg: t.text }, sink?: LinkSink): Span[] {
  const out: Span[] = []
  if (!tokens) return out
  let cur = base
  for (const tok of tokens) {
    switch (tok.type) {
      case "text":
      case "escape": {
        const tt = tok as Tokens.Text
        if (tt.tokens && tt.tokens.length) out.push(...inline(tt.tokens, t, cur, sink))
        else out.push({ ...cur, text: decode(tt.text) })
        break
      }
      case "strong":
        out.push(...inline((tok as Tokens.Strong).tokens, t, { ...cur, attr: (cur.attr ?? 0) | A.BOLD }, sink))
        break
      case "em":
        out.push(...inline((tok as Tokens.Em).tokens, t, { ...cur, attr: (cur.attr ?? 0) | A.ITALIC }, sink))
        break
      case "del":
        out.push(
          ...inline((tok as Tokens.Del).tokens, t, {
            ...cur,
            fg: t.textMuted,
            attr: (cur.attr ?? 0) | A.STRIKE,
          }, sink),
        )
        break
      case "highlight":
        out.push(...inline((tok as Tokens.Generic).tokens, t, { ...cur, fg: t.warning, bg: t.backgroundElement }, sink))
        break
      case "codespan":
        out.push({
          text: safe((tok as Tokens.Codespan).text).replace(/ /g, " "),
          fg: t.accent,
          bg: t.backgroundElement,
        })
        break
      case "link": {
        const l = tok as Tokens.Link
        const style: Omit<Span, "text"> = { ...cur, fg: t.info, attr: (cur.attr ?? 0) | A.UNDERLINE }
        if (sink) style.link = sink.links.push(/^[a-z][\w+.-]*:/i.test(l.href) ? { kind: "url", href: l.href } : { kind: "md", href: l.href }) - 1
        out.push(...inline(l.tokens, t, style, sink))
        break
      }
      case "wikilink": {
        const w = tok as unknown as Wikilink & { embed: boolean }
        if (w.embed && /\.[^/.]+$/.test(w.target) && !isMarkdown(w.target)) {
          out.push({ text: `▣ ${safe(w.target.split("/").at(-1)!)}`, fg: t.textMuted, attr: A.ITALIC })
          break
        }
        const ok = !w.target || !sink?.exists || sink.exists(w.target)
        const style: Omit<Span, "text"> = { ...cur, fg: ok ? t.info : t.textMuted, attr: (cur.attr ?? 0) | A.UNDERLINE }
        if (sink) {
          const l: LinkTarget = { kind: "wiki", target: w.target, embed: w.embed }
          if (w.heading) l.heading = w.heading
          style.link = sink.links.push(l) - 1
        }
        if (w.embed) out.push({ ...cur, text: "↳ ", fg: t.textMuted })
        out.push({ ...style, text: safe(wikiLabel(w)) })
        break
      }
      case "image": {
        const im = tok as Tokens.Image
        out.push({ text: `▣ ${safe(im.text) || "image"}`, fg: t.textMuted, attr: A.ITALIC })
        break
      }
      case "br":
        out.push({ ...cur, text: "\n" })
        break
      case "html": {
        const raw = (tok as Tokens.HTML).text
        if (/^\s*<!--/.test(raw)) break
        const m = /^\s*<(\/?)([a-zA-Z][\w-]*)\b[^>]*>\s*$/.exec(raw)
        const name = m?.[2]!.toLowerCase()
        if (!m || !HTML_TAGS.has(name!)) {
          out.push({ text: safe(raw), fg: t.textMuted })
          break
        }
        if (name === "br") out.push({ ...cur, text: "\n" })
        else if (name === "kbd") cur = m[1] ? base : { ...base, fg: t.accent, bg: t.backgroundElement }
        else if (name === "mark") cur = m[1] ? base : { ...base, fg: t.warning, bg: t.backgroundElement }
        break
      }
      default:
        if ("text" in tok) out.push({ ...cur, text: decode(String(tok.text)) })
    }
  }
  return out
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }

/** Single-pass entity decode, so "&amp;lt;" becomes "&lt;" and not "<". */
function decode(s: string): string {
  return safe(s).replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g, (m, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name]!
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16)
    // refuse control characters (marked itself decodes most numeric entities; `safe` covers those)
    const ok = cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0x7f && cp <= 0x9f) && !(cp >= 0xd800 && cp <= 0xdfff)
    return ok ? String.fromCodePoint(cp) : m
  })
}

const plainOf = (spans: Span[]) => spans.map((s) => s.text).join("")

// ---------------------------------------------------------------- callouts

export interface CalloutKind {
  icon: string
  color: "info" | "accent" | "secondary" | "success" | "warning" | "error" | "textMuted"
  /** body reads as a plain quote (muted italic) */
  quote?: boolean
}

/** Obsidian's callout kinds; every icon is one column wide. */
export const CALLOUT_KINDS: Record<string, CalloutKind> = {
  note: { icon: "✎", color: "info" },
  abstract: { icon: "≡", color: "secondary" },
  info: { icon: "ℹ", color: "info" },
  todo: { icon: "☐", color: "info" },
  tip: { icon: "★", color: "accent" },
  success: { icon: "✓", color: "success" },
  question: { icon: "?", color: "warning" },
  warning: { icon: "▲", color: "warning" },
  failure: { icon: "✗", color: "error" },
  danger: { icon: "✱", color: "error" },
  bug: { icon: "¤", color: "error" },
  example: { icon: "▸", color: "secondary" },
  quote: { icon: "❝", color: "textMuted", quote: true },
}

const CALLOUT_ALIASES: Record<string, string> = {
  summary: "abstract", tldr: "abstract", hint: "tip", important: "tip", check: "success", done: "success",
  help: "question", faq: "question", caution: "warning", attention: "warning", fail: "failure", missing: "failure",
  error: "danger", cite: "quote",
}

/** The kind a `[!type]` draws as: case-insensitive, aliases folded, unknown types are notes. */
export function calloutKind(type: string): string {
  const k = type.toLowerCase()
  if (Object.hasOwn(CALLOUT_KINDS, k)) return k
  return Object.hasOwn(CALLOUT_ALIASES, k) ? CALLOUT_ALIASES[k]! : "note"
}

export interface Callout {
  kind: string
  fold: "" | "-" | "+"
  title: string
  /** the quote's text after the `[!type]` line, still Markdown */
  body: string
}

/** A blockquote whose first line is `[!type][-+] title`, else null. */
export function calloutOf(q: Tokens.Blockquote): Callout | null {
  // a setext underline in the body makes marked read the `[!type]` line as part of a heading
  const first = q.tokens[0]?.type
  if (first !== "paragraph" && first !== "heading") return null
  const src = q.text.replace(/^[ \t]+/, "")
  const nl = src.indexOf("\n")
  const m = /^\[!([\w-]+)\]([-+]?)[ \t]*(.*)$/.exec(nl < 0 ? src : src.slice(0, nl))
  if (!m) return null
  const type = m[1]!.toLowerCase()
  return {
    kind: calloutKind(type),
    fold: m[2] as Callout["fold"],
    title: m[3]!.trim() || type[0]!.toUpperCase() + type.slice(1),
    body: nl < 0 ? "" : src.slice(nl + 1),
  }
}

// ---------------------------------------------------------------- blocks

const pad = (n: number) => " ".repeat(Math.max(0, n))

interface Ctx {
  t: Theme
  lines: Line[]
  headings: Heading[]
  pending: HighlightRequest[]
  sink: LinkSink
}

function emitRows(ctx: Ctx, rows: Span[][], extra: Partial<Line> = {}) {
  rows.forEach((spans, i) => ctx.lines.push(i === 0 ? { spans, ...extra } : { spans }))
}

function blank(ctx: Ctx, prefix: Span[]) {
  const last = ctx.lines[ctx.lines.length - 1]
  if (!last) return
  if (last.fill === undefined && plainOf(last.spans).trim() === plainOf(prefix).trim()) return
  ctx.lines.push({ spans: prefix.map((s) => ({ ...s })) })
}

/** Quotes read as muted italic: plain text from line `from` on; bars and filled spans keep their color. */
function muteQuote(ctx: Ctx, from: number) {
  const { t } = ctx
  for (let i = from; i < ctx.lines.length; i++)
    for (const s of ctx.lines[i]!.spans)
      if (s.text !== "▎ " && !s.bg && s.fg === t.text) {
        s.fg = t.textMuted
        s.attr = (s.attr ?? 0) | A.ITALIC
      }
}

/** A callout: a header row (icon, title, ▾ when it has a fold marker), then the body under a bar in the kind color. */
function callout(ctx: Ctx, c: Callout, max: number, first: Span[], rest: Span[], depth: number) {
  const { t } = ctx
  const k = CALLOUT_KINDS[c.kind]!
  const fg = t[k.color]
  const bar = { text: "▎ ", fg }
  const start = ctx.lines.length
  const head: Span[] = [{ text: `${k.icon} `, fg, attr: A.BOLD }, ...inline(lexInline(c.title), t, { fg, attr: A.BOLD }, ctx.sink)]
  if (c.fold) head.push({ text: " ▾", fg: t.textMuted })
  emitRows(ctx, wrap(head, max, [...first, bar], [...rest, bar]))
  const bodyStart = ctx.lines.length
  if (c.body.trim()) blocks(ctx, lexBlocks(c.body), max, [...rest, bar], [...rest, bar], depth)
  if (k.quote) muteQuote(ctx, bodyStart)
  trimTrailingBlank(ctx, start, [...rest, bar])
  ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
}

/** `depth` is the list nesting level, used to pick the bullet glyph. */
/** Fences Obsidian runs as queries: shown as one collapsed row; the query is read in Source. */
const DATAVIEW_LANGS = new Set(["dataview", "dataviewjs", "tasks"])

function blocks(ctx: Ctx, tokens: Token[], max: number, first: Span[], rest: Span[], depth = 0) {
  const { t } = ctx
  let usedFirst = false
  const pre = () => {
    if (usedFirst) return rest
    usedFirst = true
    return first
  }
  for (const tok of tokens) {
    switch (tok.type) {
      case "space":
        break
      case "heading": {
        const h = tok as Tokens.Heading
        const text = inline(h.tokens, t, undefined, ctx.sink)
        const colors = [t.primary, t.secondary, t.accent, t.text, t.text, t.textMuted]
        const fg = colors[h.depth - 1] ?? t.text
        const styled = text.map((s) => ({ ...s, fg: s.bg ? s.fg : fg, attr: (s.attr ?? 0) | A.BOLD }))
        const idx = ctx.headings.length
        ctx.headings.push({ depth: h.depth, text: plainOf(text).replace(/ /g, " "), line: ctx.lines.length })
        blank(ctx, rest)
        ctx.headings[idx]!.line = ctx.lines.length
        const p = pre()
        if (h.depth === 1) {
          const rows = wrap(styled, max, p, rest)
          emitRows(ctx, rows, { heading: idx })
          const tw = Math.max(0, Math.min(max - spanWidth(rest), maxOf(rows.map((r) => spanWidth(r) - spanWidth(rest)))))
          ctx.lines.push({
            spans: [
              ...rest,
              { text: "━".repeat(tw), fg: fg },
              { text: "─".repeat(Math.max(0, max - spanWidth(rest) - tw)), fg: t.border },
            ],
          })
        } else {
          const mark = { text: "#".repeat(h.depth) + " ", fg: t.textMuted, attr: A.BOLD }
          const rows = wrap(styled, max, [...p, mark], [...rest, { text: pad(h.depth + 1) }])
          emitRows(ctx, rows, { heading: idx })
        }
        ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
        break
      }
      case "paragraph":
      case "text": {
        const p = tok as Tokens.Paragraph
        emitRows(ctx, wrap(inline(p.tokens, t, undefined, ctx.sink), max, pre(), rest))
        if (tok.type === "paragraph") ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
        break
      }
      case "blockquote": {
        const q = tok as Tokens.Blockquote
        const c = calloutOf(q)
        if (c) {
          callout(ctx, c, max, pre(), rest, depth)
          break
        }
        const bar = { text: "▎ ", fg: t.primary }
        const start = ctx.lines.length
        blocks(ctx, q.tokens, max, [...pre(), bar], [...rest, bar], depth)
        muteQuote(ctx, start)
        trimTrailingBlank(ctx, start, [...rest, bar])
        ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
        break
      }
      case "list": {
        const l = tok as Tokens.List
        const start = typeof l.start === "number" ? l.start : 1
        const numW = l.ordered ? String(start + l.items.length - 1).length + 1 : 1
        l.items.forEach((item, i) => {
          const bare = item.task ? null : /^\[([ xX])\]$/.exec(item.text.trim())
          const task = item.task || !!bare
          const checked = item.task ? !!item.checked : !!bare && bare[1] !== " "
          const marker: Span[] = []
          if (l.ordered) {
            marker.push({ text: `${start + i}.`.padStart(numW), fg: t.primary })
            if (task) marker.push({ text: " " })
          }
          if (task) {
            marker.push(
              checked
                ? { text: "[x]", fg: t.success, attr: A.BOLD }
                : { text: "[ ]", fg: t.textMuted },
            )
          } else if (!l.ordered) {
            marker.push({ text: ["•", "◦", "▪"][depth % 3]!, fg: t.primary })
          }
          const mw = spanWidth(marker) + 1
          const itemFirst = [...(i === 0 ? pre() : rest), ...marker, { text: " " }]
          const itemRest = [...rest, { text: pad(mw) }]
          const startLine = ctx.lines.length
          const body = item.tokens.filter((x) => !(task && x.type === "checkbox"))
          if (bare) ctx.lines.push({ spans: itemFirst.map((s) => ({ ...s })) })
          else blocks(ctx, body, max, itemFirst, itemRest, depth + 1)
          if (checked) {
            for (let k = startLine; k < ctx.lines.length; k++)
              for (const s of ctx.lines[k]!.spans) if (s.fg === t.text) s.fg = t.textMuted
          }
          if (!l.loose) trimTrailingBlank(ctx, startLine, rest)
        })
        ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
        break
      }
      case "code": {
        const c = tok as Tokens.Code
        const lang = (c.lang ?? "").split(/\s/)[0] ?? ""
        if (DATAVIEW_LANGS.has(lang.toLowerCase())) {
          const fill = t.backgroundElement
          const n = c.text === "" ? 0 : c.text.split("\n").length
          const label = `⌁ ${lang} · ${n} ${n === 1 ? "line" : "lines"}`
          const hint = "s: source"
          const p0 = pre()
          const avail = max - spanWidth(p0) - 2
          const gap = avail - width(label) - width(hint)
          const body: Span[] =
            gap >= 2
              ? [{ text: label, fg: t.textMuted, bg: fill }, { text: pad(gap), bg: fill }, { text: hint, fg: t.textMuted, bg: fill }]
              : truncate([{ text: label, fg: t.textMuted, bg: fill }], Math.max(1, avail))
          const row: Span[] = [...p0, { text: "  ", bg: fill }, ...body]
          row.push({ text: pad(max - spanWidth(row)), bg: fill })
          ctx.lines.push({ spans: row, fill })
          ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
          break
        }
        const p0 = pre()
        const inner = max - spanWidth(rest)
        const fill = t.backgroundElement
        const label = lang ? ` ${lang} ` : ""
        ctx.lines.push({
          spans: [...p0, { text: pad(inner - width(label)), bg: fill }, { text: label, fg: t.textMuted, bg: fill }],
          fill,
        })
        const { lines: codeLines, pending } = codeSpans(lang, c.text.replace(/\t/g, "    "), t)
        if (pending) ctx.pending.push(pending)
        for (const line of codeLines) {
          const hl = line.map((s) => ({ ...s, bg: fill }))
          const rows = wrap(
            hl.length ? hl : [{ text: "", bg: fill }],
            max - 2,
            [...rest, { text: "  ", bg: fill }],
            [...rest, { text: "↪ ", fg: t.textMuted, bg: fill }],
            true,
          )
          for (const r of rows) {
            r.push({ text: pad(max - spanWidth(r)), bg: fill })
            ctx.lines.push({ spans: r, fill })
          }
        }
        ctx.lines.push({ spans: [...rest, { text: pad(inner), bg: fill }], fill })
        ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
        break
      }
      case "hr": {
        const p = pre()
        ctx.lines.push({ spans: [...p, { text: "─".repeat(Math.max(0, max - spanWidth(p))), fg: t.borderSubtle }] })
        ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
        break
      }
      case "table":
        table(ctx, tok as Tokens.Table, max, pre(), rest)
        break
      case "html": {
        const txt = stripTags((tok as Tokens.HTML).text)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .join("\n")
        if (!txt) break
        emitRows(ctx, wrap([{ text: decode(txt), fg: t.textMuted }], max, pre(), rest))
        ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
        break
      }
      case "def":
        break
      default: {
        const raw = (tok as { raw?: string }).raw?.trim()
        if (raw) emitRows(ctx, wrap([{ text: raw, fg: t.text }], max, pre(), rest))
      }
    }
  }
}

function trimTrailingBlank(ctx: Ctx, from: number, rest: Span[]) {
  const r = plainOf(rest).trim()
  while (ctx.lines.length > from + 1) {
    const last = ctx.lines[ctx.lines.length - 1]!
    if (last.fill === undefined && plainOf(last.spans).trim() === r && last.heading === undefined) ctx.lines.pop()
    else break
  }
}

/** Column widths that sum to at most `avail` (>= columns): narrow columns keep theirs, wide ones shrink proportionally. */
function fitWidths(natural: number[], avail: number): number[] {
  const total = natural.reduce((a, b) => a + b, 0)
  if (total <= avail) return natural
  const w = natural.map(() => 0)
  let left = avail
  let open = natural.map((_, i) => i)
  for (;;) {
    const share = Math.floor(left / open.length)
    const small = open.filter((i) => natural[i]! <= share)
    if (!small.length) break
    for (const i of small) {
      w[i] = natural[i]!
      left -= natural[i]!
    }
    open = open.filter((i) => !small.includes(i))
  }
  const sum = open.reduce((a, i) => a + natural[i]!, 0)
  let used = 0
  for (const i of open) {
    w[i] = Math.max(1, Math.floor((natural[i]! * left) / sum))
    used += w[i]!
  }
  for (let k = 0; used < left; k = (k + 1) % open.length) {
    w[open[k]!]!++
    used++
  }
  while (used > left) {
    const i = open.reduce((best, j) => (w[j]! > w[best]! ? j : best), open[0]!)
    w[i]!--
    used--
  }
  return w
}

/** Cut a single-line version of `spans` to `max` columns, ending in "…" when it does not fit. */
function truncate(spans: Span[], max: number): Span[] {
  const flat = spans.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ") }))
  if (spanWidth(flat) <= max) return flat
  const out: Span[] = []
  let w = 0
  for (const s of flat) {
    for (const g of graphemes(s.text)) {
      const gw = width(g)
      if (w + gw > max - 1) {
        push(out, { ...s, text: "…" })
        return out
      }
      push(out, { ...s, text: g })
      w += gw
    }
  }
  return out
}

/** Columns narrower than this are cut to one line with "…" instead of wrapped. */
const MIN_WRAP_COL = 4

function table(ctx: Ctx, tb: Tokens.Table, max: number, first: Span[], rest: Span[]) {
  const { t } = ctx
  const prefixW = Math.max(spanWidth(first), spanWidth(rest))
  // every column needs at least 1 cell plus 3 of border/padding, and the table 1 more border
  const fits = Math.floor((max - prefixW - 1) / 4)
  // columns that do not fit are replaced by one narrow "…" column; that needs room for one real column too
  const dropped = tb.header.length > fits
  if (fits < (dropped ? 2 : 1)) {
    emitRows(ctx, wrap([{ text: tb.raw.trim(), fg: t.textMuted }], max, first, rest))
    ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
    return
  }
  const cols = dropped ? fits - 1 : tb.header.length
  const more: Span[][] = dropped ? [[{ text: "…", fg: t.textMuted }]] : []
  const header = tb.header
    .slice(0, cols)
    .map((c) => inline(c.tokens, t, undefined, ctx.sink).map((s) => ({ ...s, fg: s.bg ? s.fg : t.primary, attr: (s.attr ?? 0) | A.BOLD })))
  const rows = tb.rows.map((r) => r.slice(0, cols).map((c) => inline(c.tokens, t, undefined, ctx.sink)))
  const avail = max - prefixW - (cols + 1 + more.length) - (cols + more.length) * 2 - more.length
  const natural = Array.from({ length: cols }, (_, i) =>
    Math.max(3, spanWidth(header[i] ?? []), maxOf(rows.map((r) => spanWidth(r[i] ?? [])))),
  )
  const widths = [...fitWidths(natural, avail), ...more.map(() => 1)]
  const B = t.border
  const rule = (l: string, m: string, r: string, p: Span[]) => ({
    spans: [...p, { text: l + widths.map((w) => "─".repeat(w + 2)).join(m) + r, fg: B }],
  })
  const row = (cells: Span[][], p: Span[]) => {
    const wrapped = widths.map((cw, i) => (cw < MIN_WRAP_COL ? [truncate(cells[i] ?? [], cw)] : wrap(cells[i] ?? [], cw)))
    const h = maxOf(wrapped.map((w) => w.length), 1)
    for (let k = 0; k < h; k++) {
      const spans: Span[] = [...(k === 0 ? p : rest), { text: "│", fg: B }]
      wrapped.forEach((w, i) => {
        const cell = w[k] ?? []
        const gap = widths[i]! - spanWidth(cell)
        const align = tb.align[i]
        const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0
        spans.push({ text: " " + pad(left) }, ...cell, { text: pad(gap - left) + " " }, { text: "│", fg: B })
      })
      ctx.lines.push({ spans })
    }
  }
  ctx.lines.push(rule("┌", "┬", "┐", first))
  row([...header, ...more], rest)
  ctx.lines.push(rule("├", "┼", "┤", rest))
  rows.forEach((r) => row([...r, ...more], rest))
  ctx.lines.push(rule("└", "┴", "┘", rest))
  ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
}

/** Lay out a Markdown document into styled, wrapped terminal lines. */
export function render(src: string, max: number, t: Theme, opts: RenderOpts = {}): Rendered {
  const tokens = lexBlocks(stripComments(normalize(src)))
  const ctx: Ctx = { t, lines: [], headings: [], pending: [], sink: { links: [], exists: opts.exists } }
  blocks(ctx, tokens, Math.max(10, max), [], [])
  while (ctx.lines.length && plainOf(ctx.lines[ctx.lines.length - 1]!.spans).trim() === "" && ctx.lines[ctx.lines.length - 1]!.fill === undefined)
    ctx.lines.pop()
  while (ctx.lines.length && plainOf(ctx.lines[0]!.spans).trim() === "" && ctx.lines[0]!.heading === undefined && ctx.lines[0]!.fill === undefined) {
    ctx.lines.shift()
    ctx.headings.forEach((h) => h.line--)
  }
  return {
    lines: ctx.lines,
    headings: ctx.headings,
    plain: ctx.lines.map((l) => plainOf(l.spans).replace(/ /g, " ").toLowerCase()),
    pending: ctx.pending,
    links: ctx.sink.links,
  }
}

interface SourceHeading {
  depth: number
  text: string
  /** Last source line of the heading (differs from the first for setext). */
  end: number
  setext: boolean
}

/**
 * Line-based mirror of the Markdown block rules that matter for the outline, for notes whose
 * blocks are only headings, fences, quotes and paragraphs (`needsLexer` says when that does not hold):
 * fences (matching char and length), ATX and setext headings, quotes. `lines` have their
 * `%%comments%%` cut (`scanComments().kept`), so titles and structure match what Preview lexes.
 */
export function sourceStructureLines(lines: string[], from: number, t: Theme, hidden: boolean[]) {
  const headings = new Map<number, SourceHeading>()
  const fenceLines = new Set<number>()
  const codeLines = new Set<number>()
  const title = (raw: string) => plainOf(inline(lexInline(raw), t)).replace(/\u00a0/g, " ")
  // fences and paragraphs remember their quote depth: a quote ending closes a fence, and an
  // underline only makes a setext heading at its paragraph's depth
  let fence: { ch: string; len: number; depth: number } | null = null
  let para: number[] = []
  let paraDepth = 0
  const bodies: string[] = []
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!
    const quote = /^ {0,3}(?:> ?)+/.exec(line)
    const depth = quote ? quote[0].split(">").length - 1 : 0
    const body = quote ? line.slice(quote[0].length) : line
    bodies[i] = body
    if (fence && depth < fence.depth) fence = null
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body)
      if (close && depth === fence.depth && close[1]![0] === fence.ch && close[1]!.length >= fence.len) {
        fence = null
        fenceLines.add(i)
      } else codeLines.add(i)
      continue
    }
    // Preview never sees a comment-only line, so the lines around it meet
    if (hidden[i]) continue
    if (para.length && depth > paraDepth) para = [] // a quote interrupts the paragraph
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body)
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { ch: open[1]![0]!, len: open[1]!.length, depth }
      fenceLines.add(i)
      para = []
      continue
    }
    if (/^[ \t]*$/.test(body)) {
      para = []
      continue
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(body)
    if (atx) {
      const text = (atx[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim()
      headings.set(i, { depth: atx[1]!.length, text: title(text), end: i, setext: false })
      para = []
      continue
    }
    // one `-` is enough: an empty list item can't interrupt a paragraph, so `Para\n-` is a setext h2
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(body)
    if (underline && para.length && depth === paraDepth) {
      const text = para.map((k) => bodies[k]!.trimStart()).join("\n").trimEnd()
      headings.set(para[0]!, { depth: underline[1]![0] === "=" ? 1 : 2, text: title(text), end: i, setext: true })
      para = []
      continue
    }
    if (/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(body) || /^ {0,3}([-*+]|\d{1,9}[.)])([ \t]|$)/.test(body) || /^ {0,3}\|/.test(body)) {
      para = []
      continue
    }
    // a lazy line continues a quoted paragraph, which can no longer take an underline
    if (para.length && depth < paraDepth) {
      para = []
      continue
    }
    // a callout's `[!type]` line is its title, never part of a paragraph
    if (depth && !para.length && /^\[![\w-]+\]/.test(body)) continue
    if (!para.length && /^( {4}|\t)/.test(body)) continue // indented code
    if (!para.length) paraDepth = depth
    para.push(i)
  }
  return { headings, fenceLines, codeLines }
}

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
    if (/\t|\||^ {0,3}[<\[]/.test(line)) return true
    const item = /^( *)(?:[-*+]|\d{1,9}[.)])[ \t]+(.?)/.exec(line)
    const quote = /^ {0,3}>[ \t]?(.?)/.exec(line)
    if (item) {
      if (item[1]!.length > 8 || !/^[\p{L}]$/u.test(item[2]!)) return true
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
          const h = tok as Tokens.Heading
          const title = plainOf(inline(h.tokens, t)).replace(/\u00a0/g, " ")
          headings.set(at[line]!, { depth: h.depth, text: title, end: at[line + rowsOf() - 1] ?? at[line]!, setext: !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(tok.raw) })
          break
        }
        case "code": {
          if ((tok as Tokens.Code).codeBlockStyle === "indented") break
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
          const q = tok as Tokens.Blockquote
          const c = calloutOf(q)
          if (c) walk(lexOutline(c.body), c.body, line + 1)
          else walk(q.tokens, q.text, line)
          break
        }
        case "list": {
          const l = tok as Tokens.List
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

export interface SourceScan {
  /** the Source outline (same headings, same order as `renderSource`), with each heading's first and last source line */
  headings: { depth: number; text: string; line: number; end: number }[]
  /**
   * Per source line, what the Preview can show as prose: comments cut; front matter,
   * comment-only lines, fence lines and fenced code blank. Line numbers match `renderSource`.
   */
  text: string[]
}

/** A note's outline and searchable lines without laying it out (the switcher's index). */
export function sourceScan(src: string, t: Theme): SourceScan {
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
      .split(/(!?\[\[[^\[\]\n]+\]\])/)
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
    }
    else if (/^\s*([-*+]|\d+\.)\s/.test(text)) {
      const m = /^(\s*(?:[-*+]|\d+\.))(.*)$/.exec(text)
      spans = m ? [{ text: m[1]!, fg: t.primary }, { text: m[2]!, fg: t.text }] : [{ text, fg: t.text }]
    } else if (/^\s*\|/.test(text)) spans = [{ text, fg: t.info }]
    else spans = [{ text, fg: t.text }]
    if (i >= fmLines && !hidden[i] && !fenceLines.has(i) && !codeLines.has(i) && !h && !setext) spans = tintWikilinks(spans, t, opts.exists)
    const idx = h ? headings.push({ depth: h.depth, text: h.text, line: lines.length }) - 1 : -1
    const gutter = { text: String(i + 1).padStart(gw) + "  ", fg: t.textMuted }
    const rows = wrap(spans, max, [gutter], [{ text: pad(gw + 2) }])
    rows.forEach((r, k) => lines.push(k === 0 && idx >= 0 ? { spans: r, heading: idx } : { spans: r }))
  })
  return { lines, headings, plain: lines.map((l) => plainOf(l.spans).replace(/\u00a0/g, " ").toLowerCase()), srcRow }
}

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
        const tb = tok as Tokens.Table
        for (const cell of [...tb.header, ...tb.rows.flat()]) walk(cell.tokens)
      }
      if (tok.type === "list")
        for (const it of (tok as Tokens.List).items)
          if (it.task || /^\[[ xX]\]$/.test(it.text.trim())) {
            s.tasks[1]++
            if (it.task ? it.checked : !/^\[ \]$/.test(it.text.trim())) s.tasks[0]++
          }
      const anyTok = tok as unknown as { tokens?: Token[]; items?: Token[] }
      if (anyTok.tokens) walk(anyTok.tokens)
      if (anyTok.items) walk(anyTok.items)
    }
  }
  walk(tokens)
  s.words = (src.replace(/```[\s\S]*?```/g, "").replace(/\[[ xX]\]/g, "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length
  s.minutes = Math.max(1, Math.round(s.words / 220))
  // wikilinks (`[[note]]`, `![[embed]]`) are links too; marked leaves them as text
  s.links += (stripCode(src).match(/!?\[\[[^\[\]\n]+\]\]/g) ?? []).length
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
