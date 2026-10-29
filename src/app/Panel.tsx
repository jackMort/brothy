// The side panel: tab strip, rule, filter row and the Files / Outline / Info list, inline or as a drawer.
// Not pure: drawn from the app context, and it writes the Outline and Info list tops (and `infoSeen`) back to the store
// as it draws, so App calls it once per render, before its too-small return. Row spans come from panel.ts.

import { dirname } from "node:path"
import { MouseButton, type MouseEvent } from "@opentui/core"
import type { ReactNode } from "react"
import type { Span } from "../lib/spans"
import { fmtNum, spanWidth, truncate, truncateLeft, width, wrap } from "../lib/text"
import { folderCounts, folderOf, stem } from "../notes/files"
import type { View } from "../system/config"
import { contrastOn, mix, surface } from "../theme/theme"
import { keepVisible, stripLayout, thumb } from "../ui/nav"
import { fileRowSpans, infoSpans, outlineRowSpans } from "../ui/panel"
import type { AppCtx } from "./ctx"
import type { Derived } from "./derive"
import type { Links } from "./links"
import { Row } from "./Row"
import { MAX_DEPTH, WHEEL_ROWS } from "./store"

/** What the panel's clicks do beyond the context: jump to a heading or a change, follow a link. */
export interface PanelActions extends Pick<Links, "openLink"> {
  /** scroll the document to heading `i` of the shown view */
  outlineGo: (i: number) => void
  /** scroll to change `at` of the Changed block */
  jumpChange: (at: number) => void
}

/** What the panel's rows are drawn with: the context, this render's derived data, the panel width and the row helpers. */
interface PanelKit {
  c: AppCtx
  d: Derived
  /** panel width: col 0 padding, text, then the scroll thumb column */
  PNW: number
  /** text columns: col 0 is padding, the last column is kept for the scroll thumb */
  AW: number
  /** One panel row, `PNW` wide: col 0 padding (`lead`), text, then the thumb column. `sel` fills the row as the cursor. */
  panelRow: (key: string, spans: Span[], o?: { sel?: boolean; lead?: boolean; thumb?: boolean; onDown?: (e: MouseEvent) => void }) => ReactNode
  /** Which visible list rows (0 = first) carry the scroll thumb. */
  thumbRows: (top: number, n: number) => (i: number) => boolean
  /** view `v`'s saved list top, clamped for `n` rows */
  topOf: (v: View, n: number) => number
}

/** The row helpers over this render's panel width, theme and list height. */
function panelKit(c: AppCtx, d: Derived): PanelKit {
  const { s, L, t, LH } = d
  const selFg = contrastOn(t.primary)
  const PNW = L.PNW
  const AW = PNW - 2
  const thumbFg = mix(t.borderSubtle, t.textMuted, 0.25)
  const panelRow: PanelKit["panelRow"] = (key, spans, o = {}) => {
    const body: Span[] = o.lead === false ? [...spans] : [{ text: " " }, ...spans]
    body.push({ text: " ".repeat(Math.max(0, PNW - 1 - spanWidth(body))) })
    const cells = o.sel ? body.map((sp) => ({ ...sp, fg: selFg, bg: t.primary })) : body
    cells.push({ text: o.thumb ? "▐" : " ", fg: thumbFg })
    return (
      <box key={key} style={{ height: 1, flexShrink: 0 }} onMouseDown={o.onDown}>
        <Row spans={cells} />
      </box>
    )
  }
  const thumbRows = (top: number, n: number) => {
    const th = thumb(top, LH, n)
    return (i: number) => !!th && i >= th.start && i < th.start + th.size
  }
  const topOf = (v: View, n: number) => Math.max(0, Math.min(s.listTop[v], n - LH))
  return { c, d, PNW, AW, panelRow, thumbRows, topOf }
}

/** The tab strip (a click focuses the tab under it) and the rule under it, heavy below the active tab. */
function stripRows({ c, d, PNW, panelRow }: PanelKit): ReactNode[] {
  const { s, L, t, sideFocus } = d
  // the strip's compact/full choice follows the inline panel width (SW), also in the wider drawer
  const strip = stripLayout(L.SW, c.panelViews())
  const stripSpans: Span[] = []
  for (const lb of strip.labels) {
    const at = 1 + spanWidth(stripSpans) // panelRow adds col 0
    if (lb.x0 > at) stripSpans.push({ text: " ".repeat(lb.x0 - at) })
    stripSpans.push({ text: lb.digit, fg: t.textMuted })
    const active = lb.view === s.view
    stripSpans.push({ text: lb.text, fg: active ? (sideFocus ? t.primary : t.text) : t.textMuted, attr: active ? 1 : 0 })
  }
  const activeLabel = strip.labels.find((lb) => lb.view === s.view) ?? strip.labels[0]!
  const stripRule: Span[] = [
    { text: "─".repeat(activeLabel.lx), fg: t.border },
    { text: "━".repeat(activeLabel.x1 - activeLabel.lx), fg: sideFocus ? t.accent : t.textMuted },
    { text: "─".repeat(Math.max(0, PNW - 1 - activeLabel.x1)), fg: t.border },
  ]
  const panelX = L.inline ? 1 : 0
  const onStrip = (e: MouseEvent) => {
    if (e.button !== MouseButton.LEFT) return
    const x = e.x - panelX
    const lb = strip.labels.find((l) => x >= l.x0 && x < l.x1)
    if (lb) c.focusPanel(lb.view)
  }
  return [panelRow("strip", stripSpans, { onDown: onStrip }), panelRow("rule", stripRule, { lead: false })]
}

/** The Files list: one row per visible tree row (a click focuses, toggles a folder, opens a note), then the scan's notes. */
function filesList({ c, d, AW, panelRow, thumbRows, topOf }: PanelKit): ReactNode[] {
  const { focusPanel, toggleDir, selectRow } = c
  const { s, t, rows, LH, note, sideFocus } = d
  const listEls: ReactNode[] = []
  const fTop = topOf("files", rows.length)
  if (rows.length === 0) listEls.push(panelRow("files-empty", [{ text: s.filter ? "no matching notes" : "no Markdown files here", fg: t.textMuted }]))
  const counts = folderCounts(s.tree)
  const on = thumbRows(fTop, rows.length)
  rows.slice(fTop, fTop + LH).forEach((r, i) => {
    const idx = fTop + i
    const n = r.node
    const spans = fileRowSpans(r, { t, cols: AW, open: s.openPath, expanded: s.expanded, counts, maxDepth: MAX_DEPTH })
    listEls.push(
      panelRow(n.path, spans, {
        sel: sideFocus === "files" && idx === s.cursor,
        thumb: on(i),
        onDown: (e) => {
          if (e.button !== MouseButton.LEFT) return
          focusPanel()
          if (n.dir) toggleDir(n)
          selectRow(idx, "now")
        },
      }),
    )
  })
  note.forEach((text, i) => listEls.push(panelRow(`files-truncated-${i}`, [{ text: truncate(text, AW), fg: t.warning }])))
  return listEls
}

/** The Outline list; it writes its list top back to the store. */
function outlineList({ d, AW, panelRow, thumbRows }: PanelKit, { outlineGo }: PanelActions): ReactNode[] {
  const { s, t, LH, sideFocus, outlineCur } = d
  const listEls: ReactNode[] = []
  const n = d.oRows.length
  if (!s.openPath) listEls.push(panelRow("outline-empty", [{ text: "no note open", fg: t.textMuted }]))
  else if (!n) listEls.push(panelRow("outline-empty", [{ text: s.outlineFilter ? "no matching headings" : "no headings", fg: t.textMuted }]))
  // unfocused, the list keeps the reading heading in view; focused, the cursor
  const reading = Math.max(
    0,
    d.oRows.findIndex((r) => r.current),
  )
  const oTop = keepVisible(s.listTop.outline, sideFocus === "outline" ? outlineCur : reading, LH, n)
  s.listTop.outline = oTop
  const on = thumbRows(oTop, n)
  d.oRows.slice(oTop, oTop + LH).forEach((r, i) => {
    listEls.push(
      panelRow(`o-${r.index}`, outlineRowSpans(r, t, AW), {
        sel: sideFocus === "outline" && oTop + i === outlineCur,
        thumb: on(i),
        onDown: (e) => {
          if (e.button === MouseButton.LEFT) outlineGo(r.index)
        },
      }),
    )
  })
  return listEls
}

/** The Info list (a link or change row is clickable), or the read error; it writes its list top and `infoSeen` back. */
function infoList({ c, d, AW, panelRow, thumbRows, topOf }: PanelKit, { jumpChange, openLink }: PanelActions): ReactNode[] {
  const { set, focusPanel } = c
  const { s, t, file, infoRows, linkRows, LH, sideFocus } = d
  const { openPath } = s
  const listEls: ReactNode[] = []
  if (!openPath) listEls.push(panelRow("info-empty", [{ text: "no note open", fg: t.textMuted }]))
  else if (file?.error)
    wrap([{ text: file.error }], AW).forEach((r, i) => listEls.push(panelRow(`info-err-${i}`, [{ text: r.map((x) => x.text).join(""), fg: t.error }])))
  else {
    const items = infoRows
    const curItem = linkRows[d.infoCur] ?? -1
    // follow the cursor only when it moved; wheel and edge scrolling must stick
    const seen = `${sideFocus === "info"}:${openPath}:${d.infoCur}`
    const follow = sideFocus === "info" && curItem >= 0 && s.infoSeen !== seen
    const iTop = follow ? keepVisible(s.listTop.info, curItem, LH, items.length) : topOf("info", items.length)
    s.listTop.info = iTop
    s.infoSeen = seen
    const on = thumbRows(iTop, items.length)
    items.slice(iTop, iTop + LH).forEach((it, i) => {
      const idx = iTop + i
      listEls.push(
        panelRow(`info-${idx}`, infoSpans(it, t, AW), {
          sel: sideFocus === "info" && idx === curItem,
          thumb: on(i),
          onDown:
            it.kind === "link" || (it.kind === "change" && it.stop)
              ? (e) => {
                  if (e.button !== MouseButton.LEFT) return
                  focusPanel()
                  set({ infoCur: linkRows.indexOf(idx) })
                  if (it.kind === "link") openLink(it)
                  else jumpChange(it.at)
                }
              : undefined,
        }),
      )
    })
  }
  return listEls
}

/** Each view's list rows. */
const LISTS: Record<View, (k: PanelKit, acts: PanelActions) => ReactNode[]> = { files: filesList, outline: outlineList, info: infoList }

/** The filter row while shown; its right side is the Outline count, the Files count or a duplicate's folder. */
function filterRows({ d, AW, panelRow }: PanelKit): ReactNode[] {
  const { s, t, rows, filtered, total, filterRow, sideFocus } = d
  if (!filterRow) return []
  const { filter, cursor } = s
  /** The filter row: `/ query▏` (caret while typing), with `right` aligned to the text edge. */
  const filterRowEl = (value: string, typing: boolean, right: string) => {
    const left: Span[] = [
      { text: "/ ", fg: t.primary, attr: 1 },
      { text: truncate(value, Math.max(1, AW - 4 - width(right))), fg: t.text },
    ]
    if (typing) left.push({ text: "▏", fg: t.primary })
    return panelRow("filter", [...left, { text: " ".repeat(Math.max(1, AW - spanWidth(left) - width(right))) }, { text: right, fg: t.textMuted }])
  }
  const cur = rows[cursor]
  // two results with the same name and folder: show the cursor row's full folder instead of the count
  const dup = filtered && cur && rows.some((r, i) => i !== cursor && stem(r.node.name) === stem(cur.node.name) && folderOf(r.node) === folderOf(cur.node))
  const filesRight = dup ? truncateLeft(dirname(cur.node.rel), Math.max(4, AW - 8)) : filtered ? `${fmtNum(total)}${s.tree.truncated ? "+" : ""}` : ""
  return [
    filterRowEl(s.view === "outline" ? s.outlineFilter : filter, s.filterTyping && !!sideFocus, s.view === "outline" ? String(d.oRows.length) : filesRight),
  ]
}

/** The panel box: inline beside the document, else the drawer over it (drawn only while shown). */
export function panelBox(c: AppCtx, d: Derived, acts: PanelActions): ReactNode {
  const { set } = c
  const { s, L, t, rows, infoRows, LH } = d
  const { SW, bodyH } = L
  const paint = surface(t, s.transparent)
  // panel: tab strip, rule, then the current view's list; one cursor, drawn only while focused
  const k = panelKit(c, d)
  const strip = stripRows(k)
  const listEls = LISTS[s.view](k, acts)

  const scrollList = (e: MouseEvent) => {
    const n = s.view === "files" ? rows.length : s.view === "outline" ? d.oRows.length : infoRows.length
    const dlt = e.scroll?.direction === "up" ? -WHEEL_ROWS : WHEEL_ROWS
    set({ listTop: { ...s.listTop, [s.view]: Math.max(0, Math.min(n - LH, k.topOf(s.view, n) + dlt)) } })
  }
  const panelRows = [...strip, ...filterRows(k), ...listEls]
  // distinct keys: the reconciler does not clear style props between the two boxes
  return L.inline ? (
    <box key="side-inline" style={{ width: SW, height: bodyH, flexShrink: 0, flexDirection: "column", backgroundColor: paint.side }} onMouseScroll={scrollList}>
      {panelRows}
    </box>
  ) : (
    <box key="side-drawer" style={{ position: "absolute", left: 0, top: 1 + L.gap, zIndex: 5, width: k.PNW + 1, height: bodyH, flexDirection: "row" }}>
      <box style={{ width: k.PNW, height: bodyH, flexDirection: "column", backgroundColor: t.backgroundElement }} onMouseScroll={scrollList}>
        {panelRows}
      </box>
      <box style={{ width: 1, height: bodyH, flexDirection: "column", backgroundColor: t.background }}>
        {Array.from({ length: bodyH }, (_, i) => (
          <Row key={i} spans={[{ text: "▏", fg: t.border }]} />
        ))}
      </box>
    </box>
  )
}
