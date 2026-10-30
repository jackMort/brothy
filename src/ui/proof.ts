// The Proof sheet's rows, pure: the `What changed` popup lists every changed section with its real diff lines, the
// explanation's summary and notes above them once there is one. `proofRows` builds the rows at a width, `proofSpans`
// draws one, `windowLine` cuts a long diff line around its change, `proofTop` keeps the highlighted block in view.
import { type Change, changeCounts, type Hunk, type Op } from "../ai/delta"
import { A, type Span, safeLine } from "../lib/spans"
import { clamp, graphemes, superscript, truncate, width } from "../lib/text"
import type { Theme } from "../theme/theme"
import { CARET, footInk, noteRows, waitingRow } from "./footnote"
import { PEEK_MIN_W, popupWidth, splitWidth } from "./geometry"
import { CHANGE_MSG_ROWS, CHANGE_NOTE_ROWS, CHANGE_SUMMARY_ROWS, type ChangeView } from "./panel"

/** Lines of an added, removed or rewritten section shown; past them a `… n more lines` row. */
export const PROOF_CAP = 20
/** Columns of context kept left of the first changed character when a long line is cut. */
const LEAD = 8

/** One row of the sheet; `at` is the change (0-based, as in `ChangeView.changes`) a row belongs to. */
export type ProofRow =
  | { kind: "summary"; first: boolean; text: string }
  | { kind: "status"; model: string; secs: number }
  | { kind: "error"; first: boolean; text: string }
  | { kind: "block"; at: number; name: string; counts: string; muted: boolean; removed: boolean }
  | { kind: "note"; at: number; text: string }
  | { kind: "diff"; at: number; op: Op["op"]; text: string; cutL: boolean; cutR: boolean }
  | { kind: "gap"; at: number }
  | { kind: "rewritten"; at: number }
  | { kind: "more"; at: number; op: Op["op"]; n: number }

/** The sheet's width: the screen less its margin, and from PEEK_MIN_W columns the split popup's. */
export const proofWidth = (W: number) => (W < PEEK_MIN_W ? popupWidth(W, W) : splitWidth(W))

/** The mark column's width: the widest number (`¹⁰` is two). */
export const proofMarkW = (changes: readonly Change[]) => width(superscript(changes.length))

/**
 * `text` within `room` columns, cut around the display column `at` (its first changed character) with LEAD columns of
 * context before it. `cutL` / `cutR`: a `…` belongs on that side; the text and the `…`s together never pass `room`.
 */
export function windowLine(text: string, room: number, at: number): { text: string; cutL: boolean; cutR: boolean } {
  if (width(text) <= room) return { text, cutL: false, cutR: false }
  if (room < 3) return { text: truncate(text, room), cutL: false, cutR: false }
  const gs = graphemes(text)
  const start = Math.max(0, at - LEAD)
  const cutL = start > 0
  let col = 0
  let from = 0
  while (from < gs.length && col < start) col += width(gs[from++]!)
  const left = room - (cutL ? 1 : 0)
  const fit = (budget: number) => {
    let used = 0
    let to = from
    while (to < gs.length && used + width(gs[to]!) <= budget) used += width(gs[to++]!)
    return to
  }
  const to = fit(left)
  if (to === gs.length) return { text: gs.slice(from).join(""), cutL, cutR: false }
  return { text: gs.slice(from, fit(left - 1)).join(""), cutL, cutR: true }
}

/** The display column where the line at `ops[i]` first differs from its partner (the `-` and `+` runs pair in order); 0 with none. */
function changedCol(ops: readonly Op[], i: number): number {
  const op = ops[i]!.op
  if (op === " ") return 0
  const run = (k: number, dir: 1 | -1) => {
    let a = k
    while (ops[a + dir]?.op === op) a += dir
    return a
  }
  const first = run(i, -1)
  const last = run(i, 1)
  const other = op === "-" ? last + 1 : first - 1
  const from = op === "-" ? other : run(other, -1)
  const partner = ops[from + (i - first)]
  if (!partner || partner.op === op || partner.op === " ") return 0
  const a = graphemes(ops[i]!.text)
  const b = graphemes(partner.text)
  let col = 0
  for (let k = 0; k < a.length && a[k] === b[k]; k++) col += width(a[k]!)
  return col
}

/** The lines of one hunk as rows, each cut to `room` columns. */
function hunkRows(h: Hunk, at: number, room: number): ProofRow[] {
  return h.ops.map((o, i) => ({
    kind: "diff",
    at,
    op: o.op,
    ...windowLine(safeLine(o.text), room, changedCol(h.ops, i)),
  }))
}

/** A change's diff rows: its hunks with `…` between them; an added, removed or rewritten section as one run, capped. */
function diffRows(c: Change, at: number, room: number): ProofRow[] {
  const whole = c.rewritten || c.status !== "edited"
  const hunks: Hunk[] = c.rewritten ? [{ ops: c.newText.split("\n").map((text) => ({ op: "+", text })) }] : c.hunks
  const rows = hunks.flatMap((h, i): ProofRow[] => [
    ...(i ? [{ kind: "gap" as const, at }] : []),
    ...hunkRows(h, at, room),
  ])
  if (!whole) return rows
  const total = hunks.reduce((n, h) => n + h.ops.length, 0)
  const head: ProofRow[] = c.rewritten ? [{ kind: "rewritten", at }] : []
  if (total <= PROOF_CAP) return [...head, ...rows]
  return [...head, ...rows.slice(0, PROOF_CAP), { kind: "more", at, op: hunks[0]!.ops[0]!.op, n: total - PROOF_CAP }]
}

/** The rows above the blocks: the error, the waiting row, or the summary (a caret at its end while it streams). */
function headRows(cv: ChangeView, tw: number): ProofRow[] {
  const rows = (text: string, max: number, kind: "summary" | "error"): ProofRow[] =>
    noteRows(text, tw, null, max, { cut: "…" }).map((r, i) => ({ kind, first: !i, text: r }))
  if (cv.state === "error" && cv.error) return rows(cv.error, CHANGE_MSG_ROWS, "error")
  if (cv.state !== "loading" && cv.state !== "result") return []
  if (cv.state === "loading" && !cv.summary && !cv.notes.some(Boolean))
    return [{ kind: "status", model: cv.model, secs: cv.secs }]
  return rows(cv.state === "loading" ? cv.summary + CARET : cv.summary, CHANGE_SUMMARY_ROWS, "summary")
}

/** A change's header (number, name, counts) and, once explained, its note. */
function blockHead(cv: ChangeView, c: Change, at: number, title: string, tw: number): ProofRow[] {
  const counts = c.status === "added" ? "new" : changeCounts(c)
  const name = safeLine(c.index < 0 || !c.path.length ? title : c.path.at(-1)!)
  const removed = c.status === "removed"
  const block: ProofRow = {
    kind: "block",
    at,
    name: truncate(name, Math.max(1, tw - (counts ? width(counts) + 1 : 0))),
    counts,
    muted: removed || cv.state === "result",
    removed,
  }
  const what = cv.state === "loading" || cv.state === "result" ? cv.notes[at]?.what : undefined
  const notes = what ? noteRows(what, tw, null, CHANGE_NOTE_ROWS, { cut: "…" }) : []
  return [block, ...notes.map((text): ProofRow => ({ kind: "note", at, text }))]
}

/**
 * The sheet at `room` columns per row (the cursor column included): the explanation's head, then per change its header,
 * note and diff. Empty for a list too large to compare. `title` names the lead-in.
 */
export function proofRows(cv: ChangeView, title: string, room: number): ProofRow[] {
  const changes = cv.changes
  if (!changes) return []
  const tw = room - 2 - proofMarkW(changes)
  return [
    ...headRows(cv, tw),
    ...changes.flatMap((c, at) => [...blockHead(cv, c, at, title, tw), ...diffRows(c, at, tw - 2)]),
  ]
}

/** The change row `y` belongs to; null above the blocks. */
export const blockAt = (rows: readonly ProofRow[], y: number): number | null => {
  const r = rows[y]
  return r && "at" in r ? r.at : null
}

/** The first row of change `at`'s block. */
export const blockRow = (rows: readonly ProofRow[], at: number) =>
  rows.findIndex((r) => r.kind === "block" && r.at === at)

/**
 * The first visible row, moved the least that shows block `hl`'s header and the row under it; the first block shows
 * from the very top (the summary above it).
 */
export function proofTop(rows: readonly ProofRow[], hl: number, top: number, height: number): number {
  const max = Math.max(0, rows.length - height)
  const from = blockRow(rows, hl)
  if (from < 0) return clamp(top, 0, max)
  const want = Math.min(from, Math.max(top, from + 2 - height))
  return clamp(hl === 0 && from + 2 <= height ? 0 : want, 0, max)
}

/** The sheet's row `r` in `t`, `room` columns wide; `sel`: its block is the highlighted one (the cursor bar, a bold name). */
export function proofSpans(r: ProofRow, t: Theme, o: { room: number; markW: number; sel: boolean }): Span[] {
  const c = footInk(t)
  const indent = (extra = 0) => " ".repeat(2 + o.markW + extra)
  const lead = (mark: Span | null): Span[] => [{ text: " " }, mark ?? { text: " ".repeat(o.markW) }, { text: " " }]
  const markCell = (text: string, fg: string, attr: number = A.NONE): Span => ({
    text: text + " ".repeat(Math.max(0, o.markW - width(text))),
    fg,
    attr,
  })
  switch (r.kind) {
    case "summary":
      return [...lead(r.first ? markCell("Δ", c.mark) : null), { text: r.text, fg: c.text }]
    case "error":
      return [...lead(r.first ? markCell("✗", c.error, A.BOLD) : null), { text: r.text, fg: c.status }]
    case "status":
      return [
        { text: " " },
        ...waitingRow(t, { mark: null, model: r.model, secs: r.secs, status: true, width: o.room - 1 }),
      ]
    case "block": {
      const pad = Math.max(1, o.room - 2 - o.markW - width(r.name) - width(r.counts))
      return [
        { text: o.sel ? "▌" : " ", fg: c.mark },
        markCell(superscript(r.at + 1), r.muted ? c.markStale : c.mark),
        { text: " " },
        {
          text: r.name,
          fg: r.removed ? c.status : c.text,
          attr: (r.removed ? A.STRIKE : A.NONE) | (o.sel ? A.BOLD : A.NONE),
        },
        { text: " ".repeat(pad) },
        { text: r.counts, fg: c.status },
      ]
    }
    case "note":
      return [{ text: indent() }, { text: r.text, fg: c.note }]
    case "gap":
      return [{ text: indent(2) }, { text: "…", fg: c.status }]
    case "rewritten":
      return [{ text: indent() }, { text: "rewritten · showing the new text", fg: c.status }]
    case "more":
      return [
        { text: indent() },
        ...sign(r.op, t),
        { text: ` … ${r.n} more line${r.n === 1 ? "" : "s"}`, fg: c.status },
      ]
    case "diff": {
      const body: Span[] = [
        ...(r.cutL ? [{ text: "…", fg: c.status }] : []),
        { text: r.text, fg: r.op === "+" ? c.text : c.status },
        ...(r.cutR ? [{ text: "…", fg: c.status }] : []),
      ]
      return [{ text: indent() }, ...sign(r.op, t), { text: " " }, ...body]
    }
  }
}

/** The diff sign: `−` in error, `+` in success, a blank for context. */
function sign(op: Op["op"], t: Theme): Span[] {
  if (op === " ") return [{ text: " " }]
  return [{ text: op === "-" ? "−" : "+", fg: op === "-" ? t.error : t.success }]
}
