// The document area: the welcome page with no note open, an open error, zen's lines (typewriter gutter, Spotlight and
// the gloss: a sheet or margin notes, and the heading marks) or the note's lines (find matches, link labels, the change
// and ask marks, the drawer's scrim), and the minimap beside it.
// Not pure: drawn from the app context, and it clamps the welcome page's highlighted row as it draws, so App calls it
// once per render, before its too-small return.
import { MouseButton, type MouseEvent } from "@opentui/core"
import type { ReactNode } from "react"
import { landTail, landText } from "../ai/delta"
import { drawnText, glossTail, type MarginNote, marginLayout, sheetRows } from "../ai/gloss"
import { A, type Span } from "../lib/spans"
import { superscript, truncate } from "../lib/text"
import { contrastOn, mix, type Theme } from "../theme/theme"
import {
  footInk,
  footnoteRule,
  type MarkSource,
  markFor,
  markText,
  noteSpans,
  placeMark,
  SIDENOTE_GAP,
  SIDENOTE_W,
} from "../ui/footnote"
import { MINI_W, miniCells, miniColors, miniJump } from "../ui/minimap"
import { markMatches, overlayAt } from "../ui/nav"
import { Welcome } from "../ui/overlay"
import { fadeStep, GHOST_STEPS, notePath } from "../ui/status"
import { dimSpans, SPOT_DIM } from "../ui/zen"
import { landedHere } from "./Chrome"
import type { AppCtx } from "./ctx"
import type { Derived } from "./derive"
import { keyDef, WELCOME_KEYS } from "./keymap"
import { labelGeo } from "./links"
import { Row } from "./Row"
import { SCRIM_DIM, WHEEL_ROWS } from "./store"
import type { WorkspaceControl } from "./workspace"
import type { Zen } from "./zen"

/** The document box: borderless, wrapped at the reading measure and centered; a click focuses it, the wheel scrolls it. */
export function docBox(
  c: AppCtx,
  d: Derived,
  ws: Pick<WorkspaceControl, "welcomeRows" | "welcomeOpen"> & Pick<Zen, "zenScroll">,
): ReactNode {
  const { focusDoc, scrollBy } = c
  const { s, L, file } = d
  const pageContent = () => {
    if (!s.openPath) return welcomePage(c, d, ws)
    if (file?.error) return openError(d, file.error)
    return L.zen ? zenLines(d) : noteLines(d)
  }
  const content = pageContent()
  return (
    <box
      key="doc"
      style={{ flexDirection: "column", flexGrow: 1, height: L.bodyH, paddingLeft: L.zen ? L.padL - 2 : L.padL }}
      onMouseDown={() => focusDoc()}
      onMouseScroll={(e: MouseEvent) =>
        (L.zen ? ws.zenScroll : scrollBy)(e.scroll?.direction === "up" ? -WHEEL_ROWS : WHEEL_ROWS)
      }
    >
      {content}
    </box>
  )
}

/** No note open: the welcome page, its highlighted row clamped to the recent rows on screen. */
function welcomePage(
  c: AppCtx,
  { s, L, t }: Derived,
  { welcomeRows, welcomeOpen }: Pick<WorkspaceControl, "welcomeRows" | "welcomeOpen">,
) {
  const { welcome, bump } = c
  const { rows: recents, shown } = welcomeRows()
  const w = welcome.current
  w.hl = Math.max(1, Math.min(shown, w.hl))
  return (
    <Welcome
      t={t}
      CW={L.CW}
      CH={L.CH}
      root={s.root}
      recents={recents}
      hl={w.hl}
      tick={w.tick}
      ink={w.ink}
      keys={WELCOME_KEYS.map(([id, word]) => [keyDef(id).label, word])}
      onHover={(i) => {
        w.hl = i
        bump((x) => x + 1)
      }}
      onActivate={welcomeOpen}
    />
  )
}

/** The open note could not be read: its path and the error. */
function openError({ s, L, t }: Derived, error: string) {
  // a note reached through a link outside the opened folder is named from its vault's root
  const rel = notePath(s.root, s.linkRoot, s.openPath)
  return (
    <box key="error" style={{ flexDirection: "column", paddingLeft: L.zen ? 2 : 0 }}>
      <Row
        spans={[
          { text: "Could not open ", fg: t.error, attr: 1 },
          { text: rel, fg: t.text },
        ]}
      />
      <Row spans={[]} />
      <Row spans={[{ text: truncate(error, L.CW), fg: t.textMuted }]} />
    </box>
  )
}

/**
 * Zen's lines: a 2-column gutter carrying the typewriter marker, Spotlight dimming, and the gloss: a sheet over the bottom
 * rows, or from 140 columns notes in the right margin; either way a mark after each glossed heading.
 */
function zenLines(d: Derived) {
  const { t, sheet } = d
  const { CW, CH } = d.L
  // a 2-column gutter left of the text carries the typewriter marker
  const gutter = mix(t.textMuted, t.background, 0.4)
  const side = d.margin === null ? null : glossMargin(d)
  const ink = sheetInk(sheet, t)
  const bottom = sheet && !side ? sheetRows(t, sheet, CW, CH, ink) : []
  const marks = side?.marks ?? sheetMark(d, ink)
  const sheetAt = CH - bottom.length
  return (
    <box key="zen-lines" style={{ flexDirection: "row", height: CH, flexShrink: 0 }}>
      <box key="zen-text" style={{ flexDirection: "column", width: CW + 2, height: CH, flexShrink: 0 }}>
        {Array.from({ length: CH }, (_, i) => {
          const r = i - sheetAt
          if (r >= 0) return <Row key={"gloss" + r} spans={[{ text: "  " }, ...bottom[r]!]} />
          const n = d.win.first + i
          const head = { text: d.tw && n === d.top ? "▸" : " ", fg: gutter }
          return <Row key={n} spans={markedLine(head, zenLine(d, n), marks.get(n), CW)} />
        })}
      </box>
      {side ? (
        <box
          key="gloss-margin"
          style={{ flexDirection: "column", width: SIDENOTE_GAP + SIDENOTE_W, paddingLeft: SIDENOTE_GAP, height: CH }}
        >
          {side.rows.map((spans, i) => (
            <Row key={i} spans={spans} />
          ))}
        </box>
      ) : null}
    </box>
  )
}

/** A zen row: the gutter's first column, then the line; a heading's mark right after its text, else in the gutter. */
function markedLine(head: Span, spans: Span[], mark: Span | undefined, CW: number): Span[] {
  if (!mark) return [{ ...head, text: `${head.text} ` }, ...spans]
  const placed = placeMark(spans, CW, mark)
  return "inline" in placed ? [{ ...head, text: `${head.text} ` }, ...placed.inline] : [head, placed.gutter, ...spans]
}

/** The sheet's fade: toward the background as it fades out (the note and its heading's mark together). */
function sheetInk(sheet: Derived["sheet"], t: Theme) {
  const k =
    !sheet || sheet.fadeAt === null
      ? 0
      : (fadeStep(Date.now() - sheet.fadeAt, 0) ?? GHOST_STEPS + 1) / (GHOST_STEPS + 1)
  return (color: string) => mix(color, t.background, k)
}

/** The sheet's mark: `¹` on its heading's last row (a muted one when outdated), by view line. */
function sheetMark({ t, sheet, view }: Derived, ink: (c: string) => string): Map<number, Span> {
  const h = sheet ? view.headings[sheet.index] : undefined
  if (!sheet || !h) return new Map()
  const c = footInk(t, ink)
  return new Map([[h.last ?? h.line, { text: "¹", fg: sheet.state === "outdated" ? c.markStale : c.mark }]])
}

/**
 * The margin: the reading note (sticky on the first row while its section lasts) and the other sections with a fresh
 * gloss whose heading is on screen, numbered by row; its rows (CH of them) and each drawn heading's mark by view line.
 */
function glossMargin({ t, sheet, others, gHere, overflow, view, win, L }: Derived) {
  const lineOf = (index: number) => (index < 0 ? 0 : (view.headings[index]?.last ?? view.headings[index]?.line ?? 0))
  const reading: MarginNote[] =
    sheet && sheet.fadeAt === null
      ? [
          {
            index: sheet.index,
            row: lineOf(sheet.index) - win.first,
            text: drawnText(sheet),
            reading: true,
            stale: sheet.state === "outdated",
            status: glossTail(sheet, overflow, sheet.open),
          },
        ]
      : []
  const rest = others
    .filter((o) => o.index !== gHere?.index && lineOf(o.index) >= win.lo && lineOf(o.index) < win.hi)
    .map((o): MarginNote => ({ index: o.index, row: lineOf(o.index) - win.first, text: o.text, reading: false }))
  const { placed, marks } = marginLayout(t, [...reading, ...rest], L.CH, !!sheet?.open)
  const rows: Span[][] = Array.from({ length: L.CH }, () => [])
  for (const p of placed) p.rows.forEach((r, k) => p.row + k < L.CH && (rows[p.row + k] = r))
  const c = footInk(t)
  const markFg = (index: number) => {
    if (index !== reading[0]?.index) return c.markOther
    return reading[0].stale ? c.markStale : c.mark
  }
  const byLine = new Map(
    marks
      .filter((m) => m.index >= 0)
      .map((m): [number, Span] => [lineOf(m.index), { text: superscript(m.n), fg: markFg(m.index) }]),
  )
  return { rows, marks: byLine }
}

/** Line `n` of zen's window: blank outside it, dimmed outside the Spotlight, find matches marked. */
function zenLine({ s, t, view, spot, win }: Derived, n: number) {
  const l = n >= win.lo && n < win.hi ? view.lines[n] : undefined
  let spans = l?.spans ?? []
  const dim = !!l && !!spot && (n < spot[0] || n >= spot[1])
  if (dim) spans = dimSpans(spans, t, SPOT_DIM)
  return markMatches(spans, s.query, t)
}

/** An ask landing's mark: the row it sits on (the answered heading's last, Preview only) and its span. */
function landingMark(d: Derived): { row: number; mark: Span } | null {
  const l = landedHere(d)
  const h = l && l.n !== null && !d.s.source ? d.view.headings[l.heading] : undefined
  if (!l || l.n === null || !h) return null
  return { row: h.last ?? h.line, mark: { text: markText(l.n), fg: l.moved ? d.t.textMuted : d.t.primary } }
}

/** A mark over Preview's rows: after the row's text (else in the gutter), or only in the gutter. */
type RowMark = { source: MarkSource; mark: Span; gutter: boolean }

/**
 * The marks on Preview's rows, by row: each changed heading's number (muted once explained), the lead-in's and a removed
 * section's in the gutter (a removed one muted), an ask landing's; one per row, change first (`markFor`).
 */
function rowMarks(d: Derived): Map<number, RowMark> {
  const c = footInk(d.t)
  const explained = d.cv?.state === "result"
  const cands: [number, RowMark][] = d.marks.map((m) => [
    m.row,
    {
      source: "change",
      mark: { text: markText(m.n), fg: explained || m.kind === "removed" ? c.markStale : c.mark },
      gutter: m.kind !== "heading",
    },
  ])
  const ask = landingMark(d)
  if (ask) cands.push([ask.row, { source: "ask", mark: ask.mark, gutter: false }])
  // the landing's quoted line: its number in the gutter, beside the changed text
  const line = d.land?.row
  if (line != null)
    cands.push([line, { source: "change", mark: { text: markText(d.land!.n), fg: c.mark }, gutter: true }])
  const out = new Map<number, RowMark>()
  for (const [row, m] of cands) out.set(row, markFor([...(out.has(row) ? [out.get(row)!] : []), m])!)
  return out
}

/** Rows a landing footnote needs on screen: below it, the change list is left to Info. */
const FOOT_MIN_CH = 10

/**
 * The landing's footnote over the bottom rows (Preview): a blank row, the rule with `¹ of 3 · ] next` (the number in
 * the mark's colour), then the note behind its number in at most 2 rows: the explanation's, else the counts; `¹ ▍` and
 * `asking llama3.2 · 3 s · D cancel` while it is still to come. [] when there is none.
 */
function landFoot({ land, L, t, s, cv }: Derived): Span[][] {
  if (!land || s.source || L.CH < FOOT_MIN_CH) return []
  const c = footInk(t)
  const mark = cv?.state === "result" ? c.markStale : c.mark
  const text = land.wait ? "" : landText(land.change, land.note)
  const rows = noteSpans(text, L.CW, land.n, 2, { mark, text: c.note, caret: c.caret })
  const sup = markText(land.n)
  const rule = footnoteRule(t, L.CW, landTail(land.changes, land.n, land.wait)).flatMap((sp) =>
    sp.text.startsWith(`${sup} of `)
      ? [
          { text: sup, fg: mark },
          { ...sp, text: sp.text.slice(sup.length) },
        ]
      : [sp],
  )
  return [[], rule, ...rows]
}

/** The note's lines on screen: find matches marked, link labels over them, the marks and the landing's footnote, dimmed under the drawer's scrim. */
function noteLines(d: Derived) {
  const { L, t, view, top } = d
  const { CW, CH } = L
  const scrim = L.mode === "drawer" && L.shown
  const marks = rowMarks(d)
  const dim = (spans: Span[]) => (scrim ? dimSpans(spans, t, SCRIM_DIM) : spans)
  const foot = landFoot(d)
  const footAt = CH - foot.length
  return (
    <box key="lines" style={{ flexDirection: "column", width: CW, height: CH, flexShrink: 0 }}>
      {Array.from({ length: foot.length ? CH : Math.min(CH, view.lines.length - top) }, (_, i) =>
        i >= footAt ? (
          <Row key={`change-foot-${i - footAt}`} spans={dim(foot[i - footAt]!)} />
        ) : (
          lineRow(d, top + i, marks.get(top + i), dim)
        ),
      )}
    </box>
  )
}

/** Line `n` of the note: find matches marked, the `f` labels over its links. */
function lineSpans({ s, L, t, view, top }: Derived, n: number): Span[] {
  let spans = markMatches(view.lines[n]?.spans ?? [], s.query, t)
  const lb = s.labels && s.labels.geo === labelGeo(s, L.CW, view.lines.length, top) ? s.labels : null
  lb?.spots.forEach((sp, k) => {
    const label = lb.labels[k]!
    if (sp.row === n && label.startsWith(lb.typed))
      spans = overlayAt(spans, sp.col, label, { fg: contrastOn(t.warning), bg: t.warning, attr: A.BOLD })
  })
  return spans
}

/** Line `n`'s row: its spans, its mark after the text or in the gutter. */
function lineRow(d: Derived, n: number, m: RowMark | undefined, dim: (spans: Span[]) => Span[]) {
  let spans = lineSpans(d, n)
  const at = m && (m.gutter ? { gutter: m.mark } : placeMark(spans, d.L.CW, m.mark))
  if (at && "inline" in at) spans = at.inline
  const row = <Row key={n} spans={dim(spans)} />
  return at && "gutter" in at ? (
    <box key={n} style={{ height: 1, flexDirection: "row" }}>
      <box style={{ position: "absolute", left: -2, width: 1, height: 1 }}>
        <Row spans={dim([at.gutter])} />
      </box>
      {row}
    </box>
  ) : (
    row
  )
}

/** The minimap: a gap column, two braille cells and the find lane, over the body rows; a click jumps there. Null when off. */
export function miniBox(c: AppCtx, d: Derived): ReactNode {
  const { memo, setTop } = c
  const { s, L, t, file, view, top, maxTop, matches } = d
  const { bodyH, CW, CH } = L
  const miniInkData =
    L.mini && s.openPath && !file?.error
      ? memo.mini(view, CW, bodyH, view.srcRow ? String(view.srcRow.length).length + 2 : 0)
      : null
  const mc = miniColors(t)
  return L.mini ? (
    <box
      key="mini"
      style={{ width: MINI_W - 1, height: bodyH, flexDirection: "column", flexShrink: 0 }}
      onMouseDown={(e: MouseEvent) => {
        if (e.button !== MouseButton.LEFT || !miniInkData) return
        setTop(miniJump(e.y - 1 - L.gap, miniInkData, CH, maxTop))
      }}
    >
      {miniInkData
        ? miniCells(miniInkData, {
            top,
            h: CH,
            heads: memo.geo(view).heads,
            hits: matches,
            total: view.lines.length,
            lane: !!s.query,
          }).map((row, i) => (
            <Row
              key={i}
              spans={row.map((cell) => ({
                text: cell.ch,
                fg: mc[cell.kind],
                bg: cell.band ? t.backgroundElement : undefined,
              }))}
            />
          ))
        : null}
    </box>
  ) : null
}
