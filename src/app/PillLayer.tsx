// The chat pill over the note: a clear band, the pill, the card above it and the `[[` list; clicks, hover and the wheel.
// Not pure: drawn from the app context, the rows from ui/pill.ts. Every cell sets its background (an image may lie under
// it). The pill's, the card's and the list's handlers stop the event short of the document's (which would scroll the
// page, or take a press for a picture row), so they record the pointer themselves.
import { MouseButton, type MouseEvent } from "@opentui/core"
import type { ReactNode } from "react"
import { type Span, safeLine } from "../lib/spans"
import { truncate } from "../lib/text"
import { surface } from "../theme/theme"
import {
  CHAT_DIM,
  cardFoot,
  cardWindow,
  caretCol,
  frameRows,
  PICK_W,
  type PillView,
  pickRows,
  pillBorder,
  pillRow,
  sizeFoot,
} from "../ui/pill"
import { dimSpans } from "../ui/zen"
import type { Derived } from "./derive"
import type { Pill } from "./pill"
import { Row } from "./Row"
import { WHEEL_ROWS } from "./store"

/** What the layer acts with: the pill's mouse actions and the pointer (`usePointer`). */
export type PillActions = Pick<Pill, "pillOpen" | "citeGo" | "pillScroll" | "pillHover"> & {
  moved: (e: MouseEvent) => boolean
  note: (e: MouseEvent) => void
}
interface Handlers {
  onMouseDown?: (e: MouseEvent) => void
  onMouseScroll?: (e: MouseEvent) => void
  onMouseOver?: (e: MouseEvent) => void
}

/** The band's rows: the pill's 3 and the clear row above it, from the gutter's 3 columns across the text column. */
const BAND_ROWS = 4
const GUTTER = 3

/** Rows as an absolutely placed box at (`left`, `top`), `w` wide. */
function block(key: string, left: number, top: number, w: number, rows: Span[][], on: Handlers = {}): ReactNode {
  return (
    <box key={key} style={{ position: "absolute", left, top, width: w, height: rows.length }} {...on}>
      {rows.map((r, i) => (
        <Row key={i} spans={r} />
      ))}
    </box>
  )
}

/** `f` as a handler that keeps the event to this box: the pointer recorded, the document's handlers never reached. */
const own =
  (a: PillActions, f: (e: MouseEvent) => void = () => {}) =>
  (e: MouseEvent) => {
    a.note(e)
    e.stopPropagation()
    f(e)
  }

/** The pill, its card and the `[[` list over the note's rows; nothing while hidden. */
export function pillLayer(d: Derived, a: PillActions): ReactNode[] {
  const v = d.pill
  if (!v) return []
  return [bandBlock(d, v), pillBlock(d, v, a), cardBlock(d, v, a), pickBlock(d, v, a)].filter((n) => n !== null)
}

/**
 * The band: the pill's rows and the row above it, the gutter's 3 columns included, on the page's own fill (clear with
 * `T`). The note draws no text there (`noteLines` stops above it); the band keeps whatever else lies under it out.
 */
function bandBlock({ L, t, s }: Derived, v: PillView): ReactNode {
  const w = L.CW + GUTTER
  const bg = surface(t, s.transparent).main
  const rows = Array.from({ length: BAND_ROWS }, () => [{ text: " ".repeat(w), bg }])
  return block("chat-band", -GUTTER, v.geo.top - 1, w, rows)
}

/** The pill: the wisp and the input (or the folded cite), the chips, what `⏎` would send on its bottom border. */
function pillBlock({ t, s }: Derived, v: PillView, a: PillActions): ReactNode {
  const now = Date.now()
  const foot = v.land ? undefined : sizeFoot(t, v.size)
  const rows = frameRows(
    [pillRow(t, v, now, s.motion)],
    v.geo.w,
    pillBorder(t, v, now, s.motion),
    t.backgroundPanel,
    foot,
  )
  // folded on a cite, a click brings the card back
  const open = (e: MouseEvent) => e.button === MouseButton.LEFT && !v.focus && a.pillOpen()
  return block("chat-pill", v.geo.x, v.geo.top, v.geo.w, rows, { onMouseDown: own(a, open) })
}

/** The card above the pill, one clear row between: the window of its rows, its cites clickable, the wheel scrolls it. */
function cardBlock({ t }: Derived, v: PillView, a: PillActions): ReactNode {
  const out = v.card ? v.cardOut : null
  if (!out) return null
  // cardMax is the card's whole height: its window is that less the two border rows
  const win = cardWindow(out.rows, v.geo.cardMax - 2, v.top)
  const border = v.thread.turns.at(-1)?.error ? t.error : t.border
  const rows = frameRows(win.rows, v.geo.w, border, t.backgroundPanel, cardFoot(t, win.below))
  /** the cite whose row is under the pointer (the box's first row is its top border) */
  const citeAt = (e: MouseEvent) => {
    const row = e.y - (e.currentTarget?.screenY ?? 0) - 1 + win.top
    return out.stops.find((st) => st.row === row)?.cite
  }
  return block("chat-card", v.geo.x, v.geo.top - 1 - rows.length, v.geo.w, rows, {
    onMouseDown: own(a, (e) => {
      const at = e.button === MouseButton.LEFT ? citeAt(e) : undefined
      if (at) a.citeGo(at)
    }),
    // the re-check `over` after a render is no move: the keys keep their selection (CLAUDE.md gotchas)
    onMouseOver: (e) => {
      const at = a.moved(e) ? citeAt(e) : undefined
      if (at) a.pillHover(at)
    },
    onMouseScroll: own(a, (e) => a.pillScroll(e.scroll?.direction === "up" ? -1 : 1, WHEEL_ROWS)),
  })
}

/**
 * The `[[` list above the caret, its bottom border on the clear row over the pill; a press on it stays there. Its names
 * start under the `[[` (the mockup's place), so the list holds still while the query is typed.
 */
function pickBlock({ t, L }: Derived, v: PillView, a: PillActions): ReactNode {
  if (!v.pick?.items.length) return null
  const rows = frameRows(pickRows(t, v.pick.items, v.pick.hl), PICK_W, t.border, t.backgroundPanel)
  const at = caretCol(t, { ...v, input: v.input.slice(0, v.input.lastIndexOf("[[")) })
  const left = Math.max(0, Math.min(at - 2, L.CW - PICK_W))
  return block("chat-pick", left, v.geo.top - rows.length, PICK_W, rows, { onMouseDown: own(a) })
}

/** With the card up no image draws: each picture drawn as pixels on screen gets `▣ <alt>` muted, dimmed with the page, at its first visible reserved row above `rows`. */
export function pictureAlts({ t, view, top, L, picMode }: Derived, rows: number): ReactNode[] {
  if (picMode !== "pixels") return []
  return (view.pics ?? []).flatMap((p) => {
    const y = Math.max(p.line, top) - top
    if (p.problem || p.line + p.rows <= top || y >= rows) return []
    const text = `▣ ${truncate(safeLine(p.alt), Math.max(1, L.CW - p.left - 2))}`
    return [
      <box
        key={`pic-alt-${p.id}`}
        style={{ position: "absolute", left: p.left, top: y, width: L.CW - p.left, height: 1 }}
      >
        <Row spans={dimSpans([{ text, fg: t.textMuted }], t, CHAT_DIM)} />
      </box>,
    ]
  })
}
