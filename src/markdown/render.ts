// The Preview renderer: Markdown in, pre-wrapped styled lines out (`Span[]` per `Line`) at a given width, with each
// heading's line and the link targets. Pure apart from reading the code-highlight cache. Scrolling, heading jumps and
// search work on these exact line indexes, so a rendering change must keep the line↔heading mapping. Holds the
// inline spans, callouts, blocks and tables; the lexer, front matter, Source view and stats have their own modules.

import type { Token, Tokens } from "marked"
import { A, type Span, safe } from "../lib/spans"
import { graphemes, pushSpan, spanWidth, width, wrap } from "../lib/text"
import { isMarkdown } from "../notes/files"
import type { Theme } from "../theme/theme"
import type { HeadingStyle } from "./heading-style"
import { codeSpans, type HighlightRequest } from "./highlight"
import { isWikilink, lexBlocks, lexInline, normalize, stripComments, tokenOf, wikiLabel } from "./lexer"

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

/** A rendering's line geometry, which scroll offsets are measured against (`remapTop`): heading lines and total line count. */
export interface Geometry {
  heads: number[]
  total: number
}

/** Blocks `r` is still waiting on: `await ensureHighlights(...)`, then re-render if it returns true. */
export const pendingHighlights = (r: Rendered): HighlightRequest[] => r.pending ?? []

export type LinkTarget = { kind: "wiki"; target: string; heading?: string; embed: boolean } | { kind: "md"; href: string } | { kind: "url"; href: string }

/** Where `inline()` records link targets while rendering; absent for outline titles. */
interface LinkSink {
  links: LinkTarget[]
  exists?: (target: string) => boolean
}

export interface RenderOpts {
  /** how headings are drawn (default "classic") */
  headings?: HeadingStyle
  /** whether a wikilink target resolves to a note; unresolved links are drawn muted */
  exists?: (target: string) => boolean
}

// biome-ignore lint/complexity/useMathMinMax: a NaN width must leave the running maximum alone, which Math.max would not
const maxOf = (xs: number[], init = 0) => xs.reduce((m, x) => (x > m ? x : m), init)

// ---------------------------------------------------------------- inline

/** HTML tags brothy strips (their text stays); anything else is shown literally, so `Promise<void>` survives. */
const HTML_TAGS = new Set([
  "div",
  "span",
  "p",
  "img",
  "br",
  "kbd",
  "sup",
  "sub",
  "u",
  "mark",
  "small",
  "b",
  "i",
  "em",
  "strong",
  "a",
  "center",
  "font",
  "details",
  "summary",
  "iframe",
  "video",
  "audio",
  "picture",
  "source",
  "figure",
  "figcaption",
  "hr",
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

/** One `inline()` call's state: `cur` is the style in force, which an inline `<kbd>` or `<mark>` switches until it closes. */
interface InlineRun {
  t: Theme
  base: Omit<Span, "text">
  cur: Omit<Span, "text">
  sink?: LinkSink
  out: Span[]
}

/** The style each nesting mark (`**`, `*`, `~~`, `==`) gives its children. */
const MARKS = new Map<string, (cur: Omit<Span, "text">, t: Theme) => Omit<Span, "text">>([
  ["strong", (cur) => ({ ...cur, attr: (cur.attr ?? 0) | A.BOLD })],
  ["em", (cur) => ({ ...cur, attr: (cur.attr ?? 0) | A.ITALIC })],
  ["del", (cur, t) => ({ ...cur, fg: t.textMuted, attr: (cur.attr ?? 0) | A.STRIKE })],
  ["highlight", (cur, t) => ({ ...cur, fg: t.warning, bg: t.backgroundElement })],
])

function inlineText(tok: Token, run: InlineRun) {
  const tt = tokenOf(tok, "text") // an escape is a text token without `tokens`
  if (tt.tokens?.length) run.out.push(...inline(tt.tokens, run.t, run.cur, run.sink))
  else run.out.push({ ...run.cur, text: decode(tt.text) })
}

function inlineCode(tok: Token, run: InlineRun) {
  const { t } = run
  run.out.push({ text: safe(tokenOf(tok, "codespan").text).replace(/ /g, "\u00a0"), fg: t.accent, bg: t.backgroundElement })
}

function inlineLink(tok: Token, run: InlineRun) {
  const l = tokenOf(tok, "link")
  const style: Omit<Span, "text"> = { ...run.cur, fg: run.t.info, attr: (run.cur.attr ?? 0) | A.UNDERLINE }
  if (run.sink) style.link = run.sink.links.push(/^[a-z][\w+.-]*:/i.test(l.href) ? { kind: "url", href: l.href } : { kind: "md", href: l.href }) - 1
  run.out.push(...inline(l.tokens, run.t, style, run.sink))
}

/** A wikilink: an embedded non-note file is a muted `▣ name`; a target the sink cannot resolve is muted. */
function inlineWikilink(tok: Token, run: InlineRun) {
  if (!isWikilink(tok)) return
  const { t, cur, sink } = run
  const w = tok
  if (w.embed && /\.[^/.]+$/.test(w.target) && !isMarkdown(w.target)) {
    run.out.push({ text: `▣ ${safe(w.target.split("/").at(-1)!)}`, fg: t.textMuted, attr: A.ITALIC })
    return
  }
  const ok = !w.target || !sink?.exists || sink.exists(w.target)
  const style: Omit<Span, "text"> = { ...cur, fg: ok ? t.info : t.textMuted, attr: (cur.attr ?? 0) | A.UNDERLINE }
  if (sink) {
    const l: LinkTarget = { kind: "wiki", target: w.target, embed: w.embed }
    if (w.heading) l.heading = w.heading
    style.link = sink.links.push(l) - 1
  }
  if (w.embed) run.out.push({ ...cur, text: "↳ ", fg: t.textMuted })
  run.out.push({ ...style, text: safe(wikiLabel(w)) })
}

function inlineImage(tok: Token, run: InlineRun) {
  run.out.push({ text: `▣\u00a0${safe(tokenOf(tok, "image").text) || "image"}`, fg: run.t.textMuted, attr: A.ITALIC })
}

function inlineBreak(_tok: Token, run: InlineRun) {
  run.out.push({ ...run.cur, text: "\n" })
}

/** One inline HTML tag: comments vanish, unknown tags show as muted text, `<kbd>`/`<mark>` switch the style until closed. */
function inlineHtml(tok: Token, run: InlineRun) {
  const { t, base } = run
  const raw = tokenOf(tok, "html").text
  if (/^\s*<!--/.test(raw)) return
  const m = /^\s*<(\/?)([a-zA-Z][\w-]*)\b[^>]*>\s*$/.exec(raw)
  const name = m?.[2]?.toLowerCase()
  if (!m || !name || !HTML_TAGS.has(name)) {
    run.out.push({ text: safe(raw), fg: t.textMuted })
    return
  }
  if (name === "br") run.out.push({ ...run.cur, text: "\n" })
  else if (name === "kbd") run.cur = m[1] ? base : { ...base, fg: t.accent, bg: t.backgroundElement }
  else if (name === "mark") run.cur = m[1] ? base : { ...base, fg: t.warning, bg: t.backgroundElement }
}

/** Any other token with text is drawn as that text in the current style. */
function inlineOther(tok: Token, run: InlineRun) {
  if ("text" in tok) run.out.push({ ...run.cur, text: decode(String(tok.text)) })
}

/** How `inline()` draws each token kind that is not a nesting mark. */
const INLINE_KINDS = new Map<string, (tok: Token, run: InlineRun) => void>([
  ["text", inlineText],
  ["escape", inlineText],
  ["codespan", inlineCode],
  ["link", inlineLink],
  ["wikilink", inlineWikilink],
  ["image", inlineImage],
  ["br", inlineBreak],
  ["html", inlineHtml],
])

/** Inline tokens as spans, styled from `base` down; with a `sink`, links are numbered into it (`Span.link`). */
export function inline(tokens: Token[] | undefined, t: Theme, base: Omit<Span, "text"> = { fg: t.text }, sink?: LinkSink): Span[] {
  const run: InlineRun = { t, base, cur: base, sink, out: [] }
  if (!tokens) return run.out
  for (const tok of tokens) {
    const mark = MARKS.get(tok.type)
    if (mark) run.out.push(...inline((tok as Tokens.Generic).tokens, t, mark(run.cur, t), sink))
    else (INLINE_KINDS.get(tok.type) ?? inlineOther)(tok, run)
  }
  return run.out
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

/** The text of a row of spans. */
export const plainOf = (spans: Span[]) => spans.map((s) => s.text).join("")

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
  summary: "abstract",
  tldr: "abstract",
  hint: "tip",
  important: "tip",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  caution: "warning",
  attention: "warning",
  fail: "failure",
  missing: "failure",
  error: "danger",
  cite: "quote",
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

/** `n` spaces, none when `n` is negative. */
export const pad = (n: number) => " ".repeat(Math.max(0, n))

/** What `blocks()` writes into: the rows, the outline, the code blocks still to highlight and the link targets. */
interface Ctx {
  t: Theme
  lines: Line[]
  headings: Heading[]
  pending: HighlightRequest[]
  sink: LinkSink
  headingStyle: HeadingStyle
}

/** The `bars` and `ladder` heading marks, h1 to h6. */
const BARS = ["█ ", "▌ ", "┃ ", "│ ", "┆ ", "┊ "]
const LADDER = ["██ ", "▓▓▓ ", "▒▒▒▒ ", "░░░░░ ", "░░░░░░ ", "░░░░░░░ "]
/** The `rules` leads of h1 to h3; deeper headings are bare text. */
const RULE_LEADS = ["━━ ", "── ", "╌╌ "]

/** Push wrapped rows; `extra` (a heading index) goes on the first one only. */
function emitRows(ctx: Ctx, rows: Span[][], extra: Partial<Line> = {}) {
  rows.forEach((spans, i) => ctx.lines.push(i === 0 ? { spans, ...extra } : { spans }))
}

/** The blank row in `rest` that ends most blocks. */
function spacer(ctx: Ctx, rest: Span[]) {
  ctx.lines.push({ spans: rest.map((s) => ({ ...s })) })
}

/** A blank row in `prefix` (quote bars, list indent) before a heading, unless the last row already is one. */
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

/**
 * A heading's rows in `ctx.headingStyle`, the first one tagged `heading: idx`. `styled` is the title in `fg`, the
 * depth's color; `p` prefixes the first row and `rest` the others. A mark before the title indents the wrapped rows
 * by its display width.
 */
function headingRows(ctx: Ctx, depth: number, styled: Span[], fg: string, idx: number, max: number, p: Span[], rest: Span[]) {
  const { t } = ctx
  const style = ctx.headingStyle
  const emit = (rows: Span[][]) => emitRows(ctx, rows, { heading: idx })
  const marked = (mark: Span, w = max) => wrap(styled, w, [...p, mark], [...rest, { text: pad(width(mark.text)) }])
  if (style === "bars" || style === "ladder") return emit(marked({ text: (style === "bars" ? BARS : LADDER)[depth - 1]!, fg }))
  if (style === "rules") {
    if (depth > 3) return emit(wrap(styled, max, p, rest))
    const lead = { text: RULE_LEADS[depth - 1]!, fg: [fg, t.border, t.textMuted][depth - 1]! }
    if (depth === 3) return emit(marked(lead))
    // h1 and h2 run a rule to the right edge: a rule row reserves " " and one fill cell, so the last row always has room for its fill
    const rows = marked(lead, max - 2)
    const last = rows[rows.length - 1]!
    last.push({ text: " " }, { text: (depth === 1 ? "━" : "─").repeat(Math.max(0, max - spanWidth(last) - 1)), fg: depth === 1 ? fg : t.border })
    return emit(rows)
  }
  // classic: h2 and deeper show their `#`s; an h1 is underlined across the measure, `━` under its text and `─` after
  if (depth > 1) return emit(marked({ text: "#".repeat(depth) + " ", fg: t.textMuted, attr: A.BOLD }))
  const rows = wrap(styled, max, p, rest)
  emit(rows)
  const tw = Math.max(0, Math.min(max - spanWidth(rest), maxOf(rows.map((r) => spanWidth(r) - spanWidth(rest)))))
  ctx.lines.push({
    spans: [...rest, { text: "━".repeat(tw), fg }, { text: "─".repeat(Math.max(0, max - spanWidth(rest) - tw)), fg: t.border }],
  })
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
  spacer(ctx, rest)
}

/** Where one `blocks()` call lays out: `max` columns, `pre()` the prefix of the next row (`first` once, then `rest`), the list depth. */
interface BlockFrame {
  max: number
  pre: () => Span[]
  rest: Span[]
  depth: number
}

/** A heading: recorded in the outline at its title row (after the blank row before it), then drawn by `headingRows`. */
function headingBlock(ctx: Ctx, tok: Token, f: BlockFrame) {
  const { t } = ctx
  const h = tokenOf(tok, "heading")
  const text = inline(h.tokens, t, undefined, ctx.sink)
  const colors = [t.primary, t.secondary, t.accent, t.text, t.text, t.textMuted]
  const fg = colors[h.depth - 1] ?? t.text
  const styled = text.map((s) => ({ ...s, fg: s.bg ? s.fg : fg, attr: (s.attr ?? 0) | A.BOLD }))
  const idx = ctx.headings.length
  ctx.headings.push({ depth: h.depth, text: plainOf(text).replace(/\u00a0/g, " "), line: ctx.lines.length })
  blank(ctx, f.rest)
  ctx.headings[idx]!.line = ctx.lines.length // after the blank row, so a jump lands on the title
  headingRows(ctx, h.depth, styled, fg, idx, f.max, f.pre(), f.rest)
  spacer(ctx, f.rest)
}

function paragraphBlock(ctx: Ctx, tok: Token, f: BlockFrame) {
  // a "text" block is a tight list item's body: no blank row after it
  const p = tokenOf(tok, "paragraph", "text")
  emitRows(ctx, wrap(inline(p.tokens, ctx.t, undefined, ctx.sink), f.max, f.pre(), f.rest))
  if (tok.type === "paragraph") spacer(ctx, f.rest)
}

/** A blockquote: a callout when it opens with `[!type]`, else its blocks under a primary bar, muted. */
function quoteBlock(ctx: Ctx, tok: Token, f: BlockFrame) {
  const q = tokenOf(tok, "blockquote")
  const c = calloutOf(q)
  if (c) return callout(ctx, c, f.max, f.pre(), f.rest, f.depth)
  const bar = { text: "▎ ", fg: ctx.t.primary }
  const start = ctx.lines.length
  blocks(ctx, q.tokens, f.max, [...f.pre(), bar], [...f.rest, bar], f.depth)
  muteQuote(ctx, start)
  trimTrailingBlank(ctx, start, [...f.rest, bar])
  spacer(ctx, f.rest)
}

/** A list item's task state; marked makes no task of an item that is only `[ ]` or `[x]`, which draws as an empty task (`bare`). */
function taskOf(item: Tokens.ListItem) {
  const bare = item.task ? null : /^\[([ xX])\]$/.exec(item.text.trim())
  return { bare: !!bare, task: item.task || !!bare, checked: item.task ? !!item.checked : !!bare && bare[1] !== " " }
}

/** The marker before a list item: its number (`num`, ordered lists only), its checkbox, else the depth's bullet. */
function listMarker(t: Theme, num: string | null, task: boolean, checked: boolean, depth: number): Span[] {
  const marker: Span[] = []
  if (num !== null) {
    marker.push({ text: num, fg: t.primary })
    if (task) marker.push({ text: " " })
  }
  if (task) {
    marker.push(checked ? { text: "[x]", fg: t.success, attr: A.BOLD } : { text: "[ ]", fg: t.textMuted })
  } else if (num === null) {
    marker.push({ text: ["•", "◦", "▪"][depth % 3]!, fg: t.primary })
  }
  return marker
}

/** One list item after its marker, the body indented by the marker's width; a checked task's text is muted. */
function listItem(ctx: Ctx, item: Tokens.ListItem, num: string | null, first: Span[], f: BlockFrame, loose: boolean) {
  const { t } = ctx
  const { bare, task, checked } = taskOf(item)
  const marker = listMarker(t, num, task, checked, f.depth)
  const mw = spanWidth(marker) + 1
  const itemFirst = [...first, ...marker, { text: " " }]
  const itemRest = [...f.rest, { text: pad(mw) }]
  const startLine = ctx.lines.length
  const body = item.tokens.filter((x) => !(task && x.type === "checkbox"))
  if (bare) ctx.lines.push({ spans: itemFirst.map((s) => ({ ...s })) })
  else blocks(ctx, body, f.max, itemFirst, itemRest, f.depth + 1)
  if (checked) {
    for (let k = startLine; k < ctx.lines.length; k++) for (const s of ctx.lines[k]!.spans) if (s.fg === t.text) s.fg = t.textMuted
  }
  if (!loose) trimTrailingBlank(ctx, startLine, f.rest)
}

/** A list: ordered numbers right-aligned to the widest one; a tight list drops the blank rows between items. */
function listBlock(ctx: Ctx, tok: Token, f: BlockFrame) {
  const l = tokenOf(tok, "list")
  const start = typeof l.start === "number" ? l.start : 1
  const numW = l.ordered ? String(start + l.items.length - 1).length + 1 : 1
  l.items.forEach((item, i) => {
    const num = l.ordered ? `${start + i}.`.padStart(numW) : null
    listItem(ctx, item, num, i === 0 ? f.pre() : f.rest, f, l.loose)
  })
  spacer(ctx, f.rest)
}

/** Fences Obsidian runs as queries: shown as one collapsed row; the query is read in Source. */
const DATAVIEW_LANGS = new Set(["dataview", "dataviewjs", "tasks"])

/** A query fence as one filled row: `⌁ lang · n lines`, and `s: source` at the right when it fits. */
function queryRow(ctx: Ctx, c: Tokens.Code, lang: string, f: BlockFrame) {
  const { t } = ctx
  const fill = t.backgroundElement
  const n = c.text === "" ? 0 : c.text.split("\n").length
  const label = `⌁ ${lang} · ${n} ${n === 1 ? "line" : "lines"}`
  const hint = "s: source"
  const p0 = f.pre()
  const avail = f.max - spanWidth(p0) - 2
  const gap = avail - width(label) - width(hint)
  const body: Span[] =
    gap >= 2
      ? [
          { text: label, fg: t.textMuted, bg: fill },
          { text: pad(gap), bg: fill },
          { text: hint, fg: t.textMuted, bg: fill },
        ]
      : truncate([{ text: label, fg: t.textMuted, bg: fill }], Math.max(1, avail))
  const row: Span[] = [...p0, { text: "  ", bg: fill }, ...body]
  row.push({ text: pad(f.max - spanWidth(row)), bg: fill })
  ctx.lines.push({ spans: row, fill })
  spacer(ctx, f.rest)
}

/** A filled block: a top row with the language at its right, the code (wrapped rows marked `↪`), a bottom row. */
function codeFence(ctx: Ctx, c: Tokens.Code, lang: string, f: BlockFrame) {
  const { t } = ctx
  const { max, rest } = f
  const p0 = f.pre()
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
  spacer(ctx, rest)
}

function codeBlock(ctx: Ctx, tok: Token, f: BlockFrame) {
  const c = tokenOf(tok, "code")
  const lang = (c.lang ?? "").split(/\s/)[0] ?? ""
  if (DATAVIEW_LANGS.has(lang.toLowerCase())) queryRow(ctx, c, lang, f)
  else codeFence(ctx, c, lang, f)
}

function ruleBlock(ctx: Ctx, _tok: Token, f: BlockFrame) {
  const p = f.pre()
  ctx.lines.push({ spans: [...p, { text: "─".repeat(Math.max(0, f.max - spanWidth(p))), fg: ctx.t.borderSubtle }] })
  spacer(ctx, f.rest)
}

/** Block HTML as muted text (`stripTags`), blank lines dropped; nothing at all when no text is left. */
function htmlBlock(ctx: Ctx, tok: Token, f: BlockFrame) {
  const txt = stripTags(tokenOf(tok, "html").text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
  if (!txt) return
  emitRows(ctx, wrap([{ text: decode(txt), fg: ctx.t.textMuted }], f.max, f.pre(), f.rest))
  spacer(ctx, f.rest)
}

/** Any other block shows its raw Markdown. */
function otherBlock(ctx: Ctx, tok: Token, f: BlockFrame) {
  const raw = (tok as { raw?: string }).raw?.trim()
  if (raw) emitRows(ctx, wrap([{ text: raw, fg: ctx.t.text }], f.max, f.pre(), f.rest))
}

const skipBlock = () => {}

/** How `blocks()` lays out each block kind; spaces and link definitions draw nothing. */
const BLOCK_KINDS = new Map<string, (ctx: Ctx, tok: Token, f: BlockFrame) => void>([
  ["space", skipBlock],
  ["heading", headingBlock],
  ["paragraph", paragraphBlock],
  ["text", paragraphBlock],
  ["blockquote", quoteBlock],
  ["list", listBlock],
  ["code", codeBlock],
  ["hr", ruleBlock],
  ["table", (ctx, tok, f) => table(ctx, tokenOf(tok, "table"), f.max, f.pre(), f.rest)],
  ["html", htmlBlock],
  ["def", skipBlock],
])

/**
 * Lay out block tokens into `ctx.lines`, `max` columns wide. `first` prefixes the first row this call emits and
 * `rest` every other one, so quotes, callouts and list items recurse with longer prefixes (a bar, an indent).
 * `depth` is the list nesting level, used to pick the bullet glyph. Most blocks end with a blank row in `rest`;
 * containers trim the last one (`trimTrailingBlank`) and `render` trims the document's ends.
 */
function blocks(ctx: Ctx, tokens: Token[], max: number, first: Span[], rest: Span[], depth = 0) {
  let usedFirst = false
  const pre = () => {
    if (usedFirst) return rest
    usedFirst = true
    return first
  }
  const frame: BlockFrame = { max, pre, rest, depth }
  for (const tok of tokens) (BLOCK_KINDS.get(tok.type) ?? otherBlock)(ctx, tok, frame)
}

/** Drop the blank rows (in `rest`) a container's last block left, keeping at least the row at `from`. */
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
  // a column within an equal share of what is left keeps its width; each one settled frees room, so repeat
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
  // the rest split what is left by natural width, at least 1 each; rounding is made up from the first column,
  // or taken back from the widest
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
        pushSpan(out, { ...s, text: "…" })
        return out
      }
      pushSpan(out, { ...s, text: g })
      w += gw
    }
  }
  return out
}

/** Columns narrower than this are cut to one line with "…" instead of wrapped. */
const MIN_WRAP_COL = 4

/**
 * A boxed table that never exceeds `max`: columns shrink (`fitWidths`), narrow ones truncate, and the columns that
 * cannot fit at all become one final `…` column. With no room even for that, the raw table is shown as text.
 */
function table(ctx: Ctx, tb: Tokens.Table, max: number, first: Span[], rest: Span[]) {
  const { t } = ctx
  const prefixW = Math.max(spanWidth(first), spanWidth(rest))
  // every column needs at least 1 cell plus 3 of border/padding, and the table 1 more border
  const fits = Math.floor((max - prefixW - 1) / 4)
  // columns that do not fit are replaced by one narrow "…" column; that needs room for one real column too
  const dropped = tb.header.length > fits
  if (fits < (dropped ? 2 : 1)) {
    emitRows(ctx, wrap([{ text: tb.raw.trim(), fg: t.textMuted }], max, first, rest))
    spacer(ctx, rest)
    return
  }
  const cols = dropped ? fits - 1 : tb.header.length
  const more: Span[][] = dropped ? [[{ text: "…", fg: t.textMuted }]] : []
  const header = tb.header
    .slice(0, cols)
    .map((c) => inline(c.tokens, t, undefined, ctx.sink).map((s) => ({ ...s, fg: s.bg ? s.fg : t.primary, attr: (s.attr ?? 0) | A.BOLD })))
  const rows = tb.rows.map((r) => r.slice(0, cols).map((c) => inline(c.tokens, t, undefined, ctx.sink)))
  // cell room: the measure less the prefix, a border per column plus one, 2 cells of padding per column, the `…` column
  const avail = max - prefixW - (cols + 1 + more.length) - (cols + more.length) * 2 - more.length
  const natural = Array.from({ length: cols }, (_, i) => Math.max(3, spanWidth(header[i] ?? []), maxOf(rows.map((r) => spanWidth(r[i] ?? [])))))
  const widths = [...fitWidths(natural, avail), ...more.map(() => 1)]
  const B = t.border
  const rule = (l: string, m: string, r: string, p: Span[]) => ({
    spans: [...p, { text: l + widths.map((w) => "─".repeat(w + 2)).join(m) + r, fg: B }],
  })
  // one table row: every cell wrapped (or truncated) to its width, as many rows as its tallest cell, aligned per column
  const row = (cells: Span[][], p: Span[]) => {
    const wrapped = widths.map((cw, i) => (cw < MIN_WRAP_COL ? [truncate(cells[i] ?? [], cw)] : wrap(cells[i] ?? [], cw)))
    const h = maxOf(
      wrapped.map((w) => w.length),
      1,
    )
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
  spacer(ctx, rest)
}

/** Narrowest measure `render` lays out for, however small the terminal. */
const MIN_MEASURE = 10

/** Lay out a Markdown document into styled, wrapped terminal lines. */
export function render(src: string, max: number, t: Theme, opts: RenderOpts = {}): Rendered {
  const tokens = lexBlocks(stripComments(normalize(src)))
  const ctx: Ctx = { t, lines: [], headings: [], pending: [], sink: { links: [], exists: opts.exists }, headingStyle: opts.headings ?? "classic" }
  blocks(ctx, tokens, Math.max(MIN_MEASURE, max), [], [])
  while (ctx.lines.length && plainOf(ctx.lines[ctx.lines.length - 1]!.spans).trim() === "" && ctx.lines[ctx.lines.length - 1]!.fill === undefined)
    ctx.lines.pop()
  while (ctx.lines.length && plainOf(ctx.lines[0]!.spans).trim() === "" && ctx.lines[0]!.heading === undefined && ctx.lines[0]!.fill === undefined) {
    ctx.lines.shift()
    ctx.headings.forEach((h) => h.line--)
  }
  return {
    lines: ctx.lines,
    headings: ctx.headings,
    plain: ctx.lines.map((l) =>
      plainOf(l.spans)
        .replace(/\u00a0/g, " ")
        .toLowerCase(),
    ),
    pending: ctx.pending,
    links: ctx.sink.links,
  }
}
