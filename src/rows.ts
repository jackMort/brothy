// Pure row builders for the popups: hit highlighting and fitting, switcher and open-picker rows, the theme mode switch,
// the scrim colour and the welcome art spans. No React: overlay.tsx draws them.
import { basename, dirname } from "node:path"
import { A, safeLine, type Span } from "./spans"
import { spanWidth, truncate, truncateLeft, width } from "./text"
import { chip, inkAt, steamColors } from "./chrome"
import { stem } from "./files"
import { tildify, type OpenRow } from "./projects"
import type { SwitchRow } from "./vault"
import type { ArtCell } from "./welcome"
import { BOARD_MODES, type ThemeMode } from "./themepick"
import type { Theme } from "./theme"

/** Wash drawn over the page behind a popup: black over dark themes, white over light ones. */
export function scrim(t: Theme): { r: number; g: number; b: number; a: number } {
  return t.mode === "light" ? { r: 255, g: 255, b: 255, a: 170 } : { r: 0, g: 0, b: 0, a: 150 }
}

export interface PickerItem {
  spans: Span[]
  /** right-aligned muted text */
  right?: string
  /** a section title: never highlighted, hovered or activated */
  header?: boolean
}

/** `text` with the code points at `hits` drawn in `hit` and bold (`bold`: the rest bold too). */
export function hitSpans(text: string, hits: readonly number[], fg: string, hit: string, bold = false): Span[] {
  const on = new Set(hits)
  const out: Span[] = []
  ;[...text].forEach((ch, i) => {
    const m = on.has(i)
    const style = { fg: m ? hit : fg, attr: m || bold ? A.BOLD : 0 }
    const last = out[out.length - 1]
    if (last && last.fg === style.fg && last.attr === style.attr) last.text += ch
    else out.push({ text: ch, ...style })
  })
  return out
}

/**
 * `text` cut to `room` columns so its hits stay visible: the end goes first; when the hits lie past
 * it, a window from a little before the first hit. Each cut is marked `…`; hits are re-indexed.
 */
export function fitHits(text: string, hits: readonly number[], room: number): { text: string; hits: number[] } {
  const cps = [...text]
  const ws = cps.map((c) => width(c))
  const span = (a: number, b: number) => ws.slice(a, b).reduce((x, y) => x + y, 0)
  if (span(0, cps.length) <= room) return { text, hits: [...hits] }
  if (room < 2) return { text: "…".slice(0, Math.max(0, room)), hits: [] }
  const first = hits.length ? Math.min(...hits) : 0
  const last = hits.length ? Math.max(...hits) : 0
  let a = 0
  if (span(0, last + 1) > room - 1) {
    // a third of the slack (both cuts marked) goes before the first hit
    let lead = Math.max(0, Math.floor((room - 2 - span(first, last + 1)) / 3))
    a = first
    while (a > 0 && ws[a - 1]! <= lead) lead -= ws[--a]!
    // a window that reaches the end spends what is left on text before the hit
    let spare = room - 1 - span(a, cps.length)
    while (a > 0 && ws[a - 1]! <= spare) spare -= ws[--a]!
  }
  const head = a > 0 ? "…" : ""
  let budget = room - head.length
  let b = cps.length
  if (span(a, b) > budget) {
    budget -= 1
    b = a
    for (let used = 0; b < cps.length && used + ws[b]! <= budget; b++) used += ws[b]!
  }
  const tail = b < cps.length ? "…" : ""
  const shift = head.length - a
  return { text: head + cps.slice(a, b).join("") + tail, hits: hits.filter((h) => h >= a && h < b).map((h) => h + shift) }
}

/**
 * One switcher row: a muted bold section title, or a hit with its matches in `primary`. Within
 * `w` columns the folder keeps at most a third (its tail) and a heading or text row's note name at
 * most a quarter; the matched text gets the rest, cut around its hits, so the match stays in view.
 */
export function switchItem(r: SwitchRow, t: Theme, w = Infinity): PickerItem {
  if (r.kind === "header") return { header: true, spans: [{ text: r.title, fg: t.textMuted, attr: A.BOLD }], right: r.count }
  if (r.kind === "askNote") return { header: true, spans: [{ text: safeLine(r.text), fg: t.textMuted }] }
  if (r.kind === "askAction")
    return { spans: [...(r.error ? [{ text: "✗ ", fg: t.error }] : []), { text: safeLine(r.text), fg: t.text }, { text: safeLine(r.note), fg: t.textMuted }] }
  if (r.kind === "answer") {
    const room = w - (r.right ? width(r.right) + 1 : 0)
    if (r.heading < 0) {
      const f = fitHits(r.name, [], room)
      return { spans: hitSpans(f.text, f.hits, t.text, t.primary), right: r.right }
    }
    const name = truncate(r.name, Math.max(12, Math.floor(w / 4)))
    const f = fitHits(r.text, r.hits, room - width(name) - 3)
    return { spans: [{ text: name + " › ", fg: t.textMuted }, ...hitSpans(f.text, f.hits, t.text, t.primary)], right: r.right }
  }
  const folder = r.kind === "text" ? "" : truncateLeft(r.folder, Math.floor(w / 3))
  const room = w - (folder ? width(folder) + 1 : 0)
  const name = truncate(r.name, Math.max(12, Math.floor(w / 4)))
  const fit = (text: string, hits: readonly number[], used: number, fg: string) => {
    const f = fitHits(text, hits, room - used)
    return hitSpans(f.text, f.hits, fg, t.primary)
  }
  switch (r.kind) {
    case "note": {
      if (!r.alias) return { spans: fit(r.name, r.hits, 0, t.text), right: folder }
      const short = truncate(r.name, Math.max(8, Math.floor(room / 3)))
      return {
        spans: [...hitSpans(short, [], t.text, t.primary), { text: "  ← ", fg: t.textMuted }, ...fit(r.alias.text, r.alias.hits, width(short) + 4, t.textMuted)],
        right: folder,
      }
    }
    case "heading":
      return { spans: [{ text: name + " › ", fg: t.textMuted }, ...fit(r.text, r.hits, width(name) + 3, t.text)], right: folder }
    case "text":
      return { spans: [{ text: name + "  ", fg: t.text }, ...fit(r.context, r.hits, width(name) + 2, t.textMuted)] }
  }
}

/**
 * One `o` picker row. Recent: the name (muted when the folder is gone), its `~` path cut from the
 * left, the last note on the right. Path: the entry's name (folders end in `/`), the typed folder
 * itself marked "this folder".
 */
export function openItem(r: OpenRow, t: Theme, w = Infinity, home?: string): PickerItem {
  if (r.kind === "header") return { header: true, spans: [{ text: r.title, fg: t.textMuted, attr: A.BOLD }], right: r.count }
  if (r.kind === "path") {
    if (r.self) return { spans: [{ text: r.completion, fg: t.text }], right: "this folder" }
    return { spans: [...hitSpans(r.name, r.hits, t.text, t.primary), ...(r.dir ? [{ text: "/", fg: t.textMuted }] : [])] }
  }
  const right = r.missing ? "missing" : r.entry.lastNote ? truncate(stem(basename(r.entry.lastNote)), Math.max(8, Math.floor(w / 3))) : ""
  const name = fitHits(r.name, r.hits, Math.max(8, Math.floor(w / 3)))
  const room = w - (right ? width(right) + 1 : 0) - width(name.text) - 2
  // a path too long for the row drops its last segment (the name, already shown), then cuts from the left
  const full = tildify(r.entry.root, home)
  const path = width(full) <= room ? full : room >= 6 ? truncateLeft(tildify(dirname(r.entry.root), home), room) : ""
  return {
    spans: [...hitSpans(name.text, name.hits, r.missing ? t.textMuted : t.text, t.primary), ...(path ? [{ text: "  " + path, fg: t.textMuted }] : [])],
    right,
  }
}

/** The modes in the switch's order: the board's (`BOARD_MODES`). */
export const SWITCH_MODES = BOARD_MODES

/**
 * The mode switch in the input row, one segment per SWITCH_MODES entry: the active side as a primary
 * chip, the other muted; with `only` (a single-mode family) the missing side is also struck through.
 */
export const modeSwitch = (t: Theme, mode: ThemeMode, only?: ThemeMode): Span[][] =>
  SWITCH_MODES.map((m) =>
    m === mode ? chip(t, m, t.primary) : [{ text: ` ${m} `, fg: t.textMuted, ...(only && m !== only ? { attr: A.STRIKE } : {}) }],
  )

/** `spans` padded with spaces to `w` cells. */
export const padTo = (spans: Span[], w: number): Span[] => [...spans, { text: " ".repeat(Math.max(0, w - spanWidth(spans))) }]

/** Spans of one art row, `cells` coloured by role; neighbours with the same look share a span. */
export function artSpans(t: Theme, cells: ArtCell[], ink: number): Span[] {
  const steam = steamColors(t)
  const out: Span[] = []
  for (const c of cells) {
    const fg =
      c.role === "mark" || c.role === "body" ? inkAt(t, ink, t.primary) : c.role === "edge" ? inkAt(t, ink, t.text) : c.role === "steam" ? steam[c.row ?? 4] : undefined
    const bg = c.broth ? inkAt(t, ink, t.secondary) : undefined
    const last = out.at(-1)
    if (last && last.fg === fg && last.bg === bg) last.text += c.ch
    else out.push({ text: c.ch, fg, bg })
  }
  return out
}
