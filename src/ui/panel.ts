// Panel views (Files, Outline, Info): pure row data and the spans each row is drawn with; Files rows come from files.ts.

import { dirname, resolve, sep } from "node:path"
import { type Change, changeCounts, type DeltaNote } from "../ai/delta"
import { A, type Span, safeLine } from "../lib/spans"
import { plural, spanWidth, superscript, truncate, truncateLeft, width, wrap } from "../lib/text"
import type { Property } from "../markdown/frontmatter"
import type { LinkTarget } from "../markdown/render"
import { headingKey } from "../markdown/sections"
import { type Stats, stripCode } from "../markdown/stats"
import { type FileNode, folderOf, fuzzyHits, isMarkdown, stem } from "../notes/files"
import { mix, type Theme } from "../theme/theme"
import {
  CARET,
  footInk,
  footnoteRule,
  MODEL_W,
  noteRows,
  type Stale,
  staleTail,
  type Tail,
  waitingRow,
  waitText,
} from "./footnote"
import { hitSpans } from "./rows"

// ------------------------------------------------------------- formatting

/** `812 B`, `1.5 KB`, `2.0 MB`. */
export function fmtSize(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/** `just now`, `5 min ago`, `3 hours ago`, `2 days ago`, else the date. */
export function fmtAge(d: Date, now = Date.now()) {
  const s = (now - d.getTime()) / 1000
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${plural(Math.floor(s / 3600), "hour")} ago`
  if (s < 86400 * 30) return `${plural(Math.floor(s / 86400), "day")} ago`
  return d.toLocaleDateString()
}

// ------------------------------------------------------------- outline

export interface OutlineRow {
  /** index into the headings */
  index: number
  text: string
  /** columns: 2 per level below the shallowest heading */
  indent: number
  /** 0 = shallowest depth, 1 = one below, 2 = deeper */
  level: 0 | 1 | 2
  /** above the reading heading */
  read: boolean
  /** the reading heading */
  current: boolean
  /** matched code points (filter) */
  hits: number[]
}

/** One row per heading, or per matching heading (document order) when `filter` is set. */
export function outlineRows(headings: { depth: number; text: string }[], current: number, filter = ""): OutlineRow[] {
  const min = Math.min(...headings.map((h) => h.depth))
  const q = filter.trim()
  const out: OutlineRow[] = []
  headings.forEach((h, index) => {
    const hits = q ? fuzzyHits(h.text, q) : []
    if (!hits) return
    const d = h.depth - min
    let level: 0 | 1 | 2 = 2
    if (d === 0) level = 0
    else if (d === 1) level = 1
    out.push({
      index,
      text: h.text,
      indent: 2 * d,
      level,
      read: index < current,
      current: index === current,
      hits,
    })
  })
  return out
}

// ------------------------------------------------------------- info

/** One screen row of the Info view. */
export type InfoItem =
  | { kind: "prop"; key: string; keyW: number; text: string }
  | { kind: "chips"; key: string; keyW: number; tags: string[]; more?: boolean }
  | { kind: "label"; text: string }
  | { kind: "link"; target: string; path: string | null }
  | { kind: "more"; n: number }
  | { kind: "stat"; text: string }
  | { kind: "blank" }
  | { kind: "foot"; mark: string | null; markStale: boolean; text: string; tone: FootTone; hang?: number }
  | { kind: "frule"; tail: Tail | null; stop: boolean }
  | { kind: "changes"; since: string; model: string | null; right: Tail | null }
  | {
      kind: "change"
      n: number
      text: string
      counts: string
      at: number
      stop: boolean
      removed: boolean
      tone: ChangeTone
    }
  | { kind: "wait"; model: string; secs: number }
  | { kind: "earlier"; since: string; model: string }
  | { kind: "cmore"; n: number; open: boolean }

export interface LinkRef {
  target: string
  /** absolute path of the resolved note; null when unresolved */
  path: string | null
}
export interface FileMeta {
  size: number
  mtime: Date
}

const MAX_PROP_ROWS = 4
/** Widest key column of the properties (the keys are cut to it), and the fewest columns a value gets. */
const PROP_KEY_MAX = 8
const PROP_ROOM_MIN = 4
const MAX_LINKS = 8
const TAG_KEYS = new Set(["tags", "tag"])
const ORDER = ["title", "aliases", "tags", "date", "created", "modified"]

/** Rows for one property: the key on the first row, values wrapped under the value column, 4 rows at most. */
export function wrapProperty(key: string, value: string | string[], cols: number, keyW: number): InfoItem[] {
  const room = Math.max(PROP_ROOM_MIN, cols - keyW)
  const k = truncate(key, keyW - 1)
  let rows: InfoItem[]
  if (TAG_KEYS.has(key.toLowerCase())) {
    const tags = (Array.isArray(value) ? value : value.split(/[\s,]+/)).map((x) => x.replace(/^#/, "")).filter(Boolean)
    const lines: string[][] = []
    let w = 0
    for (const tg of tags) {
      const cw = Math.min(room, width(tg) + 1) // "#tag"
      if (lines.length && w + 1 + cw <= room) {
        lines[lines.length - 1]!.push(tg)
        w += 1 + cw
      } else {
        lines.push([tg])
        w = cw
      }
    }
    rows = lines.map((tg, i): InfoItem => ({ kind: "chips", key: i ? "" : k, keyW, tags: tg }))
  } else {
    const text = Array.isArray(value) ? value.join(" · ") : value
    rows = wrap([{ text }], room).map(
      (r, i): InfoItem => ({ kind: "prop", key: i ? "" : k, keyW, text: r.map((s) => s.text).join("") }),
    )
  }
  if (!rows.length) rows = [{ kind: "prop", key: k, keyW, text: "" }]
  if (rows.length > MAX_PROP_ROWS) {
    rows = rows.slice(0, MAX_PROP_ROWS)
    const last = rows[MAX_PROP_ROWS - 1]!
    if (last.kind === "prop") last.text = truncate(`${last.text} …`, room)
    else if (last.kind === "chips") last.more = true
  }
  return rows
}

/** TL;DR text rows shown collapsed; past them the block is a cursor stop that `⏎` expands. */
export const SUMMARY_ROWS = 14
/** Rows an error in the TL;DR block takes at most. */
const ERROR_ROWS = 3
/** Info widths from which the waiting tail also says `a cancel` (the footer always does). */
const CANCEL_TAIL_W = 44
/** `* `: the mark and its space; continuation rows hang by the same. */
const HANG = 2
/** How a `foot` row is drawn: the text role, muted (a change's note), dimmed (outdated, regenerating, Earlier), an error, the caret, the `a` hint. */
type FootTone = "text" | "muted" | "stale" | "error" | "caret" | "hint"
export type SummaryState = "none" | "waiting" | "streaming" | "fresh" | "outdated"
/** What the Info tab shows for the note's TL;DR. */
export interface SummaryView {
  /** the cached summary, or the text streamed so far */
  text: string
  state: SummaryState
  /** the display name: the entry's model, or the running job's */
  model: string
  /** waiting: whole seconds since the request went out */
  secs: number
  /** outdated: why */
  stale: Stale | null
  /** waiting over a cached summary (regenerating): its text, dimmed under the caret */
  old: string
  /** the last request failed (memory only), with this message */
  error: string | null
  /** expanded past SUMMARY_ROWS */
  open: boolean
}

/** `rows` as `foot` items: the first behind the mark, the rest hung under it (`hang` columns without a mark). */
const footRows = (
  rows: string[],
  tone: FootTone,
  markStale: boolean,
  mark: string | null = "*",
  hang = HANG,
): InfoItem[] =>
  rows.map((text, i) => ({
    kind: "foot",
    mark: i ? null : mark,
    markStale,
    text,
    tone,
    ...(hang === HANG ? {} : { hang }),
  }))

/** The rule's tail per state: waiting, streaming, the signature (`⏎ more` on overflow), outdated, error. */
function tldrTail(sv: SummaryView, cols: number, overflow: boolean): Tail | null {
  const model = truncate(safeLine(sv.model), MODEL_W)
  if (sv.error) return { key: "a", word: "retry" }
  if (sv.state === "waiting")
    return {
      status: waitText(sv.model, sv.secs),
      model,
      ...(cols >= CANCEL_TAIL_W ? { key: "a", word: "cancel" } : {}),
    }
  if (sv.state === "streaming") return { status: model, model, key: "a", word: "cancel" }
  if (sv.stale) return staleTail(sv.stale, "a")
  if (overflow) return { key: "⏎", word: sv.open ? "less" : "more", status: model, model, keyFirst: true }
  return { status: `TL;DR · ${model}`, model }
}

/** The text's rows at `tw` columns: all of them when open, else SUMMARY_ROWS with the last cut `…`; and whether it overflows. */
function textRows(text: string, tw: number, open: boolean) {
  const all = noteRows(text, tw, null, Number.POSITIVE_INFINITY)
  const overflow = all.length > SUMMARY_ROWS
  return { rows: open || !overflow ? all : noteRows(text, tw, null, SUMMARY_ROWS, { cut: "…" }), overflow }
}

/**
 * The TL;DR block (`FAMILY.md`, footnote look): `*` and the text with a hanging indent, then a closing rule with its tail
 * (the rule faces the page below it). Waiting reserves the caret row, regenerating keeps the old text dimmed under it,
 * an error stays above the old text; past SUMMARY_ROWS the rule is a cursor stop. `cols`: Info's text columns.
 */
export function tldrItems(sv: SummaryView, cols: number): InfoItem[] {
  const tw = cols - HANG
  if (sv.state === "none" && !sv.error) return footRows(["a summarize this note"], "hint", true)
  const out: InfoItem[] = []
  let overflow = false
  if (sv.error) {
    const rows = noteRows(sv.error, tw - HANG, null, ERROR_ROWS, { cut: "…" })
    out.push(
      ...footRows(
        rows.map((r, i) => (i ? "  " : "✗ ") + r),
        "error",
        true,
      ),
    )
    out.push(...footRows(textRows(sv.text, tw, false).rows, "stale", true, null))
  } else if (sv.state === "waiting") {
    out.push(...footRows([CARET], "caret", !!sv.old))
    out.push(...footRows(textRows(sv.old, tw, false).rows, "stale", true, null))
  } else if (sv.state === "streaming") {
    out.push(...footRows(textRows(sv.text + CARET, tw, false).rows, "text", false))
  } else {
    const r = textRows(sv.text, tw, sv.open)
    overflow = r.overflow
    out.push(...footRows(r.rows, sv.stale ? "stale" : "text", !!sv.stale))
  }
  return [...out, { kind: "frule", tail: tldrTail(sv, cols, overflow), stop: overflow }]
}

/** The `*` after the title in the running head: fresh, over an outdated (or regenerating, or failed) summary, or none. */
export function tldrHead(sv: SummaryView | null): "fresh" | "stale" | null {
  if (!sv || sv.state === "none" || sv.state === "streaming") return null
  if (sv.state === "waiting") return sv.old ? "stale" : null
  return sv.state === "fresh" && !sv.error ? "fresh" : "stale"
}

/** `a`'s footer word for the block: what the key does now. */
export function tldrWord(sv: SummaryView): string {
  if (sv.state === "waiting" || sv.state === "streaming") return "cancel"
  if (sv.error) return "retry"
  return sv.state === "outdated" ? "refresh" : "summarize"
}

/** Change rows listed at most; past them a `+ n more sections` stop opens the rest, up to MAX_CHANGE_ROWS_OPEN. */
export const MAX_CHANGE_ROWS = 8
export const MAX_CHANGE_ROWS_OPEN = 60
/** Rows of the explanation's summary and of each change's note (Earlier keeps fewer of each). */
const CHANGE_SUMMARY_ROWS = 5
const CHANGE_NOTE_ROWS = 2
const EARLIER_SUMMARY_ROWS = 2
const EARLIER_NOTE_ROWS = 1
/** Rows the error and the too-large notice take at most. */
const CHANGE_MSG_ROWS = 2
const LARGE = "too many lines changed to compare; nothing to explain"
export type ChangeState = "idle" | "loading" | "result" | "error" | "large"
/** A finished explanation: since when its changes were listed (HH:MM), the model's display name, the reply and its changes. */
interface EarlierView {
  since: string
  model: string
  summary: string
  notes: readonly (DeltaNote | undefined)[]
  changes: readonly Change[]
}
/** What Info shows for a live reload (`SPEC-delta.md` §3). */
export interface ChangeView {
  state: ChangeState
  /** the baseline's HH:MM (the explained list's, once explained) */
  since: string
  /** the display name: the running job's, or the explanation's */
  model: string
  /** loading: whole seconds since the request went out */
  secs: number
  /** null: too large to compare */
  changes: readonly Change[] | null
  summary: string
  notes: readonly (DeltaNote | undefined)[]
  /** the last request failed, with this message */
  error: string | null
  /** every change listed, past MAX_CHANGE_ROWS */
  open: boolean
  /** an `ai` block is set: the label offers `D` */
  ai: boolean
  /** the last explanation, kept dimmed once the note changed again */
  earlier: EarlierView | null
}
/** How a change row is drawn: listed, explained (its number muted), or under Earlier (all dimmed, not a stop). */
type ChangeTone = "fresh" | "explained" | "earlier"

/** `D` at the label's right end and in the footer: what it does now; nothing with AI off, once explained or too large. */
export function changeKey(cv: ChangeView | null): Tail | null {
  if (!cv) return null
  if (cv.state === "loading") return { key: "D", word: "cancel" }
  if (!cv.ai) return null
  if (cv.state === "idle") return { key: "D", word: "explain" }
  return cv.state === "error" ? { key: "D", word: "retry" } : null
}

/** One change's row: its number, the section's name (the note's title for the lead-in), `+a −r` or `new`. */
function changeRow(c: Change, at: number, n: number, title: string, cols: number, tone: ChangeTone): InfoItem {
  const counts = c.status === "added" ? "new" : changeCounts(c)
  const room = Math.max(1, cols - width(superscript(n)) - 1 - (counts ? width(counts) + 1 : 0))
  const text = truncate(safeLine(c.index < 0 || !c.path.length ? title : c.path.at(-1)!), room)
  const removed = c.status === "removed"
  return { kind: "change", n, text, counts, at, stop: tone !== "earlier" && !removed, removed, tone }
}

/** Rows per change, the first `max`: its row, then its note hung under the name (`noteMax` rows; 0: none). */
function changeList(
  changes: readonly Change[],
  notes: readonly (DeltaNote | undefined)[],
  o: { title: string; cols: number; tone: ChangeTone; first: number; max: number; noteMax: number },
): InfoItem[] {
  return changes.slice(0, o.max).flatMap((c, at) => {
    const n = o.first + at
    const hang = width(superscript(n)) + 1
    const what = o.noteMax ? notes[at]?.what : undefined
    const rows = what ? noteRows(what, o.cols - hang, null, o.noteMax, { cut: "…" }) : []
    return [
      changeRow(c, at, n, o.title, o.cols, o.tone),
      ...footRows(rows, o.tone === "earlier" ? "stale" : "muted", false, null, hang),
    ]
  })
}

/** Under the label: the waiting row, the summary streaming or done, or the error. */
function explanationRows(cv: ChangeView, cols: number): InfoItem[] {
  if (cv.state === "error" && cv.error) {
    const rows = noteRows(cv.error, cols - 2, null, CHANGE_MSG_ROWS, { cut: "…" })
    return footRows(
      rows.map((r, i) => (i ? "  " : "✗ ") + r),
      "error",
      false,
      null,
      0,
    )
  }
  if (cv.state !== "loading" && cv.state !== "result") return []
  if (cv.state === "loading" && !cv.summary && !cv.notes.some(Boolean))
    return [{ kind: "wait", model: cv.model, secs: cv.secs }]
  const text = cv.state === "loading" ? cv.summary + CARET : cv.summary
  return footRows(noteRows(text, cols, null, CHANGE_SUMMARY_ROWS, { cut: "…" }), "text", false, null, 0)
}

/** The last explanation under the current rows, dimmed: its label, summary, and rows numbered on from `first`. */
function earlierItems(e: EarlierView, first: number, title: string, cols: number): InfoItem[] {
  return [
    { kind: "earlier", since: e.since, model: e.model },
    ...footRows(noteRows(e.summary, cols, null, EARLIER_SUMMARY_ROWS, { cut: "…" }), "stale", false, null, 0),
    ...changeList(e.changes, e.notes, {
      title,
      cols,
      tone: "earlier",
      first,
      max: MAX_CHANGE_ROWS,
      noteMax: EARLIER_NOTE_ROWS,
    }),
  ]
}

/** Too large to compare: why, in place of the rows. */
const largeRows = (cols: number) => footRows(noteRows(LARGE, cols, null, CHANGE_MSG_ROWS), "muted", false, null, 0)

/** The current list: the explanation's rows, a row per change (notes once explained), `+ n more` past MAX_CHANGE_ROWS. */
function currentRows(cv: ChangeView, changes: readonly Change[], title: string, cols: number): InfoItem[] {
  const explained = cv.state === "loading" || cv.state === "result"
  const out = [
    ...explanationRows(cv, cols),
    ...changeList(changes, cv.notes, {
      title,
      cols,
      tone: cv.state === "result" ? "explained" : "fresh",
      first: 1,
      max: cv.open ? MAX_CHANGE_ROWS_OPEN : MAX_CHANGE_ROWS,
      noteMax: explained ? CHANGE_NOTE_ROWS : 0,
    }),
  ]
  if (changes.length > MAX_CHANGE_ROWS) out.push({ kind: "cmore", n: changes.length - MAX_CHANGE_ROWS, open: cv.open })
  return out
}

/**
 * The `Changed` block (`SPEC-delta.md` §3): the label with `D`'s word at its right end; the waiting row, the summary or
 * the error; a numbered row per change with its note once explained, `+ n more` past MAX_CHANGE_ROWS; then Earlier.
 */
export function changeItems(cv: ChangeView, title: string, cols: number): InfoItem[] {
  const label: InfoItem = {
    kind: "changes",
    since: cv.since,
    model: cv.state === "result" ? cv.model : null,
    right: changeKey(cv),
  }
  const out = [label, ...(cv.changes ? currentRows(cv, cv.changes, title, cols) : largeRows(cols))]
  const first = (cv.changes?.length ?? 0) + 1
  if (cv.earlier && cv.state !== "result") out.push(...earlierItems(cv.earlier, first, title, cols))
  return out
}

/** The Info view, top to bottom: the TL;DR block (AI on), the Changed block (after a reload), properties, links, then three stat lines. */
export function infoItems(
  props: Property[],
  st: Stats,
  links: LinkRef[],
  cols: number,
  file: FileMeta | null,
  now = Date.now(),
  summary?: SummaryView,
  changes?: { view: ChangeView; title: string },
): InfoItem[] {
  const out: InfoItem[] = summary ? [...tldrItems(summary, cols), { kind: "blank" }] : []
  if (changes) out.push(...changeItems(changes.view, changes.title, cols), { kind: "blank" })
  const rank = (k: string) => {
    const i = ORDER.indexOf(k.toLowerCase())
    return i < 0 ? ORDER.length : i
  }
  const sorted = props
    .map((p, i) => [p, i] as const)
    .sort((a, b) => rank(a[0][0]) - rank(b[0][0]) || a[1] - b[1])
    .map(([p]) => p)
  if (sorted.length) {
    const keyW = Math.min(PROP_KEY_MAX, Math.max(...sorted.map(([k]) => width(k)))) + 1
    for (const [k, v] of sorted) out.push(...wrapProperty(k, v, cols, keyW))
    out.push({ kind: "blank" })
  }
  if (links.length) {
    out.push({ kind: "label", text: "Links" })
    for (const l of links.slice(0, MAX_LINKS)) out.push({ kind: "link", target: l.target, path: l.path })
    if (links.length > MAX_LINKS) out.push({ kind: "more", n: links.length - MAX_LINKS })
    out.push({ kind: "blank" })
  }
  out.push({ kind: "stat", text: `${plural(st.words, "word")} · ${st.minutes} min read` })
  const counts = [
    st.headings ? plural(st.headings, "heading") : "",
    st.tasks[1] ? `${st.tasks[0]}/${st.tasks[1]} tasks` : "",
    st.tables ? plural(st.tables, "table") : "",
  ].filter(Boolean)
  if (counts.length) out.push({ kind: "stat", text: counts.join(" · ") })
  if (file) out.push({ kind: "stat", text: `${fmtSize(file.size)} · edited ${fmtAge(file.mtime, now)}` })
  return out
}

// ------------------------------------------------------------- spans

/** Fewest columns left of a ranked note's name for its folder to show. */
const FOLDER_MIN = 6

/** Files row `r` in `t`, `cols` text columns wide: a folder with its arrow (and its note count while closed), a ranked hit with its folder, or a note; `open` is marked `●`. */
export function fileRowSpans(
  r: { node: FileNode; depth: number; hits?: number[] },
  o: {
    t: Theme
    cols: number
    open: string | null
    expanded: ReadonlySet<string>
    counts: Map<string, number>
    maxDepth: number
  },
): Span[] {
  const { t, cols } = o
  const n = r.node
  const indent = "  ".repeat(Math.min(r.depth, o.maxDepth))
  // a symlink that leaves the folder is marked after its name
  const mark: Span[] = n.outside ? [{ text: " ↗", fg: t.textMuted }] : []
  const room = cols - width(indent) - 2 - spanWidth(mark)
  const isOpen = n.path === o.open
  if (n.dir) {
    const open = o.expanded.has(n.path)
    const spans: Span[] = [{ text: indent }, { text: open ? "▾ " : "▸ ", fg: t.borderSubtle }]
    // a closed folder shows its note count at the right edge; the count goes before the name is cut
    const count = open ? "" : String(o.counts.get(n.path) ?? 0)
    const name = truncate(n.name, room)
    spans.push({ text: name, fg: t.textMuted }, ...mark)
    if (count && width(n.name) + 1 + width(count) <= room)
      spans.push({ text: " ".repeat(room - width(name) - width(count)) }, { text: count, fg: t.textMuted })
    return spans
  }
  if (r.hits) {
    const shown = truncate(stem(n.name), cols - 2 - spanWidth(mark))
    const left = cols - 2 - width(shown) - spanWidth(mark) - 1
    // a note's name is never cut for its folder; the folder shows only with FOLDER_MIN columns to spare
    const seg = folderOf(n)
    const folder = seg && left >= FOLDER_MIN ? truncateLeft(seg, left) : ""
    const spans: Span[] = [
      { text: isOpen ? "● " : "  ", fg: t.primary },
      ...hitSpans(shown, r.hits, isOpen ? t.primary : t.text, t.primary, isOpen),
      ...mark,
    ]
    if (folder)
      spans.push(
        { text: " ".repeat(cols - 2 - width(shown) - spanWidth(mark) - width(folder)) },
        { text: folder, fg: t.textMuted },
      )
    return spans
  }
  return [
    { text: indent },
    { text: isOpen ? "● " : "  ", fg: t.primary },
    { text: truncate(stem(n.name), room), fg: isOpen ? t.primary : t.text, attr: isOpen ? A.BOLD : A.NONE },
    ...mark,
  ]
}

/** How far toward the background the headings above the reading one fade. */
const READ_FADE = 0.35

/** Outline row `r` in `t`, `cols` text columns wide: the reading heading in primary behind `▸`, headings above it faded. */
export function outlineRowSpans(r: OutlineRow, t: Theme, cols: number): Span[] {
  const rest = r.level === 2 ? t.textMuted : t.text
  const base = r.current ? t.primary : rest
  const fg = r.read ? mix(base, t.background, READ_FADE) : base
  const text = truncate(r.text, cols - 2 - r.indent)
  return [
    { text: r.current ? "▸ " : "  ", fg: t.primary },
    { text: " ".repeat(r.indent) },
    ...hitSpans(text, r.hits, fg, t.primary, r.current || r.level === 0),
  ]
}

/** A TL;DR row: the mark (or the hang), then the text in its tone; the caret row is the family's waiting row. */
function footSpans(it: Extract<InfoItem, { kind: "foot" }>, t: Theme, cols: number): Span[] {
  const c = footInk(t)
  if (it.tone === "caret")
    return waitingRow(t, { mark: "*", model: "", secs: 0, status: false, width: cols, stale: it.markStale })
  const hang = it.hang ?? HANG
  let lead: Span[] = hang ? [{ text: " ".repeat(hang) }] : []
  if (it.mark) lead = [{ text: it.mark, fg: it.markStale ? c.markStale : c.mark }, { text: " " }]
  const cut = it.text.indexOf(" ")
  if (it.tone === "hint")
    return [...lead, { text: it.text.slice(0, cut), fg: c.key }, { text: it.text.slice(cut), fg: c.word }]
  if (it.tone === "error" && it.text.startsWith("✗"))
    return [...lead, { text: "✗", fg: c.error, attr: A.BOLD }, { text: it.text.slice(1), fg: c.status }]
  const fg = { text: c.text, muted: c.note, stale: c.stale, error: c.status }[it.tone]
  return [...lead, { text: it.text, fg }]
}

/** `left`, then `right`'s key (text) and word (muted) at the right edge of `cols`; `left` alone when they don't both fit. */
function rightAligned(left: Span[], right: Tail, t: Theme, cols: number): Span[] {
  const r: Span[] = [
    { text: right.key ?? "", fg: t.text },
    { text: ` ${right.word}`, fg: t.textMuted },
  ]
  const gap = cols - spanWidth(left) - spanWidth(r)
  return gap < 1 ? left : [...left, { text: " ".repeat(gap) }, ...r]
}

/** `Changed since 09:23` (`· llama3.2` once explained), `D`'s word at the right edge while it fits. */
function changeLabelSpans(it: Extract<InfoItem, { kind: "changes" }>, t: Theme, cols: number): Span[] {
  const rest = ` since ${it.since}${it.model ? ` · ${safeLine(it.model)}` : ""}`
  const left: Span[] = [
    { text: "Changed", fg: t.textMuted, attr: A.BOLD },
    { text: truncate(rest, Math.max(0, cols - 7)), fg: t.textMuted },
  ]
  return it.right ? rightAligned(left, it.right, t, cols) : left
}

/** A change row: its number (primary; muted once explained or removed), the name (struck through when removed), the counts at the right edge. */
function changeSpans(it: Extract<InfoItem, { kind: "change" }>, t: Theme, cols: number): Span[] {
  const c = footInk(t)
  const mark = superscript(it.n)
  let fg = { mark: c.mark, name: c.text, counts: c.status }
  if (it.tone === "earlier") fg = { mark: c.stale, name: c.stale, counts: c.stale }
  else if (it.removed) fg = { mark: c.markStale, name: c.status, counts: c.status }
  else if (it.tone === "explained") fg = { ...fg, mark: c.markStale }
  const pad = Math.max(it.counts ? 1 : 0, cols - width(mark) - 1 - width(it.text) - width(it.counts))
  return [
    { text: mark, fg: fg.mark },
    { text: " " },
    { text: it.text, fg: fg.name, attr: it.removed ? A.STRIKE : A.NONE },
    { text: " ".repeat(pad) },
    { text: it.counts, fg: fg.counts },
  ]
}

/** Info row `it` in `t`, `cols` text columns wide: tags and link targets are cut to fit. */
export function infoSpans(it: InfoItem, t: Theme, cols: number): Span[] {
  const pad = (k: string, w: number) => k + " ".repeat(Math.max(0, w - width(k)))
  switch (it.kind) {
    case "prop":
      return [
        { text: pad(it.key, it.keyW), fg: t.textMuted },
        { text: it.text, fg: t.text },
      ]
    case "chips":
      return [
        { text: pad(it.key, it.keyW), fg: t.textMuted },
        ...it.tags.flatMap((tg, i): Span[] => [
          ...(i ? [{ text: " " }] : []),
          { text: truncate("#" + tg, cols - it.keyW), fg: t.secondary },
        ]),
        ...(it.more ? [{ text: " …", fg: t.textMuted }] : []),
      ]
    case "label":
      return [{ text: it.text, fg: t.textMuted, attr: A.BOLD }]
    case "foot":
      return footSpans(it, t, cols)
    case "frule":
      return footnoteRule(t, cols, it.tail)
    case "changes":
      return changeLabelSpans(it, t, cols)
    case "change":
      return changeSpans(it, t, cols)
    case "wait":
      return waitingRow(t, { mark: null, model: it.model, secs: it.secs, status: true, width: cols })
    case "earlier": {
      const c = footInk(t)
      const rest = truncate(` ${it.since}${it.model ? ` · ${safeLine(it.model)}` : ""}`, Math.max(0, cols - 7))
      return [
        { text: "Earlier", fg: c.stale, attr: A.BOLD },
        { text: rest, fg: c.stale },
      ]
    }
    case "cmore": {
      const left = it.open ? "show fewer" : `+ ${it.n} more section${it.n === 1 ? "" : "s"}`
      return rightAligned([{ text: left, fg: t.textMuted }], { key: "⏎", word: it.open ? "fewer" : "all" }, t, cols)
    }
    case "link":
      return [
        { text: "→ ", fg: t.textMuted },
        { text: truncate(it.target, cols - 3 - (it.path ? 0 : 1)), fg: it.path ? t.info : t.textMuted },
        ...(it.path ? [] : [{ text: "?", fg: t.textMuted }]),
      ]
    case "more":
      return [{ text: `+${it.n} more`, fg: t.textMuted }]
    case "stat":
      return [{ text: truncate(it.text, cols), fg: t.textMuted }]
    case "blank":
      return []
  }
}

// ------------------------------------------------------------- links

/** Distinct outgoing wikilink targets, in order: `[[t]]`, `[[t|alias]]`, `[[t#h]]`, and `![[t]]` embeds of notes. Code is skipped. */
export function extractLinks(body: string): string[] {
  const text = stripCode(body)
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[2]!.split("|")[0]!.split(/[#^]/)[0]!.trim()
    if (!target) continue
    if (m[1] && /\.[^/.]+$/.test(target) && !isMarkdown(target)) continue // images and other files
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}

export interface NoteIndex {
  /** lowercase rel path without extension, "/"-separated → absolute path (first wins) */
  byRel: Map<string, string>
  /** lowercase note name → its notes (absolute path, lowercase "/"-joined rel stem) */
  byName: Map<string, { path: string; rel: string }[]>
  byPath: Set<string>
}
const indexes = new WeakMap<FileNode, NoteIndex>()

/** Every note under `tree`, indexed for link resolution; built once per scanned tree. */
export function noteIndex(tree: FileNode): NoteIndex {
  const hit = indexes.get(tree)
  if (hit) return hit
  const ix: NoteIndex = { byRel: new Map(), byName: new Map(), byPath: new Set() }
  const walk = (n: FileNode) => {
    for (const c of n.children) {
      if (c.dir) walk(c)
      else {
        const rel = stem(c.rel.split(sep).join("/")).toLowerCase()
        if (!ix.byRel.has(rel)) ix.byRel.set(rel, c.path)
        const name = stem(c.name).toLowerCase()
        ix.byName.set(name, [...(ix.byName.get(name) ?? []), { path: c.path, rel }])
        ix.byPath.add(c.path)
      }
    }
  }
  walk(tree)
  indexes.set(tree, ix)
  return ix
}

/**
 * Resolve a wikilink like Obsidian does: the exact relative path (extension optional) first,
 * else a note of that name. Among several, a path suffix (`[[q/take]]`) narrows them, then a note
 * in the folder of `from` (the linking note) wins, then the shortest path, then alphabetical.
 */
export function resolveLink(target: string, tree: FileNode, from?: string | null): string | null {
  const ix = noteIndex(tree)
  const want = stem(target.replace(/\\/g, "/").replace(/^\.?\//, "")).toLowerCase()
  const exact = ix.byRel.get(want)
  if (exact) return exact
  let named = ix.byName.get(want.split("/").at(-1)!) ?? []
  if (named.length > 1 && want.includes("/")) {
    const tail = named.filter((n) => n.rel.endsWith("/" + want))
    if (tail.length) named = tail
  }
  if (named.length < 2) return named[0]?.path ?? null
  const here = from ? named.filter((n) => dirname(n.path) === dirname(from)) : []
  if (here.length) return here[0]!.path
  return named.reduce((a, b) =>
    b.rel.length < a.rel.length || (b.rel.length === a.rel.length && b.rel < a.rel) ? b : a,
  ).path
}

export interface LinkDest {
  /** note to open (null: not found, or a URL) */
  path: string | null
  heading?: string
  /** what to name in a "not found" toast */
  label: string
  url?: string
}

/** Where following `l` from the note `from` leads. */
export function linkDest(l: LinkTarget, from: string | null, tree: FileNode): LinkDest {
  if (l.kind === "url") return { path: null, label: l.href, url: l.href }
  if (l.kind === "wiki") {
    if (!l.target) return { path: from, ...(l.heading ? { heading: l.heading } : {}), label: l.heading ?? "" }
    return { path: resolveLink(l.target, tree, from), ...(l.heading ? { heading: l.heading } : {}), label: l.target }
  }
  let href = l.href
  try {
    href = decodeURIComponent(href)
  } catch {}
  href = safeLine(href) // `%1b` decodes to ESC
  const hash = href.indexOf("#")
  const file = hash >= 0 ? href.slice(0, hash) : href
  const heading = hash >= 0 ? href.slice(hash + 1) : ""
  const h = heading ? { heading } : {}
  if (!file) return { path: from, ...h, label: heading }
  if (!from) return { path: null, ...h, label: file }
  const abs = resolve(dirname(from), file)
  const ix = noteIndex(tree)
  const path = [abs, abs + ".md"].find((p) => ix.byPath.has(p)) ?? null
  return { path, ...h, label: file }
}

/** Index of the first heading matching `wanted` by `headingKey`, else null. */
export function findHeading(headings: { text: string }[], wanted: string): number | null {
  const k = headingKey(wanted)
  const i = headings.findIndex((h) => headingKey(h.text) === k)
  return i < 0 ? null : i
}
