// Status rows (top line, ghost line, progress line): pure string helpers. Span styling stays in App.

import { basename } from "node:path"
import { stem } from "./files"
import { width as sw } from "./markdown"
import { fadeStep } from "./zen"

/** Cut `s` to `max` columns, ending in `…` when it had to be cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return ""
  if (sw(s) <= max) return s
  let out = ""
  for (const ch of s) {
    if (sw(out + ch) > max - 1) break
    out += ch
  }
  return out + "…"
}

/** Cut `s` from the left to `max` columns, starting with `…` when it had to be cut. */
export function truncateLeft(s: string, max: number): string {
  if (max <= 0) return ""
  if (sw(s) <= max) return s
  const chars = [...s]
  let out = ""
  for (let i = chars.length - 1; i >= 0; i--) {
    if (sw(chars[i] + out) > max - 1) break
    out = chars[i] + out
  }
  return "…" + out
}

// ------------------------------------------------------------- top line

/** The note's name: front-matter `title` (quotes, `*`, `_` and backticks stripped), else the file name without extension. */
export function noteTitle(props: readonly (readonly [string, string | string[]])[], path: string): string {
  const v = props.find(([k]) => k.toLowerCase() === "title")?.[1]
  const title =
    typeof v === "string"
      ? v
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2")
          .replace(/[*_`]/g, "")
          .trim()
      : ""
  if (title) return title
  const name = basename(path)
  return stem(name) || name
}

export interface Location {
  folder: string
  title: string
  ancestors: string[]
  section: string
}

const SEP = 3 // " / " and " › "
const locWidth = (l: Location) =>
  (l.folder ? sw(l.folder) + SEP : 0) +
  sw(l.title) +
  l.ancestors.reduce((n, a) => n + SEP + sw(a), 0) +
  (l.section ? SEP + sw(l.section) : 0)

/**
 * The top line's `folder / Title › ancestors › section`, fitted to `room` columns. `trail` is
 * the heading path, outermost first, ending with the section. A first entry equal to the title
 * is dropped. Room is made in this order: folder (left segments first, then all of it),
 * ancestors (outermost first), section (cut, never below 8 columns, else dropped), then the
 * title is cut.
 */
export function locationParts(dir: string, title: string, trail: string[], room: number): Location {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const path = trail.length && same(trail[0]!, title) ? trail.slice(1) : trail.slice()
  const l: Location = { folder: dir === "." ? "" : dir, title, ancestors: path.slice(0, -1), section: path.at(-1) ?? "" }
  const segs = l.folder ? l.folder.split("/") : []
  while (locWidth(l) > room && segs.length > 1) {
    segs.shift()
    l.folder = "…/" + segs.join("/")
  }
  if (locWidth(l) > room) l.folder = ""
  while (locWidth(l) > room && l.ancestors.length) l.ancestors.shift()
  if (locWidth(l) > room && l.section) {
    const left = room - (locWidth(l) - sw(l.section))
    l.section = left >= 8 ? truncate(l.section, left) : ""
  }
  if (locWidth(l) > room) l.title = truncate(l.title, room)
  return l
}

export type ClusterItem =
  | { kind: "search"; query: string; idx: number | null; count: number }
  | { kind: "source" }
  | { kind: "wide" }

const GAP = 3

/** A cluster item's text as drawn (App colors the parts). */
export function clusterText(it: ClusterItem): string {
  if (it.kind === "search") return `/${it.query} ` + (it.count ? `${it.idx ?? "–"}/${it.count}` : "no match")
  return it.kind
}

/**
 * The top line's right side, in display order: search (`/q i/n`), `source`, `wide` (not in
 * zen). If it is wider than `room`, `wide` drops first, then `source`, then the query shrinks
 * (cut to 20 columns at most, never below 3 characters plus `…`).
 */
export function stateCluster(
  o: { query: string; matchIdx: number | null; count: number; source: boolean; wide: boolean; zen: boolean },
  room: number,
): ClusterItem[] {
  const items: ClusterItem[] = []
  if (o.query) items.push({ kind: "search", query: truncate(o.query, 20), idx: o.matchIdx, count: o.count })
  if (o.source) items.push({ kind: "source" })
  if (o.wide && !o.zen) items.push({ kind: "wide" })
  const total = () => items.reduce((n, it, i) => n + (i ? GAP : 0) + sw(clusterText(it)), 0)
  while (total() > room && items.length && items[items.length - 1]!.kind !== "search") items.pop()
  const s = items[0]
  if (s?.kind === "search") while (total() > room && sw(s.query) > 4) s.query = truncate(o.query, sw(s.query) - 1)
  return items
}

// ------------------------------------------------------------- header (row 0 layout)

/**
 * A folder path for the column over the panel, `a / b / c`. When it does not fit: `first / … / last`,
 * then `… / last`, then the last segment alone (cut with `…` if even that is too wide).
 */
export function shrinkFolder(folder: string, room: number): string {
  if (!folder || room <= 0) return ""
  const segs = folder.split("/")
  const fits = (s: string) => sw(s) <= room
  const full = segs.join(" / ")
  if (fits(full)) return full
  if (segs.length > 2) {
    const mid = `${segs[0]} / … / ${segs.at(-1)}`
    if (fits(mid)) return mid
  }
  if (segs.length > 1) {
    const tail = `… / ${segs.at(-1)}`
    if (fits(tail)) return tail
  }
  return truncate(segs.at(-1)!, room)
}

/** The header logo: Nerd Font md-bowl_mix (U+F0617), one cell at column 0. */
export const LOGO = "\u{F0617}"

/** The "brothy" wordmark, 3 rows of box-drawing. */
export const WORDMARK: readonly string[] = [
  "┏┓ ┳━┓┏━┓╺┳╸╻ ╻╻ ╻",
  "┣┻┓┣┳┛┃ ┃ ┃ ┣━┫┗┳┛",
  "┗━┛╹┗╸┗━┛ ╹ ╹ ╹ ╹ ", // trailing cell padded so all rows are equal width
]
export const WORDMARK_W = Math.max(...WORDMARK.map((l) => sw(l)))

/** The wordmark when a `w`×`h` area can hold it, else null. */
export function fitWordmark(w: number, h: number): readonly string[] | null {
  return w >= WORDMARK_W && h >= WORDMARK.length ? WORDMARK : null
}

export type LogoState = "watching" | "live" | "gone"
/** How long the logo stays bright after a live reload (ms). */
export const LOGO_HOLD = 1000

/** The logo's state: absent while the file is gone, bright for `LOGO_HOLD` after a reload, else muted. */
export function logoState(o: { gone: boolean; reloadedAt: number | null; now: number }): LogoState {
  if (o.gone) return "gone"
  return o.reloadedAt !== null && o.now - o.reloadedAt < LOGO_HOLD ? "live" : "watching"
}

/** Is the note's own main heading (the first heading equal to `title`) on screen, lines `[top, top + rows)`? */
export function mainHeadingVisible(hs: readonly { text: string; line: number }[], title: string, top: number, rows: number): boolean {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const h = hs.find((x) => same(x.text, title))
  return !!h && h.line >= top && h.line < top + rows
}

export interface HeaderLayout {
  /** folder (or vault name) over the panel column; null when the panel is not inline */
  panel: { col: number; text: string } | null
  /** `Title › section` (and the immediate folder when there is no panel column) from the text's left edge */
  head: Location & { col: number }
  cluster: ClusterItem[]
  clusterCol: number
  clusterWidth: number
  /** the faint rule on the gap row, over the text column */
  rule: { col: number; width: number } | null
}

const clusterW = (items: ClusterItem[]) => items.reduce((n, it, i) => n + (i ? GAP : 0) + sw(clusterText(it)), 0)

/**
 * Row 0 beyond the logo (always column 0): the folder over the panel column (inline panel only),
 * then from the text's left edge `Title › section` with the state cluster right-aligned to the
 * text's right edge. Without a panel column the immediate folder leads the title and is the
 * first thing dropped; zen never shows a folder. `folder` is relative to the vault (`.` = root).
 */
export function headerLayout(o: {
  inline: boolean
  SW: number
  textLeft: number
  textWidth: number
  zen: boolean
  gap: boolean
  vault: string
  folder: string
  title: string
  trail: string[]
  query: string
  matchIdx: number | null
  count: number
  source: boolean
  wide: boolean
}): HeaderLayout {
  const root = o.folder === "." || o.folder === ""
  const panel =
    o.inline && !o.zen
      ? { col: 2, text: root ? truncate(o.vault, o.SW - 2) : shrinkFolder(o.folder, o.SW - 2) }
      : null
  const cluster = stateCluster(
    { query: o.query, matchIdx: o.matchIdx, count: o.count, source: o.source, wide: o.wide, zen: o.zen },
    Math.max(0, o.textWidth - SEP - Math.min(sw(o.title), 12)),
  )
  const cw = clusterW(cluster)
  const room = o.textWidth - cw - (cluster.length ? SEP : 0)
  const immediate = panel || o.zen || root ? "." : o.folder.split("/").at(-1)!
  const head = locationParts(immediate, o.title, o.trail, room)
  return {
    panel,
    head: { ...head, col: o.textLeft },
    cluster,
    clusterCol: o.textLeft + o.textWidth - cw,
    clusterWidth: cw,
    rule: o.gap && !o.zen ? { col: o.textLeft, width: o.textWidth } : null,
  }
}

// ------------------------------------------------------------- progress line

const fraction = (top: number, maxTop: number) => (maxTop === 0 ? 1 : Math.max(0, Math.min(1, top / maxTop)))

/** Columns of the progress line drawn as read. */
export const fillWidth = (top: number, maxTop: number, width: number) => Math.round(Math.max(0, width) * fraction(top, maxTop))

/** Progress label parts: `pre` (teleprompter), `main` (percentage or page), `rest` (time left). App colors them. */
export function progressLabel(o: {
  top: number
  maxTop: number
  minutes: number
  page?: { index: number; count: number }
  wpm?: number
}): { pre: string; main: string; rest: string } {
  const pre = o.wpm !== undefined ? `▶ ${o.wpm} wpm · ` : ""
  const rest = o.minutes > 0 ? ` · ${o.minutes} min left` : ""
  if (o.page) return { pre, main: `page ${o.page.index + 1} of ${o.page.count}`, rest }
  if (o.minutes === 0) return { pre, main: "100%", rest: "" }
  const atEnd = o.maxTop > 0 && o.top >= o.maxTop
  return { pre, main: `${Math.round(fraction(o.top, o.maxTop) * 100)}%`, rest: atEnd ? "" : rest }
}

// ------------------------------------------------------------- ghost line

export interface HintItem {
  key: string
  word: string
  /** dropped before any other hint when they do not all fit */
  spare?: boolean
}
const hintW = (h: HintItem) => sw(h.key) + (h.word ? 1 + sw(h.word) : 0)

/** The leading hints that fit in `room` columns (3-space gaps); the rest are dropped. */
export function fitHints(items: HintItem[], room: number): HintItem[] {
  const all = items.reduce((w, h, i) => w + (i ? GAP : 0) + hintW(h), 0)
  if (all > room) items = items.filter((h) => !h.spare)
  const out: HintItem[] = []
  let w = 0
  for (const h of items) {
    const add = (out.length ? GAP : 0) + hintW(h)
    if (w + add > room) break
    out.push(h)
    w += add
  }
  return out
}

export type ToastKind = "ok" | "info" | "error"
export interface Toast {
  msg: string
  kind: ToastKind
  at: number
}
/** How long a toast holds at full color before it fades, by kind. */
export const TOAST_HOLD: Record<ToastKind, number> = { ok: 1800, info: 1800, error: 4000 }

export const toastStep = (t: Toast, now: number) => fadeStep(now - t.at, TOAST_HOLD[t.kind])

/** The toast to show next: an error that is still holding is never replaced by ok / info. */
export function nextToast(cur: Toast | null, incoming: Toast, now: number): Toast {
  if (cur?.kind === "error" && incoming.kind !== "error" && toastStep(cur, now) === 0) return cur
  return incoming
}

export const toastIcon = (t: Toast) => (t.kind === "ok" ? "✓" : t.kind === "error" ? "✗" : /reload/.test(t.msg) ? "↻" : "·")

/** The too-small-terminal message as lines that each fit `W` columns, whole words only; the longest form that fits wins. */
export function tooSmall(W: number, H: number, need = "60×14"): string[] {
  const forms = [[`terminal too small (${W}×${H}) · need ${need}`], [`too small (${W}×${H})`, `need ${need}`], [`need ${need}`], [need]]
  const fit = forms.find((f) => f.length <= Math.max(1, H) && f.every((l) => sw(l) <= W))
  return fit ?? [truncate(need, Math.max(1, W))]
}
