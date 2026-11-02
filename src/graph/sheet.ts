// The graph sheet's pure side, as ui/proof.ts is the Proof sheet's: its geometry, the neighbour list and its rows as
// spans, the title's counts and the bottom line, what the terminal can draw and which renderer draws the picture. Pure.
import { resolveImageRenderProtocol, type TerminalCapabilities } from "@opentui/core"
import { A, type Span } from "../lib/spans"
import { plural, spanWidth, width as textWidth, truncate } from "../lib/text"
import { fuzzyHits } from "../notes/files"
import type { GraphRender } from "../system/config"
import type { Theme } from "../theme/theme"
import { BODY_PAD, innerWidth, PEEK_MIN_W } from "../ui/geometry"
import { proofHeight, proofWidth } from "../ui/proof"
import { roleColor } from "./canvas"
import type { Dir, Ego, EgoNode } from "./ego"

/** the neighbour list's column beside the picture */
const GRAPH_LIST_W = 34

/** The sheet's size: the popup, the picture in cells, the list column and its rows (0 below PEEK_MIN_W: no list). */
export interface SheetGeo {
  width: number
  height: number
  split: boolean
  cols: number
  rows: number
  listW: number
  listH: number
}

/** Like the Proof sheet: from PEEK_MIN_W picture │ list (the list's last row is the bottom line), else the picture and the focused row. */
export function sheetGeo(W: number, H: number): SheetGeo {
  const width = proofWidth(W)
  const height = proofHeight(H)
  const inner = innerWidth(width)
  if (W < PEEK_MIN_W)
    return { width, height, split: false, cols: inner, rows: Math.max(1, height - 1), listW: 0, listH: 0 }
  return {
    width,
    height,
    split: true,
    cols: inner - 1 - GRAPH_LIST_W,
    rows: height,
    listW: GRAPH_LIST_W,
    listH: Math.max(1, height - 2),
  }
}

type NodeRow = { kind: "node"; path: string; i: number | null; name: string; arrow: string; dir: Dir; depth: 1 | 2 }
/** A list row: a note (`i` its node in the picture, null past the cap), `+ n more`, or a line of text. */
export type GraphRow = NodeRow | { kind: "more"; n: number; open: boolean } | { kind: "note"; text: string }

const ARROW: Record<Dir, string> = { out: "→", in: "←", both: "↔", unresolved: "→" }
const rowOf = (n: EgoNode, i: number | null): GraphRow => ({
  kind: "node",
  path: n.path,
  i,
  name: n.name,
  arrow: ARROW[n.dir ?? "out"],
  dir: n.dir ?? "out",
  depth: n.depth === 2 ? 2 : 1,
})

/**
 * Each depth-1 note with the depth-2 notes it brought in under it, the unresolved last; past the cap `+ n more` (open:
 * the rest listed). No links: says so, or, while the index is still being built, that it is.
 */
export function graphRows(ego: Ego, q: string, open: boolean, indexing = false): GraphRow[] {
  if (ego.nodes.length === 1 && !ego.rest.length)
    return [{ kind: "note", text: indexing ? "▍ indexing notes" : "no links to or from this note" }]
  const rows: GraphRow[] = []
  ego.nodes.forEach((n, i) => {
    if (n.depth === 1) rows.push(rowOf(n, i), ...ego.nodes.flatMap((m, k) => (m.parent === i ? [rowOf(m, k)] : [])))
  })
  if (open) rows.push(...ego.rest.map((n) => rowOf(n, null)))
  if (ego.rest.length) rows.push({ kind: "more", n: ego.rest.length, open })
  const kept = q ? rows.filter((r) => r.kind !== "node" || fuzzyHits(r.name, q)) : rows
  return kept.some((r) => r.kind === "node") ? kept : [{ kind: "note", text: "no match" }]
}

/** A row the focus can rest on: a note that exists, or `+ n more`. */
export const isGraphStop = (r: GraphRow | undefined) =>
  r?.kind === "more" || (r?.kind === "node" && r.dir !== "unresolved")

/** The next stop from `cur` in `dir`; stays put at either end. */
export function nextStop(rows: readonly GraphRow[], cur: number, dir: 1 | -1): number {
  for (let k = cur + dir; k >= 0 && k < rows.length; k += dir) if (isGraphStop(rows[k])) return k
  return cur
}

/** Right of the title, longest first: `← 9 · → 6 · 2 unresolved · depth 2`, without `unresolved`, `depth 2` alone. */
function noteForms(ego: Ego, depth: 1 | 2): string[] {
  const { back, out, unresolved } = ego.counts
  const counts = [`← ${back}`, `→ ${out}`]
  const d = `depth ${depth}`
  const all = [...counts, ...(unresolved ? [`${unresolved} unresolved`] : []), d]
  return [all, [...counts, d], [d]].map((p) => p.join(" · "))
}

/** `esc` and the two cells before it, right of the title row */
const ESC_W = 5

/**
 * The title row in a popup `width` wide (its padding and the row's, 4 a side, off): `Graph · <name>` and the longest
 * note that fits beside it and `esc`, else none; the title is cut only when it alone does not fit.
 */
export function graphHead(name: string, ego: Ego, depth: 1 | 2, width: number): { title: string; note: string } {
  const room = innerWidth(width) - BODY_PAD
  const title = truncate(`Graph · ${name}`, room - ESC_W)
  const left = room - textWidth(title) - 2 - ESC_W
  return { title, note: noteForms(ego, depth).find((n) => textWidth(n) <= left) ?? "" }
}

/** The bottom line: `depth 2 · 28 of 32 notes`, or the index build's progress. */
export function graphFoot(ego: Ego, depth: 1 | 2, notes: number, indexing: [number, number] | null): string {
  if (indexing) return `▍ indexing notes · ${indexing[0]} of ${indexing[1]}`
  const shown = ego.nodes.filter((n) => n.dir !== "unresolved").length
  return `depth ${depth} · ${shown} of ${plural(Math.max(notes, shown), "note")}`
}

/** A note row's arrow (in its role) and name: depth 2 indented and muted, unresolved muted and struck. */
function nodeBody(r: NodeRow, t: Theme, room: number, sel: boolean): Span[] {
  const indent = r.depth === 2 ? "  " : ""
  const muted = r.depth === 2 || r.dir === "unresolved"
  const struck = r.dir === "unresolved" ? A.STRIKE : 0
  const attr = sel ? A.BOLD : struck
  return [
    { text: truncate(`${indent}${r.arrow} `, room), fg: roleColor(t, r.dir, r.depth) },
    { text: truncate(r.name, Math.max(0, room - indent.length - 2)), fg: muted && !sel ? t.textMuted : t.text, attr },
  ]
}

function rowBody(r: GraphRow, t: Theme, room: number, sel: boolean): Span[] {
  if (r.kind === "node") return nodeBody(r, t, room, sel)
  const text = r.kind === "more" ? `+ ${r.n} more · ⏎ ${r.open ? "fewer" : "all"}` : r.text
  return [{ text: truncate(text, room), fg: t.textMuted }]
}

/** A list row in `room` columns: a bar column, then the row; focused, `▌` and the element background across it. */
export function graphRowSpans(r: GraphRow, t: Theme, room: number, sel: boolean): Span[] {
  const bg = sel ? t.backgroundElement : undefined
  const body = rowBody(r, t, room - 1, sel).map((s) => ({ ...s, bg }))
  const pad = room - 1 - spanWidth(body)
  return [
    { text: sel ? "▌" : " ", fg: t.primary, bg },
    ...body,
    ...(sel && pad > 0 ? [{ text: " ".repeat(pad), bg }] : []),
  ]
}

/** What the terminal can do for the picture, read from the renderer when the sheet opens. */
export interface GraphTerm {
  /** OpenTUI would draw kitty or sixel here (never blocks: thin edges vanish in them) */
  pixels: boolean
  /** inside a multiplexer, or remote: an answer that may not be the outer terminal's */
  mux: boolean
  /** a cell's size in pixels (8 × 16 when the terminal does not say) */
  cellW: number
  cellH: number
}

export function graphTerm(
  caps: TerminalCapabilities | null,
  res: { width: number; height: number } | null,
  cols: number,
  rows: number,
): GraphTerm {
  return {
    pixels: resolveImageRenderProtocol("auto", caps, !!res) !== "blocks",
    mux: !!caps && (caps.multiplexer !== "none" || caps.remote),
    cellW: res && cols ? res.width / cols : 8,
    cellH: res && rows ? res.height / rows : 16,
  }
}

export type GraphMode = "pixels" | "braille"

/** Braille when asked for, once pixels failed this run, or where the terminal shows no images; else pixels. */
export const graphMode = (pref: GraphRender, term: GraphTerm, failed: boolean): GraphMode =>
  pref !== "braille" && !failed && term.pixels ? "pixels" : "braille"
