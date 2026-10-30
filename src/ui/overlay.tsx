// Popups and the empty state: Overlay frames the picker, switcher, theme, open, help and zen popups and Welcome; the
// pure rows they draw live in rows.ts. All controlled by App.
import { MouseButton, type MouseEvent, RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import type { ReactNode } from "react"
import { type Span, safe, safeLine } from "../lib/spans"
import { spanWidth, width as sw, truncate, truncateLeft } from "../lib/text"
import { switchSplit } from "../notes/peek"
import type { OpenRow } from "../notes/projects"
import type { SwitchRow } from "../notes/vault"
import { contrastOn, type Theme } from "../theme/theme"
import {
  BOARD_MODES,
  boardFrames,
  boardHeader,
  boardLayout,
  boardSlot,
  FAMILIES,
  type FamilyHit,
  SLOT_W,
  type ThemeMode,
  type themeSplit,
} from "../theme/themepick"
import { chip, groupColor, keycaps } from "./chrome"
import { BODY_PAD, innerWidth, PANE_PAD, POPUP_INSET, popupWidth, ROW_PAD, ZEN_POPUP_W } from "./geometry"
import type { HelpLayout, HelpLine } from "./help"
import {
  artSpans,
  hitSpans,
  modeSwitch,
  openItem,
  type PickerItem,
  padTo,
  SWITCH_MODES,
  scrim,
  switchItem,
} from "./rows"
import { WORDMARK } from "./status"
import { artWidth, BIG, welcomeArt, welcomeFit } from "./welcome"
import type { ZenRow } from "./zen"

/** A single unwrapped row of spans (`app/Row.tsx` draws the document and panel through it); every span's text goes through `safe`. */
export function Line({ spans, bg }: { spans: Span[]; bg?: string }) {
  return (
    <text bg={bg} wrapMode="none" style={{ height: 1, flexShrink: 0 }}>
      {spans.map((s, i) => (
        <span key={i} fg={s.fg} bg={s.bg} attributes={s.attr ?? 0}>
          {safe(s.text)}
        </span>
      ))}
    </text>
  )
}

/**
 * The pointer's cell as of the last mouse event a `note` box saw, per renderer. After a render
 * OpenTUI hit-tests the resting pointer again and sends `over` to whatever is under it now — a row
 * redrawn as the highlight leaves it, or one scrolled under it — so an `over` at that same cell is
 * no movement and must not take the highlight back from the keys.
 */
const pointers = new WeakMap<object, { x: number; y: number }>()

export function usePointer() {
  const r = useRenderer()
  return {
    /**
     * Catch-all `onMouse` above the rows (App's roots, the popup): the pointer's own events set its
     * cell. Not `over`/`out`: a real move sends them first, already at the new cell.
     */
    note: (e: MouseEvent) => {
      if (e.type !== "over" && e.type !== "out") pointers.set(r, { x: e.x, y: e.y })
    },
    /** `over` event `e` came from the pointer moving onto the row */
    moved: (e: MouseEvent) => {
      const p = pointers.get(r)
      return !p || p.x !== e.x || p.y !== e.y
    },
  }
}

/**
 * Modal: dim full-screen backdrop, borderless backgroundPanel panel centered
 * by flex, padding 1 / gap 1, plain title on the left with a muted `esc` on the right.
 */
export function Overlay({
  t,
  W,
  H,
  width,
  title,
  note,
  onClose,
  onScroll,
  children,
}: {
  t: Theme
  W: number
  H: number
  width: number
  title: string
  note?: string
  /** left click on the backdrop */
  onClose?: () => void
  /** wheel anywhere over the panel, 1 = down */
  onScroll?: (dir: 1 | -1) => void
  children: ReactNode
}) {
  const wash = scrim(t)
  return (
    <box
      key="overlay"
      onMouseDown={(e: MouseEvent) => {
        if (e.button === MouseButton.LEFT) onClose?.()
      }}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: W,
        // centred above the footer hints and the progress line
        height: Math.max(1, H - 2),
        zIndex: 10,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        backgroundColor: RGBA.fromInts(wash.r, wash.g, wash.b, wash.a),
      }}
    >
      <OverlayPanel t={t} W={W} width={width} title={title} note={note} onScroll={onScroll}>
        {children}
      </OverlayPanel>
    </box>
  )
}

/** The popup box over the backdrop: its title bar, and the pointer and wheel events that stop short of App's root. */
function OverlayPanel({
  t,
  W,
  width,
  title,
  note,
  onScroll,
  children,
}: {
  t: Theme
  W: number
  width: number
  title: string
  note?: string
  onScroll?: (dir: 1 | -1) => void
  children: ReactNode
}) {
  const pointer = usePointer()
  return (
    <box
      onMouse={pointer.note} // down and the wheel stop here, short of App's root
      onMouseDown={(e: MouseEvent) => e.stopPropagation()}
      onMouseScroll={(e: MouseEvent) => {
        if (e.scroll?.direction === "up" || e.scroll?.direction === "down")
          onScroll?.(e.scroll.direction === "up" ? -1 : 1)
        e.stopPropagation()
      }}
      style={{
        width: popupWidth(W, width),
        flexShrink: 0,
        flexDirection: "column",
        backgroundColor: t.backgroundPanel,
        padding: 1,
        gap: 1,
      }}
    >
      <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 4, paddingRight: 4 }}>
        <text fg={t.text}>{title}</text>
        <text>
          {note ? <span fg={t.textMuted}>{note + "  "}</span> : null}
          <span fg={t.textMuted}>esc</span>
        </text>
      </box>
      {children}
    </box>
  )
}

/** The list box of PickerList and ThemeBoard: one cell of padding each side. */
const LIST_BOX = { flexDirection: "column", paddingLeft: 1, paddingRight: 1 } as const

/** A pickable row's frame, shared by PickerList and ThemeBoard: one line, 3 cells of padding, `bg` when highlighted. */
const rowBox = (bg: string | undefined) => ({
  height: 1,
  flexShrink: 0,
  paddingLeft: 3,
  paddingRight: 3,
  backgroundColor: bg,
})

/** The longest prefix of `text` within `room` columns, cut by code point and measuring each once. */
function cutTo(text: string, room: number): string {
  let w = 0
  let kept = ""
  for (const ch of text) {
    if ((w += sw(ch)) > room) break
    kept += ch
  }
  return kept
}

/** One picker row's spans within `textW` columns: the item's spans cut to leave room for `right`, a gap, then `right` muted. */
function pickerRowSpans(t: Theme, it: PickerItem, sel: boolean, fgOn: string, textW: number): Span[] {
  const right = it.right ?? ""
  const leftMax = textW - (right ? sw(right) + 1 : 0)
  const spans: Span[] = []
  let used = 0
  for (const s of it.spans) {
    const text = used + sw(s.text) > leftMax ? cutTo(s.text, leftMax - used) : s.text
    if (text) spans.push({ ...s, text, fg: sel ? fgOn : s.fg })
    used += sw(text)
  }
  spans.push({ text: " ".repeat(Math.max(0, textW - used - sw(right))) })
  if (right) spans.push({ text: right, fg: sel ? fgOn : t.textMuted })
  return spans
}

/** Rows with paddingX 3; the highlighted row is filled with `primary` and drawn in contrastOn(primary). */
export function PickerList({
  t,
  items,
  hl,
  top,
  height,
  innerW,
  empty = "No results found",
  onHover,
  onActivate,
}: {
  t: Theme
  items: PickerItem[]
  hl: number
  top: number
  height: number
  innerW: number
  empty?: string
  /** pointer moved onto row `i` */
  onHover?: (i: number) => void
  /** row `i` left-clicked: select it and act as Enter */
  onActivate?: (i: number) => void
}) {
  const fgOn = contrastOn(t.primary)
  const pointer = usePointer()
  const rows = items.slice(top, top + height)
  const textW = innerW - ROW_PAD
  return (
    <box key="picker-list" style={LIST_BOX}>
      {rows.map((it, j) => {
        const sel = top + j === hl && !it.header
        const spans = pickerRowSpans(t, it, sel, fgOn, textW)
        // a mark sits in the padding, a space between it and the text
        const markW = it.mark ? sw(it.mark.text) + 1 : 0
        if (it.mark) spans.unshift({ ...it.mark, fg: sel ? fgOn : it.mark.fg }, { text: " " })
        return (
          <box
            key={sel ? "sel" + j : "row" + j}
            onMouseOver={(e: MouseEvent) => !it.header && pointer.moved(e) && onHover?.(top + j)}
            onMouseDown={(e: MouseEvent) => {
              if (e.button === MouseButton.LEFT && !it.header) onActivate?.(top + j)
            }}
            style={{ ...rowBox(sel ? t.primary : undefined), paddingLeft: Math.max(0, 3 - markW) }}
          >
            <Line spans={spans} />
          </box>
        )
      })}
      {items.length === 0 ? (
        <box key="none" style={{ height: 1, paddingLeft: 3 }}>
          <text fg={t.textMuted}>{empty}</text>
        </box>
      ) : null}
    </box>
  )
}

/**
 * Search-input row with a muted placeholder and a primary cursor; on the right a muted `note` or
 * `right` segments, one cell apart. A left click on segment `i` calls `onRight(i)`.
 */
export function PickerInput({
  t,
  value,
  placeholder,
  note,
  right,
  onRight,
  width,
}: {
  t: Theme
  value: string
  placeholder: string
  note?: string
  right?: Span[][]
  onRight?: (i: number) => void
  width?: number
}) {
  // a long query shows its end, where the typing is; `width` is the popup's column count
  const rightW = right?.length
    ? right.reduce((n, seg) => n + seg.reduce((m, s) => m + sw(s.text), 0), right.length - 1)
    : 0
  const side = note ? sw(note) : rightW
  const room = width === undefined ? Infinity : width - POPUP_INSET - BODY_PAD - 1 - (side ? side + 1 : 0)
  const shown = safeLine(value)
  const rightBox = right?.length ? (
    <box style={{ flexDirection: "row", gap: 1, height: 1 }}>
      {right.map((seg, i) => (
        <box
          key={i}
          style={{ height: 1, flexShrink: 0 }}
          onMouseDown={(e: MouseEvent) => {
            if (e.button === MouseButton.LEFT) onRight?.(i)
          }}
        >
          <Line spans={seg} />
        </box>
      ))}
    </box>
  ) : null
  return (
    <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 4, paddingRight: 4, height: 1 }}>
      <text>
        {value ? (
          <span fg={t.textMuted}>{room === Infinity ? shown : truncateLeft(shown, Math.max(1, room))}</span>
        ) : null}
        <span fg={t.primary}>▏</span>
        {value ? null : <span fg={t.textMuted}>{placeholder}</span>}
      </text>
      {note ? <text fg={t.textMuted}>{note}</text> : rightBox}
    </box>
  )
}

/** Props every query popup (Switcher, OpenPicker, ThemePicker) takes: its place on screen, the query, the highlight and the pointer callbacks. */
interface PopupListProps {
  t: Theme
  W: number
  H: number
  q: string
  /** the highlighted row */
  hl: number
  /** the first row on screen */
  top: number
  onClose?: () => void
  onScroll?: (dir: 1 | -1) => void
  onHover?: (i: number) => void
  onActivate?: (i: number) => void
}

/**
 * List │ pane: `list` in a `listW` column, a `│` divider, then `lines` (cut to `rows`) in a `paneW` column. A
 * `paneBg` paints the pane on a candidate's background; `paneKey` keeps boxes that differ in style apart.
 */
function SplitPane({
  t,
  rows,
  listW,
  paneW,
  list,
  lines,
  paneKey,
  paneBg,
}: {
  t: Theme
  rows: number
  listW: number
  paneW: number
  list: ReactNode
  lines: Span[][]
  paneKey?: string
  paneBg?: string
}) {
  return (
    <box style={{ flexDirection: "row", height: rows }}>
      <box style={{ width: listW, flexShrink: 0 }}>{list}</box>
      <box style={{ width: 1, flexDirection: "column", flexShrink: 0 }}>
        {Array.from({ length: rows }, (_, i) => (
          <Line key={i} spans={[{ text: "│", fg: t.border }]} />
        ))}
      </box>
      <box
        key={paneKey}
        style={{
          width: paneW + PANE_PAD,
          flexDirection: "column",
          paddingLeft: 2,
          paddingRight: 4,
          flexShrink: 0,
          ...(paneBg ? { backgroundColor: paneBg } : {}),
        }}
      >
        {lines.slice(0, rows).map((spans, i) => (
          <Line key={i} spans={spans} />
        ))}
      </box>
    </box>
  )
}

/** `C-p` popup: the query and one list of sections (Notes / Headings / Text, or Recent); controlled by App. */
export function Switcher({
  t,
  W,
  H,
  title = "Go to",
  q,
  rows,
  hl,
  top,
  height,
  note,
  peek,
  onClose,
  onScroll,
  onHover,
  onActivate,
}: PopupListProps & {
  /** "Go to", or "Ask" for a `?` question */
  title?: string
  rows: SwitchRow[]
  height: number
  /** right of the title: indexing progress or the note count */
  note?: string
  /** peek pane rows for the highlighted row (`peekLines`); shown from PEEK_MIN_W columns */
  peek?: Span[][]
}) {
  const g = switchSplit(W)
  const lines = g.split ? peek : undefined
  const width = lines ? g.width : popupWidth(W)
  const listW = lines ? g.listW : innerWidth(width)
  const list = (
    <PickerList
      t={t}
      items={rows.map((r) => switchItem(r, t, listW - ROW_PAD))}
      hl={hl}
      top={top}
      height={height}
      innerW={listW}
      empty={q.trim() ? "No results found" : "Type a note, heading or text"}
      onHover={onHover}
      onActivate={onActivate}
    />
  )
  return (
    <Overlay t={t} W={W} H={H} width={width} title={title} note={note} onClose={onClose} onScroll={onScroll}>
      <PickerInput t={t} value={q} placeholder="Note, heading or text…" width={width} />
      {lines ? (
        <SplitPane key="split" t={t} rows={height} listW={listW} paneW={g.peekW} list={list} lines={lines} />
      ) : (
        list
      )}
    </Overlay>
  )
}

/** `o` popup: recent projects and, for a path-looking query, the folder's entries; controlled by App. */
export function OpenPicker({
  t,
  W,
  H,
  q,
  rows,
  hl,
  top,
  height,
  home,
  onClose,
  onScroll,
  onHover,
  onActivate,
}: PopupListProps & {
  rows: OpenRow[]
  height: number
  /** for `~` paths (tests pass a fake one) */
  home?: string
}) {
  const width = popupWidth(W)
  const paths = rows.some((r) => r.kind === "path")
  return (
    <Overlay
      t={t}
      W={W}
      H={H}
      width={width}
      title="Open"
      note={paths ? "tab completes" : undefined}
      onClose={onClose}
      onScroll={onScroll}
    >
      <PickerInput t={t} value={q} placeholder="Recent project, or a path: ~/ / ./" width={width} />
      <PickerList
        t={t}
        items={rows.map((r) => openItem(r, t, innerWidth(width) - ROW_PAD, home))}
        hl={hl}
        top={top}
        height={height}
        innerW={innerWidth(width)}
        empty={q.trim() ? "No results found" : "No recent projects · type a path: ~/ / ./"}
        onHover={onHover}
        onActivate={onActivate}
      />
    </Overlay>
  )
}

/** ThemeBoard's top row: the `dark` / `light` header, or the empty note. */
function BoardHead({
  t,
  L,
  shown,
  empty,
}: {
  t: Theme
  L: ReturnType<typeof boardLayout>
  shown: ThemeMode
  empty: boolean
}) {
  return empty ? (
    <box key="none" style={{ height: 1, paddingLeft: 3 }}>
      <text fg={t.textMuted}>No themes match</text>
    </box>
  ) : (
    <box key="head" style={{ height: 1, flexShrink: 0, paddingLeft: 3, paddingRight: 3 }}>
      <Line spans={boardHeader(t, shown, L)} />
    </box>
  )
}

/** One family row of ThemeBoard: the name with its hits and a clickable slot per mode. */
function BoardRow({
  t,
  L,
  h,
  sel,
  frames,
  pointer,
  onHover,
  onActivate,
  onPick,
}: {
  t: Theme
  L: ReturnType<typeof boardLayout>
  h: FamilyHit
  sel: boolean
  frames: ReturnType<typeof boardFrames>
  pointer: ReturnType<typeof usePointer>
  onHover: () => void
  onActivate: () => void
  onPick: (mode: ThemeMode) => void
}) {
  return (
    <box
      onMouseOver={(e: MouseEvent) => pointer.moved(e) && onHover()}
      onMouseDown={(e: MouseEvent) => {
        if (e.button === MouseButton.LEFT) onActivate()
      }}
      style={{ ...rowBox(sel ? t.backgroundElement : undefined), flexDirection: "row" }}
    >
      <box style={{ width: L.nameW, height: 1, flexShrink: 0 }}>
        <Line spans={hitSpans(h.family.name, h.hits, t.text, t.primary, sel)} />
      </box>
      {BOARD_MODES.map((m, k) => (
        <box
          key={m}
          style={{ width: SLOT_W, height: 1, flexShrink: 0, marginLeft: k ? L.gap : 0 }}
          onMouseDown={(e: MouseEvent) => {
            if (e.button !== MouseButton.LEFT) return
            pointer.note(e)
            e.stopPropagation() // a missing mode is not a theme: its struck word does nothing
            if (h.family[m]) onPick(m)
          }}
        >
          <Line spans={boardSlot(t, h.family[m], m, frames[m])} />
        </box>
      ))}
    </box>
  )
}

/**
 * The `t` picker's list as a board: a header (`dark` / `light` over their slots), then one row per family,
 * its name with the hits and a slot per mode (`boardSlot`: a specimen in that theme's own roles, or the
 * missing mode struck through). The highlighted row is tinted backgroundElement with its name bold, and
 * its shown theme framed in primary; the theme in use keeps a thin muted frame. Rows are PickerList's
 * (padding 1, then 3); hovering a row picks it, a click on a slot picks that theme (`onPick`; a missing
 * mode's slot does nothing), elsewhere on the row applies the row as it is (`onActivate`).
 */
export function ThemeBoard({
  t,
  rows,
  hl,
  top,
  height,
  innerW,
  mode,
  shown,
  orig,
  onHover,
  onActivate,
  onPick,
}: {
  t: Theme
  rows: FamilyHit[]
  hl: number
  top: number
  /** family rows below the header */
  height: number
  innerW: number
  /** the mode asked for */
  mode: ThemeMode
  /** the candidate's mode: the header's primary word */
  shown: ThemeMode
  /** the theme in use */
  orig: string
  onHover?: (i: number) => void
  onActivate?: (i: number) => void
  onPick?: (i: number, mode: ThemeMode) => void
}) {
  const L = boardLayout(innerW - ROW_PAD)
  const pointer = usePointer()
  return (
    <box key="theme-board" style={LIST_BOX}>
      <BoardHead t={t} L={L} shown={shown} empty={!rows.length} />
      {rows.slice(top, top + height).map((h, j) => {
        const i = top + j
        const sel = i === hl
        return (
          <BoardRow
            key={sel ? "sel" + j : "row" + j}
            t={t}
            L={L}
            h={h}
            sel={sel}
            frames={boardFrames(h.family, mode, orig, sel)}
            pointer={pointer}
            onHover={() => onHover?.(i)}
            onActivate={() => onActivate?.(i)}
            onPick={(m) => onPick?.(i, m)}
          />
        )
      })}
    </box>
  )
}

/**
 * `t` popup: the query with the dark/light switch, the board (`ThemeBoard`: a dark and a light specimen
 * per family) and with `geo.split` a pane that draws the candidate's sample on its own background. The
 * chrome stays in `t`, the app's theme: only the specimens and the pane paint candidates' roles. A click
 * on a chip sets that mode (`onMode`), on a specimen applies that theme (`onPick`). Controlled by App.
 */
export function ThemePicker({
  t,
  W,
  H,
  q,
  rows,
  hl,
  top,
  mode,
  shown = mode,
  only,
  orig,
  geo,
  pane,
  onClose,
  onScroll,
  onHover,
  onActivate,
  onPick,
  onMode,
}: PopupListProps & {
  rows: FamilyHit[]
  /** the highlighted row, -1 for none */
  hl: number
  /** the board's first row on screen (`pickTop`) */
  top: number
  /** the mode asked for: where each row's cursor would sit (`boardFrames`) */
  mode: ThemeMode
  /** the candidate's mode, active on the switch (`pickShown`) */
  shown?: ThemeMode
  /** the highlighted family's only mode: the switch does nothing */
  only?: ThemeMode
  /** the theme in use (its thin frame) */
  orig: string
  geo: ReturnType<typeof themeSplit>
  /** the candidate and its rows (`paneLines`); drawn only with `geo.split` */
  pane?: { theme: Theme; lines: Span[][] }
  /** a click on row `i`'s slot for `mode`: that theme, applied */
  onPick?: (i: number, mode: ThemeMode) => void
  onMode?: (mode: ThemeMode) => void
}) {
  const note = q.trim() ? `${rows.length} of ${FAMILIES.length}` : `${FAMILIES.length} families`
  // the header takes a row; below PEEK_MIN_W the popup shrinks to the rows there are
  const height = Math.max(1, geo.rows - 1)
  const list = (
    <ThemeBoard
      t={t}
      rows={rows}
      hl={hl}
      top={top}
      height={height}
      innerW={geo.listW}
      mode={mode}
      shown={shown}
      orig={orig}
      onHover={onHover}
      onActivate={onActivate}
      onPick={onPick}
    />
  )
  return (
    <Overlay t={t} W={W} H={H} width={geo.width} title="Themes" note={note} onClose={onClose} onScroll={onScroll}>
      <PickerInput
        t={t}
        value={q}
        placeholder="Theme…"
        right={modeSwitch(t, shown, only)}
        onRight={(i) => !only && onMode?.(SWITCH_MODES[i]!)}
        width={geo.width}
      />
      {geo.split ? (
        <SplitPane
          key="split"
          t={t}
          rows={geo.rows}
          listW={geo.listW}
          paneW={geo.peekW}
          list={list}
          lines={pane?.lines ?? []}
          paneKey={pane ? "pane" : "pane-none"}
          paneBg={pane?.theme.background}
        />
      ) : (
        list
      )}
    </Overlay>
  )
}

const ZEN_LABEL_W = 16

/** `Z` popup: one row per zen setting, label left and value right of it; controlled by App. */
export function ZenSettings({
  t,
  W,
  H,
  rows,
  cursor,
  onClose,
  onHover,
  onActivate,
}: {
  t: Theme
  W: number
  H: number
  rows: ZenRow[]
  cursor: number
  /** backdrop click: revert */
  onClose?: () => void
  onHover?: (i: number) => void
  /** row `i` clicked: move there and toggle it */
  onActivate?: (i: number) => void
}) {
  const width = popupWidth(W, ZEN_POPUP_W)
  return (
    <Overlay t={t} W={W} H={H} width={width} title="Zen settings" note="⏎ save" onClose={onClose}>
      <PickerList
        t={t}
        items={rows.map((r) => ({
          spans: [
            { text: r.label.padEnd(ZEN_LABEL_W), fg: r.disabled ? t.textMuted : t.text },
            { text: r.value, fg: r.disabled ? t.textMuted : t.secondary },
          ],
        }))}
        hl={cursor}
        top={0}
        height={rows.length}
        innerW={innerWidth(width)}
        onHover={onHover}
        onActivate={onActivate}
      />
    </Overlay>
  )
}

/** One column cell, 1 + `colW` wide: the lead cell holds a chip's left padding, so chips and keys share an edge. */
function helpCell(t: Theme, l: HelpLine | undefined, { colW, keyW }: HelpLayout): Span[] {
  if (!l) return padTo([], 1 + colW)
  if (l.kind === "chip") return padTo(chip(t, l.title, groupColor(t, l.title)), 1 + colW)
  const keys = truncate(l.keys, keyW - 1)
  return padTo(
    [
      { text: " " + keys + " ".repeat(keyW - sw(keys)), fg: t.text },
      { text: truncate(l.desc, colW - keyW), fg: t.textMuted },
    ],
    1 + colW,
  )
}

/** `? ?`: the keys sheet with role chips per group and, from 100 columns, two columns; App owns `top`. */
export function HelpSheet({
  t,
  W,
  H,
  layout,
  top,
  title,
  note,
  onClose,
  onScroll,
}: {
  t: Theme
  W: number
  H: number
  layout: HelpLayout
  top: number
  title: string
  note?: string
  onClose?: () => void
  onScroll?: (dir: 1 | -1) => void
}) {
  return (
    <Overlay t={t} W={W} H={H} width={layout.width} title={title} note={note} onClose={onClose} onScroll={onScroll}>
      <box key="help-body" style={{ flexDirection: "column", paddingLeft: 3, paddingRight: 4 }}>
        {layout.mark
          ? [
              ...WORDMARK.map((l, i) => <Line key={"wm" + i} spans={[{ text: " " + l, fg: t.primary }]} />),
              <Line key="wm-gap" spans={[]} />,
            ]
          : null}
        {Array.from({ length: layout.vis }, (_, i) => (
          <Line
            key={i}
            spans={layout.cols.flatMap((c, k) => [...(k ? [{ text: "   " }] : []), ...helpCell(t, c[top + i], layout)])}
          />
        ))}
      </box>
    </Overlay>
  )
}

/** The widest the welcome page's recent-projects list gets. */
const RECENT_W = 58

/**
 * The empty state (no Markdown files): the wordmark over a bowl with steam rising off the broth, the message,
 * keycap actions, recent projects as `o` picker rows (pointing selects, a click opens) and the hint row.
 * Blocks drop as the area shrinks (`welcomeFit`); App owns the selection, the steam tick and the ink step.
 */
export function Welcome({
  t,
  CW,
  CH,
  root,
  recents,
  hl,
  tick,
  ink,
  keys,
  home,
  onHover,
  onActivate,
}: {
  t: Theme
  CW: number
  CH: number
  root: string
  /** the `o` picker's rows for the recent projects, header first */
  recents: OpenRow[]
  /** highlighted row of `recents` */
  hl: number
  tick: number
  /** ink-in step, 0–3 (3: inked) */
  ink: number
  /** [key, word] actions */
  keys: [string, string][]
  home?: string
  onHover?: (i: number) => void
  onActivate?: (i: number) => void
}) {
  const fit = welcomeFit(CW, CH, recents.filter((r) => r.kind === "recent").length)
  const centre = (spans: Span[]): Span[] => [
    { text: " ".repeat(Math.max(0, Math.floor((CW - spanWidth(spans)) / 2))) },
    ...spans,
  ]
  const rows: ReactNode[] = []
  const line = (spans: Span[]) => rows.push(<Line key={rows.length} spans={spans} />)
  for (let i = 0; i < fit.top; i++) line([])
  if (fit.mark) {
    const art = welcomeArt(fit.size, tick, { steam: fit.steam, bowl: fit.bowl })
    const x = Math.max(0, (CW >> 1) - (artWidth(fit.size) >> 1))
    for (const r of art) line([{ text: " ".repeat(x) }, ...artSpans(t, r, ink)])
    line([])
  }
  line(centre([{ text: truncate(`No Markdown files found in ${safeLine(root)}`, CW), fg: t.textMuted }]))
  line([])
  line(centre(keycaps(t, keys)))
  const FW = Math.min(RECENT_W, CW - 2)
  const fx = Math.max(0, Math.floor((CW - FW) / 2))
  const innerW = FW + 2 // PickerList pads one cell each side of the rows
  const list = fit.recents ? recents.slice(0, 1 + fit.recents) : []
  if (list.length) {
    line([])
    rows.push(
      <box
        key="recent"
        style={{ flexDirection: "column", alignItems: "flex-start", flexShrink: 0, paddingLeft: Math.max(0, fx - 1) }}
      >
        <PickerList
          t={t}
          items={list.map((r) => openItem(r, t, innerW - ROW_PAD, home))}
          hl={hl}
          top={0}
          height={list.length}
          innerW={innerW}
          onHover={onHover}
          onActivate={onActivate}
        />
      </box>,
    )
  }
  if (fit.hint) {
    if ((fit.size === BIG && fit.bowl) || !list.length) line([])
    const hint: [string, string][] = [
      ...(list.length ? [["⏎", "open"] as [string, string]] : []),
      ["o", "all projects or a path"],
    ]
    const spans = hint.flatMap(([k, w], i): Span[] => [
      ...(i ? [{ text: "   " }] : []),
      { text: k, fg: t.text },
      { text: " " + w, fg: t.textMuted },
    ])
    line(list.length ? [{ text: " ".repeat(fx + 3) }, ...spans] : centre(spans))
  }
  return (
    <box key="empty" style={{ flexDirection: "column" }}>
      {rows}
    </box>
  )
}
