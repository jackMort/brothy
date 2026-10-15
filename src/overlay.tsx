import { MouseButton, RGBA, type MouseEvent } from "@opentui/core"
import { basename, dirname } from "node:path"
import type { ReactNode } from "react"
import { contrastOn, type Theme } from "./theme"
import { A, width as sw, type Span } from "./markdown"
import { safe, safeLine } from "./spans"
import { truncate, truncateLeft } from "./status"
import { stem } from "./files"
import { tildify, type OpenRow } from "./projects"
import type { SwitchRow } from "./vault"
import type { ZenRow } from "./zen"

function Line({ spans }: { spans: Span[] }) {
  return (
    <text wrapMode="none" style={{ height: 1, flexShrink: 0 }}>
      {spans.map((s, i) => (
        <span key={i} fg={s.fg} bg={s.bg} attributes={s.attr ?? 0}>
          {safe(s.text)}
        </span>
      ))}
    </text>
  )
}

/** Wash drawn over the page behind a popup: black over dark themes, white over light ones. */
export function scrim(t: Theme): { r: number; g: number; b: number; a: number } {
  return t.mode === "light" ? { r: 255, g: 255, b: 255, a: 170 } : { r: 0, g: 0, b: 0, a: 150 }
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
      <box
        onMouseDown={(e: MouseEvent) => e.stopPropagation()}
        onMouseScroll={(e: MouseEvent) => {
          if (e.scroll?.direction === "up" || e.scroll?.direction === "down") onScroll?.(e.scroll.direction === "up" ? -1 : 1)
          e.stopPropagation()
        }}
        style={{
          width: Math.min(width, W - 2),
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
    </box>
  )
}

export interface PickerItem {
  spans: Span[]
  /** right-aligned muted text */
  right?: string
  /** a section title: never highlighted, hovered or activated */
  header?: boolean
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
  const rows = items.slice(top, top + height)
  const textW = innerW - 8
  return (
    <box key="picker-list" style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
      {rows.map((it, j) => {
        const sel = top + j === hl && !it.header
        const right = it.right ?? ""
        const leftMax = textW - (right ? sw(right) + 1 : 0)
        const spans: Span[] = []
        let used = 0
        for (const s of it.spans) {
          let text = s.text
          while (text && used + sw(text) > leftMax) text = text.slice(0, -1)
          if (text) spans.push({ ...s, text, fg: sel ? fgOn : s.fg })
          used += sw(text)
        }
        spans.push({ text: " ".repeat(Math.max(0, textW - used - sw(right))) })
        if (right) spans.push({ text: right, fg: sel ? fgOn : t.textMuted })
        return (
          <box
            key={sel ? "sel" + j : "row" + j}
            onMouseOver={() => !it.header && onHover?.(top + j)}
            onMouseDown={(e: MouseEvent) => {
              if (e.button === MouseButton.LEFT && !it.header) onActivate?.(top + j)
            }}
            style={{ height: 1, flexShrink: 0, paddingLeft: 3, paddingRight: 3, backgroundColor: sel ? t.primary : undefined }}
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

/** Search-input row with a muted placeholder and a primary cursor. */
export function PickerInput({ t, value, placeholder, note, width }: { t: Theme; value: string; placeholder: string; note?: string; width?: number }) {
  // a long query shows its end, where the typing is; `width` is the popup's column count
  const room = width === undefined ? Infinity : width - 2 - 8 - 1 - (note ? sw(note) + 1 : 0)
  const shown = safeLine(value)
  return (
    <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 4, paddingRight: 4, height: 1 }}>
      <text>
        {value ? <span fg={t.textMuted}>{room === Infinity ? shown : truncateLeft(shown, Math.max(1, room))}</span> : null}
        <span fg={t.primary}>▏</span>
        {value ? null : <span fg={t.textMuted}>{placeholder}</span>}
      </text>
      {note ? <text fg={t.textMuted}>{note}</text> : null}
    </box>
  )
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
  const ws = cps.map((c) => sw(c))
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
  const folder = r.kind === "text" ? "" : truncateLeft(r.folder, Math.floor(w / 3))
  const room = w - (folder ? sw(folder) + 1 : 0)
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
        spans: [...hitSpans(short, [], t.text, t.primary), { text: "  ← ", fg: t.textMuted }, ...fit(r.alias.text, r.alias.hits, sw(short) + 4, t.textMuted)],
        right: folder,
      }
    }
    case "heading":
      return { spans: [{ text: name + " › ", fg: t.textMuted }, ...fit(r.text, r.hits, sw(name) + 3, t.text)], right: folder }
    case "text":
      return { spans: [{ text: name + "  ", fg: t.text }, ...fit(r.context, r.hits, sw(name) + 2, t.textMuted)] }
  }
}

/** `C-p` popup: the query and one list of sections (Notes / Headings / Text, or Recent); controlled by App. */
export function Switcher({
  t,
  W,
  H,
  q,
  rows,
  hl,
  top,
  height,
  note,
  onClose,
  onScroll,
  onHover,
  onActivate,
}: {
  t: Theme
  W: number
  H: number
  q: string
  rows: SwitchRow[]
  hl: number
  top: number
  height: number
  /** right of the title: indexing progress or the note count */
  note?: string
  onClose?: () => void
  onScroll?: (dir: 1 | -1) => void
  onHover?: (i: number) => void
  onActivate?: (i: number) => void
}) {
  const width = Math.min(70, W - 2)
  return (
    <Overlay t={t} W={W} H={H} width={width} title="Go to" note={note} onClose={onClose} onScroll={onScroll}>
      <PickerInput t={t} value={q} placeholder="Note, heading or text…" width={width} />
      <PickerList
        t={t}
        items={rows.map((r) => switchItem(r, t, width - 10))}
        hl={hl}
        top={top}
        height={height}
        innerW={width - 2}
        empty={q.trim() ? "No results found" : "Type a note, heading or text"}
        onHover={onHover}
        onActivate={onActivate}
      />
    </Overlay>
  )
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
  const room = w - (right ? sw(right) + 1 : 0) - sw(name.text) - 2
  // a path too long for the row drops its last segment (the name, already shown), then cuts from the left
  const full = tildify(r.entry.root, home)
  const path = sw(full) <= room ? full : room >= 6 ? truncateLeft(tildify(dirname(r.entry.root), home), room) : ""
  return {
    spans: [...hitSpans(name.text, name.hits, r.missing ? t.textMuted : t.text, t.primary), ...(path ? [{ text: "  " + path, fg: t.textMuted }] : [])],
    right,
  }
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
}: {
  t: Theme
  W: number
  H: number
  q: string
  rows: OpenRow[]
  hl: number
  top: number
  height: number
  /** for `~` paths (tests pass a fake one) */
  home?: string
  onClose?: () => void
  onScroll?: (dir: 1 | -1) => void
  onHover?: (i: number) => void
  onActivate?: (i: number) => void
}) {
  const width = Math.min(70, W - 2)
  const paths = rows.some((r) => r.kind === "path")
  return (
    <Overlay t={t} W={W} H={H} width={width} title="Open" note={paths ? "tab completes" : undefined} onClose={onClose} onScroll={onScroll}>
      <PickerInput t={t} value={q} placeholder="Recent project, or a path: ~/ / ./" width={width} />
      <PickerList
        t={t}
        items={rows.map((r) => openItem(r, t, width - 10, home))}
        hl={hl}
        top={top}
        height={height}
        innerW={width - 2}
        empty={q.trim() ? "No results found" : "No recent projects · type a path: ~/ / ./"}
        onHover={onHover}
        onActivate={onActivate}
      />
    </Overlay>
  )
}

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
  const width = Math.min(52, W - 2)
  return (
    <Overlay t={t} W={W} H={H} width={width} title="Zen settings" note="⏎ save" onClose={onClose}>
      <PickerList
        t={t}
        items={rows.map((r) => ({
          spans: [
            { text: r.label.padEnd(16), fg: r.disabled ? t.textMuted : t.text },
            { text: r.value, fg: r.disabled ? t.textMuted : t.secondary },
          ],
        }))}
        hl={cursor}
        top={0}
        height={rows.length}
        innerW={width - 2}
        onHover={onHover}
        onActivate={onActivate}
      />
    </Overlay>
  )
}
