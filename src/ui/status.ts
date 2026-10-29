// Status rows (top line, gap row, ghost line, progress line) and toasts: pure string helpers, the fade timing and the
// spans each row is drawn with.

import { basename, relative } from "node:path"
import { fadeSpans } from "./chrome"
import { stem } from "../notes/files"
import { A, type Span } from "../lib/spans"
import { spanWidth, truncate, width } from "../lib/text"
import type { Theme } from "../theme/theme"

// ------------------------------------------------------------- top line

/** Equal as titles: case and surrounding spaces ignored. */
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

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
/** Narrowest a section is cut to in the top line; narrower, it is dropped. */
const SECTION_MIN = 8
/** The state cluster's query is cut to `QUERY_MAX` columns; it shrinks to `QUERY_MIN` (3 characters and `…`) once the other items are gone. */
const QUERY_MAX = 20
const QUERY_MIN = 4
/** Columns of the title kept when the cluster takes the room. */
const TITLE_MIN = 12
/** Column of the text after the logo: the logo and a space. */
const AFTER_LOGO = 2
const locWidth = (l: Location) =>
  (l.folder ? width(l.folder) + SEP : 0) + width(l.title) + l.ancestors.reduce((n, a) => n + SEP + width(a), 0) + (l.section ? SEP + width(l.section) : 0)

/**
 * The top line's `folder / Title › ancestors › section`, fitted to `room` columns. `trail` is
 * the heading path, outermost first, ending with the section. A first entry equal to the title
 * is dropped. Room is made in this order: folder (left segments first, then all of it),
 * ancestors (outermost first), section (cut, never below 8 columns, else dropped), then the
 * title is cut.
 */
export function locationParts(dir: string, title: string, trail: string[], room: number): Location {
  const path = trail.length && sameText(trail[0]!, title) ? trail.slice(1) : trail.slice()
  const l: Location = { folder: dir === "." ? "" : dir, title, ancestors: path.slice(0, -1), section: path.at(-1) ?? "" }
  const segs = l.folder ? l.folder.split("/") : []
  while (locWidth(l) > room && segs.length > 1) {
    segs.shift()
    l.folder = "…/" + segs.join("/")
  }
  if (locWidth(l) > room) l.folder = ""
  while (locWidth(l) > room && l.ancestors.length) l.ancestors.shift()
  if (locWidth(l) > room && l.section) {
    const left = room - (locWidth(l) - width(l.section))
    l.section = left >= SECTION_MIN ? truncate(l.section, left) : ""
  }
  if (locWidth(l) > room) l.title = truncate(l.title, room)
  return l
}

export type ClusterItem = { kind: "search"; query: string; idx: number | null; count: number } | { kind: "source" } | { kind: "wide" }

/** columns between the cluster's items and between footer hints */
const GAP = 3

/** A cluster item's text as drawn (App colors the parts). */
export function clusterText(it: ClusterItem): string {
  if (it.kind === "search") return `/${it.query} ` + (it.count ? `${it.idx ?? "–"}/${it.count}` : "no match")
  return it.kind
}

const clusterW = (items: ClusterItem[]) => items.reduce((n, it, i) => n + (i ? GAP : 0) + width(clusterText(it)), 0)

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
  if (o.query) items.push({ kind: "search", query: truncate(o.query, QUERY_MAX), idx: o.matchIdx, count: o.count })
  if (o.source) items.push({ kind: "source" })
  if (o.wide && !o.zen) items.push({ kind: "wide" })
  const total = () => clusterW(items)
  while (total() > room && items.length && items[items.length - 1]!.kind !== "search") items.pop()
  const s = items[0]
  if (s?.kind === "search") while (total() > room && width(s.query) > QUERY_MIN) s.query = truncate(o.query, width(s.query) - 1)
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
  const fits = (s: string) => width(s) <= room
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

/** The "brothy" wordmark, 3 rows of block elements (U+2580 family), 36 columns; there is no narrower form. */
export const WORDMARK: readonly string[] = [
  "▄▄▄▄  ▄▄▄▄   ▄▄▄ ▄▄▄▄▄▄ ▄▄ ▄▄ ▄▄ ▄▄ ",
  "██▄██ ██▄█▄ ██▀██  ██   ██▄██ ▀███▀ ",
  "██▄█▀ ██ ██ ▀███▀  ██   ██ ██   █   ",
]
export const WORDMARK_W = Math.max(...WORDMARK.map((l) => width(l)))

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
  const h = hs.find((x) => sameText(x.text, title))
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
  const panel = o.inline && !o.zen ? { col: AFTER_LOGO, text: root ? truncate(o.vault, o.SW - AFTER_LOGO) : shrinkFolder(o.folder, o.SW - AFTER_LOGO) } : null
  const cluster = stateCluster(
    { query: o.query, matchIdx: o.matchIdx, count: o.count, source: o.source, wide: o.wide, zen: o.zen },
    Math.max(0, o.textWidth - SEP - Math.min(width(o.title), TITLE_MIN)),
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

/** The open note's path for the header: relative to the workspace, or to the vault's root (`linkRoot`) for a note reached through a link outside it. */
export function notePath(root: string, linkRoot: string | null, openPath: string | null): string {
  if (!openPath) return ""
  const outside = linkRoot !== null && relative(root, openPath).startsWith("..")
  return relative(outside ? linkRoot : root, openPath)
}

/**
 * Row 0 in `t`: the logo at column 0, then with a note open (`h`) the folder over the panel, `Title › section` (the
 * title muted while the note's main heading is on screen, `titleDim`) and the state cluster; else `no note open`.
 */
export function topLineSpans(t: Theme, logo: LogoState, h: HeaderLayout | null, titleDim: boolean): Span[] {
  const out: Span[] = []
  let x = 0
  const at = (col: number, spans: Span[]) => {
    if (col > x) out.push({ text: " ".repeat(col - x) })
    out.push(...spans)
    x = Math.max(x, col) + spanWidth(spans)
  }
  at(0, [logo === "gone" ? { text: " " } : { text: LOGO, fg: logo === "live" ? t.primary : t.textMuted, attr: logo === "live" ? A.BOLD : A.NONE }])
  if (!h) {
    at(AFTER_LOGO, [{ text: "no note open", fg: t.textMuted }])
    return out
  }
  if (h.panel) {
    const parts = h.panel.text.split(" / ")
    at(
      h.panel.col,
      parts.flatMap((p, i) => (i ? [{ text: " / ", fg: t.borderSubtle }] : []).concat({ text: p, fg: t.textMuted })),
    )
  }
  const loc = h.head
  const left: Span[] = []
  if (loc.folder) left.push({ text: loc.folder, fg: t.textMuted }, { text: " / ", fg: t.borderSubtle })
  left.push(titleDim ? { text: loc.title, fg: t.textMuted } : { text: loc.title, fg: t.text, attr: A.BOLD })
  for (const a of loc.ancestors) left.push({ text: " › ", fg: t.borderSubtle }, { text: a, fg: t.textMuted })
  if (loc.section) left.push({ text: " › ", fg: t.borderSubtle }, { text: loc.section, fg: t.secondary })
  at(loc.col, left)
  const right: Span[] = []
  h.cluster.forEach((it, i) => {
    if (i) right.push({ text: "   " })
    if (it.kind !== "search") return void right.push({ text: it.kind, fg: it.kind === "source" ? t.info : t.textMuted })
    right.push({ text: `/${it.query} `, fg: t.accent })
    if (!it.count) right.push({ text: "no match", fg: t.error, attr: A.BOLD })
    else
      right.push(it.idx === null ? { text: "–", fg: t.textMuted } : { text: String(it.idx), fg: t.text, attr: A.BOLD }, {
        text: `/${it.count}`,
        fg: t.text,
        attr: A.BOLD,
      })
  })
  at(h.clusterCol, right)
  return out
}

/** The gap row's faint rule: `cols` columns of `─` in border, from column `col`. */
export const gapSpans = (t: Theme, col: number, cols: number): Span[] => [{ text: " ".repeat(col) }, { text: "─".repeat(cols), fg: t.border }]

// ------------------------------------------------------------- progress line

const fraction = (top: number, maxTop: number) => (maxTop === 0 ? 1 : Math.max(0, Math.min(1, top / maxTop)))

/** Columns of the progress line drawn as read. */
export const fillWidth = (top: number, maxTop: number, cols: number) => Math.round(Math.max(0, cols) * fraction(top, maxTop))

/** Progress label parts: `pre` (teleprompter), `main` (percentage or page), `rest` (time left). App colors them. */
export function progressLabel(o: { top: number; maxTop: number; minutes: number; page?: { index: number; count: number }; wpm?: number }): {
  pre: string
  main: string
  rest: string
} {
  const pre = o.wpm !== undefined ? `▶ ${o.wpm} wpm · ` : ""
  const rest = o.minutes > 0 ? ` · ${o.minutes} min left` : ""
  if (o.page) return { pre, main: `page ${o.page.index + 1} of ${o.page.count}`, rest }
  if (o.minutes === 0) return { pre, main: "100%", rest: "" }
  const atEnd = o.maxTop > 0 && o.top >= o.maxTop
  return { pre, main: `${Math.round(fraction(o.top, o.maxTop) * 100)}%`, rest: atEnd ? "" : rest }
}

/** The progress line, `cols` wide: the read part in primary, the rest in border, then label `pl` (none: the line alone). */
export function progressSpans(t: Theme, pl: { pre: string; main: string; rest: string } | null, top: number, maxTop: number, cols: number): Span[] {
  const label: Span[] = pl
    ? [
        { text: pl.pre, fg: t.textMuted },
        { text: pl.main, fg: t.text },
        { text: pl.rest, fg: t.textMuted },
      ].filter((x) => x.text)
    : []
  const lineW = Math.max(0, cols - (label.length ? spanWidth(label) + 1 : 0))
  const fill = pl ? fillWidth(top, maxTop, lineW) : 0
  return [{ text: "─".repeat(fill), fg: t.primary }, { text: "─".repeat(lineW - fill), fg: t.border }, ...(label.length ? [{ text: " " }, ...label] : [])]
}

// ------------------------------------------------------------- ghost line

/** Fade timing: full for a hold, then `GHOST_STEPS` steps of `GHOST_STEP` ms, then hidden. Zen's top line holds `GHOST_HOLD`. */
export const GHOST_HOLD = 1500
export const GHOST_STEP = 120
export const GHOST_STEPS = 4
/** Key hints hold this long after a context change before they fade. */
export const HINT_HOLD = 2000

/** 0 = full, 4 = faintest, null = hidden: full for `hold` ms after the trigger, then the fade steps. */
export function fadeStep(elapsed: number, hold = GHOST_HOLD): 0 | 1 | 2 | 3 | 4 | null {
  if (elapsed < hold) return 0
  const k = 1 + Math.floor((elapsed - hold) / GHOST_STEP)
  return k <= GHOST_STEPS ? (k as 1 | 2 | 3 | 4) : null
}

export interface HintItem {
  key: string
  word: string
  /** dropped before any other hint when they do not all fit */
  spare?: boolean
}
const hintW = (h: HintItem) => width(h.key) + (h.word ? 1 + width(h.word) : 0)

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

/** The hints of `items` that fit in `room` columns (`fitHints`), keys in text and words in textMuted. */
export const hintSpans = (t: Theme, items: HintItem[], room: number): Span[] =>
  fitHints(items, room).flatMap((h, i): Span[] => [
    ...(i ? [{ text: "   " }] : []),
    { text: h.key, fg: t.text },
    ...(h.word ? [{ text: " " + h.word, fg: t.textMuted }] : []),
  ])

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

/**
 * An error's message without the path an errno error appends (`ENOENT: …, stat '/long/path'`):
 * the caller names the file itself, so a long folder (macOS's `/var/folders/…/T/`) can't push it out of the toast.
 */
export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return (e as { code?: unknown })?.code ? msg.replace(/, \w+ '.*'$/s, "") : msg
}

/** `✓`, `✗`, `↻` for a reload, else `·`. */
export const toastIcon = (t: Toast) => (t.kind === "ok" ? "✓" : t.kind === "error" ? "✗" : /reload/.test(t.msg) ? "↻" : "·")

/** The toast at `now` in `t`, cut to `cols`: its icon and message in its kind's colour (an error bold), faded as it goes; [] once gone. */
export function toastSpans(t: Theme, toast: Toast | null, now: number, cols: number): Span[] {
  const step = toast ? toastStep(toast, now) : null
  if (!toast || step === null) return []
  const fg = toast.kind === "ok" ? t.success : toast.kind === "error" ? t.error : t.info
  return fadeSpans(
    t,
    [{ text: truncate(`${toastIcon(toast)} ${toast.msg}`, cols), fg, attr: toast.kind === "error" ? A.BOLD : A.NONE }],
    step / (GHOST_STEPS + 1),
  )
}

/** The too-small-terminal message as lines that each fit `W` columns, whole words only; the longest form that fits wins. */
export function tooSmall(W: number, H: number, need = "60×14"): string[] {
  const forms = [[`terminal too small (${W}×${H}) · need ${need}`], [`too small (${W}×${H})`, `need ${need}`], [`need ${need}`], [need]]
  const fit = forms.find((f) => f.length <= Math.max(1, H) && f.every((l) => width(l) <= W))
  return fit ?? [truncate(need, Math.max(1, W))]
}
