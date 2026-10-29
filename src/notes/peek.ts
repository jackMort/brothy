// The Ctrl-P peek pane, pure: what the highlighted row's note holds. The path and length, its
// outline as a tree (from the vault index), a fresh cached TL;DR, then its first rendered lines
// from where the row points. App renders the `peekWindow` of the note; nothing here reads a file or calls AI.

import { A, type Span } from "../lib/spans"
import { clamp, plural, truncate, truncateLeft, width, wrap } from "../lib/text"
import type { Rendered } from "../markdown/render"
import type { Theme } from "../theme/theme"
import { innerWidth, LIST_MAX_W, PEEK_MIN_W, paneWidth, popupWidth, splitWidth } from "../ui/geometry"
import { findQuote } from "../ui/nav"
import type { AnswerRow, NoteDoc, SwitchHit, SwitchRow } from "./vault"

/** outline rows shown around the hit's heading */
const PEEK_OUTLINE = 5
/** TL;DR rows, the last cut with `…` */
export const PEEK_TLDR = 3
/** source the pane renders from where it starts, cut at a line: far more than its rows ever show */
export const PEEK_BYTES = 32 * 1024
/** lines kept past a text hit, so a hit deep in a long section still shows */
const PEEK_AFTER = 64
/** characters of a text hit's line used to find it again in the rendered rows */
const NEEDLE_CHARS = 40
/** the path needs this many cells before the word count and minutes sit on its row */
const MIN_PATH_W = 12

/**
 * Switcher geometry. From PEEK_MIN_W the popup is `min(W − 12, 116)` wide and splits: the list
 * (`listW`, PickerList's inner width), a `│` divider, and the pane, padded 2 left and 4 right
 * around its `peekW` text columns. Below that it is today's 70-wide list.
 */
export function switchSplit(W: number): { split: boolean; width: number; listW: number; peekW: number } {
  if (W < PEEK_MIN_W) {
    const popupW = popupWidth(W)
    return { split: false, width: popupW, listW: innerWidth(popupW), peekW: 0 }
  }
  const popupW = splitWidth(W)
  const inner = innerWidth(popupW)
  const listW = Math.min(LIST_MAX_W, Math.round(inner * 0.55))
  return { split: true, width: popupW, listW, peekW: paneWidth(inner, listW) }
}

export interface PeekInput {
  row: SwitchRow | undefined
  /** the note's path relative to the link tree */
  rel: string
  /** the vault index entry; undefined while indexing */
  doc: NoteDoc | undefined
  /** the note's `peekWindow` rendered at the pane width (Preview: outline parity with `doc.headings` from `base`) */
  view: Rendered | undefined
  /** the outline index of `view.headings[0]` (`peekWindow().base`); 0 for the whole body */
  base?: number
  words?: number
  minutes?: number
  /** a TL;DR from the cache, only while fresh */
  summary: { text: string; model: string } | undefined
}

const RULE = /^[\s─━]*$/
const rowText = (r: Span[]) => r.map((s) => s.text).join("")

/** The outline index the row points into, or null (note hits, lead-in hits). */
function sectionOf(r: SwitchRow): number | null {
  if (r.kind === "heading") return r.heading
  if (r.kind === "text" || r.kind === "answer") return r.heading !== null && r.heading >= 0 ? r.heading : null
  return null
}

/** Tree rows for `heads` (depths), `├ │ └` like the Files tree, relative to the shallowest. */
function treePrefixes(depths: number[]): string[] {
  const lastAt = (i: number) => {
    for (let j = i + 1; j < depths.length; j++) {
      if (depths[j]! < depths[i]!) return true
      if (depths[j] === depths[i]) return false
    }
    return true
  }
  const base = Math.min(...depths)
  return depths.map((d, i) => {
    let pre = ""
    for (let lv = base; lv < d; lv++) {
      let k = i - 1
      while (k >= 0 && depths[k]! > lv) k--
      pre += k >= 0 && depths[k] === lv && !lastAt(k) ? "│ " : "  "
    }
    return pre + (lastAt(i) ? "└ " : "├ ")
  })
}

/** The title: the note's one H1 (outline index 0), else null (the name stands in). */
const titleOf = (doc: NoteDoc): 0 | null =>
  doc.headings[0]?.depth === 1 && doc.headings.filter((x) => x.depth === 1).length === 1 ? 0 : null

/** The outline index the pane starts at: the row's section, a note's title, else null (the top). */
const startOf = (r: SwitchRow, doc: NoteDoc) => sectionOf(r) ?? (r.kind === "note" ? titleOf(doc) : null)

/**
 * The source lines `[from, to)` the pane renders, so a big note costs a slice, not the whole note:
 * from the row's heading (`base` is its outline index; the body's top and 0 without one), about
 * PEEK_BYTES cut at a line, through a text hit's line. `lines` are the normalized source lines
 * (`sourceScan`'s numbering), `fm` the front matter's line count.
 */
export function peekWindow(
  lines: readonly string[],
  fm: number,
  doc: NoteDoc,
  r: SwitchRow,
): { from: number; to: number; base: number } {
  const sec = startOf(r, doc)
  const head = sec === null ? undefined : doc.headings[sec]
  const from = head ? head.line : fm
  let to = from
  for (let size = 0; to < lines.length && size <= PEEK_BYTES; to++) size += lines[to]!.length + 1
  if (r.kind === "text") to = Math.max(to, Math.min(lines.length, r.line + 1 + PEEK_AFTER))
  return { from, to, base: head ? sec! : 0 }
}

/** The first body row: after the row's heading (and its underline), at a text hit's line, else the top. */
function anchorRow(r: SwitchRow, doc: NoteDoc, view: Rendered, base: number): number {
  const heads = view.headings
  const sec = startOf(r, doc)
  if (sec === null) return 0
  const k = sec - base
  const from = (heads[k]?.line ?? -1) + 1
  if (r.kind !== "text") return from
  const end = heads[k + 1]?.line ?? view.lines.length
  const needle = doc.text
    .slice(doc.starts[r.line] ?? 0, (doc.starts[r.line + 1] ?? doc.text.length + 1) - 1)
    .trim()
    .slice(0, NEEDLE_CHARS)
  return findQuote(view.plain, from, end, needle) ?? from
}

const muted = (text: string, t: Theme): Span => ({ text, fg: t.textMuted })

/** The path, with the word count and minutes at its right while the path keeps MIN_PATH_W cells. */
function pathRow(p: PeekInput, t: Theme, w: number): Span[] {
  const right = p.words !== undefined && p.minutes !== undefined ? `${plural(p.words, "word")} · ${p.minutes} min` : ""
  const fits = right && w - width(right) - 1 >= MIN_PATH_W
  const path = truncateLeft(p.rel, fits ? w - width(right) - 1 : w)
  return fits
    ? [muted(path, t), { text: " ".repeat(w - width(path) - width(right)) }, muted(right, t)]
    : [muted(path, t)]
}

/** The title (the note's one H1, else its name), then the other headings (depth ≤ 3) as a tree around the row's section. */
function outlineRows(doc: NoteDoc, r: SwitchHit | AnswerRow, t: Theme, w: number): Span[][] {
  const hs = doc.headings
  const title = titleOf(doc)
  const cur = sectionOf(r)
  const out: Span[][] = [
    [
      {
        text: truncate(title === null ? r.name : hs[0]!.text, w),
        fg: title !== null && cur === 0 ? t.primary : t.text,
        attr: A.BOLD,
      },
    ],
  ]
  const kids = hs.map((x, i) => ({ ...x, i })).filter((x) => x.i !== title && x.depth <= 3)
  if (!kids.length) return out
  const pre = treePrefixes(kids.map((x) => x.depth))
  const at = Math.max(
    0,
    kids.findIndex((x) => x.i === cur),
  )
  const from = clamp(at - Math.floor(PEEK_OUTLINE / 2), 0, kids.length - PEEK_OUTLINE)
  const to = Math.min(kids.length, from + PEEK_OUTLINE)
  if (from > 0) out.push([{ text: "   " }, muted("…", t)])
  for (let k = from; k < to; k++) {
    const x = kids[k]!
    const on = x.i === cur
    out.push([
      { text: " " + pre[k]!, fg: t.borderSubtle },
      {
        text: truncate(x.text, Math.max(1, w - 1 - width(pre[k]!))),
        fg: on ? t.primary : t.textMuted,
        ...(on ? { attr: A.BOLD } : {}),
      },
    ])
  }
  if (to < kids.length) out.push([{ text: "   " }, muted("…", t)])
  return out
}

/** A TL;DR as Info draws it, after a blank row: the label and model, then PEEK_TLDR rows, the last cut with `…`. */
function tldrRows(summary: { text: string; model: string }, t: Theme, w: number): Span[][] {
  const out: Span[][] = [[], [{ text: "TL;DR", fg: t.textMuted, attr: A.BOLD }, muted(" · " + summary.model, t)]]
  const rows = wrap([{ text: summary.text }], w).map((x) => rowText(x).trimEnd())
  const shown = rows.slice(0, PEEK_TLDR)
  if (rows.length > PEEK_TLDR) shown[PEEK_TLDR - 1] = truncate(shown[PEEK_TLDR - 1]! + " " + rows[PEEK_TLDR]!, w)
  for (const s of shown) out.push([{ text: s, fg: t.text }])
  return out
}

/** At most `room` rendered rows from row `i` on: leading rules skipped, blank runs collapsed to one, filled rows padded to `w`. */
function bodyRows(view: Rendered, i: number, w: number, room: number): Span[][] {
  const out: Span[][] = []
  while (i < view.lines.length && !view.lines[i]!.fill && RULE.test(view.plain[i]!)) i++
  for (let prevBlank = false; i < view.lines.length && out.length < room; i++) {
    const l = view.lines[i]!
    const blank = !l.fill && !view.plain[i]!.trim()
    if (blank && prevBlank) continue
    prevBlank = blank
    const spans = l.fill
      ? [
          ...l.spans.map((s) => ({ ...s, bg: s.bg ?? l.fill })),
          { text: " ".repeat(Math.max(0, w - width(rowText(l.spans)))), bg: l.fill },
        ]
      : l.spans
    out.push(spans)
  }
  return out
}

/** The pane's rows, `w` wide and at most `h` tall: path and length, outline, TL;DR, then the note from where the row points. */
export function peekLines(p: PeekInput, t: Theme, w: number, h: number): Span[][] {
  const r = p.row
  if (!r || (r.kind !== "note" && r.kind !== "heading" && r.kind !== "text" && r.kind !== "answer")) return []
  const out: Span[][] = [pathRow(p, t, w), []]
  const doc = p.doc
  if (!doc)
    return [...out, [{ text: truncate(r.name, w), fg: t.text, attr: A.BOLD }], [], [muted("indexing…", t)]].slice(0, h)
  out.push(...outlineRows(doc, r, t, w))
  if (p.summary) out.push(...tldrRows(p.summary, t, w))
  const view = p.view
  if (!view) return out.slice(0, h)
  out.push([], [{ text: "─".repeat(w), fg: t.border }])
  out.push(...bodyRows(view, anchorRow(r, doc, view, p.base ?? 0), w, h - out.length))
  return out.slice(0, h)
}
