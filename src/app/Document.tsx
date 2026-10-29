// The document area: the welcome page with no note open, an open error, zen's lines (typewriter gutter, Spotlight and
// the gloss sheet) or the note's lines (find matches, link labels, the drawer's scrim), and the minimap beside it.
// Not pure: drawn from the app context, and it clamps the welcome page's highlighted row as it draws, so App calls it
// once per render, before its too-small return.
import { MouseButton, type MouseEvent } from "@opentui/core"
import type { ReactNode } from "react"
import { GLOSS_ROWS, glossRows, glossRule } from "../ai/gloss"
import { A, type Span } from "../lib/spans"
import { truncate } from "../lib/text"
import type { Line } from "../markdown/render"
import { contrastOn, mix, type Theme } from "../theme/theme"
import { MINI_W, miniCells, miniColors, miniJump } from "../ui/minimap"
import { markMatches, overlayAt } from "../ui/nav"
import { Welcome } from "../ui/overlay"
import { fadeStep, GHOST_STEPS, notePath } from "../ui/status"
import { dimSpans, SPOT_DIM } from "../ui/zen"
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
  const content = !s.openPath
    ? welcomePage(c, d, ws)
    : file?.error
      ? openError(d, file.error)
      : L.zen
        ? zenLines(d)
        : noteLines(d)
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

/** Zen's lines: a 2-column gutter carrying the typewriter marker, Spotlight dimming, and the gloss sheet over the bottom rows. */
function zenLines(d: Derived) {
  const { t, sheet } = d
  const { CW, CH } = d.L
  // a 2-column gutter left of the text carries the typewriter marker
  const gutter = mix(t.textMuted, t.background, 0.4)
  const sheetRows = sheet ? glossSheet(sheet, t, CW) : []
  const sheetAt = CH - sheetRows.length
  return (
    <box key="zen-lines" style={{ flexDirection: "column", width: CW + 2, height: CH, flexShrink: 0 }}>
      {Array.from({ length: CH }, (_, i) => {
        const r = i - sheetAt
        if (r >= 0) return <Row key={"gloss" + r} spans={[{ text: "  " }, ...sheetRows[r]!]} />
        const n = d.win.first + i
        return <Row key={n} spans={[{ text: d.tw && n === d.top ? "▸ " : "  ", fg: gutter }, ...zenLine(d, n)]} />
      })}
    </box>
  )
}

/** The gloss sheet's rows: a rule and GLOSS_ROWS muted rows, faded toward the background as the sheet fades out. */
function glossSheet(sheet: NonNullable<Derived["sheet"]>, t: Theme, CW: number): Span[][] {
  const k = sheet.fadeAt === null ? 0 : (fadeStep(Date.now() - sheet.fadeAt, 0) ?? GHOST_STEPS + 1) / (GHOST_STEPS + 1)
  const ink = (color: typeof t.text) => mix(color, t.background, k)
  const rule = glossRule(sheet.state, sheet.heading, CW)
  const glossed = glossRows(sheet.text, CW)
  const rows: Span[][] = [
    [
      { text: rule[0], fg: ink(t.border) },
      { text: rule[1], fg: ink(t.textMuted) },
      { text: rule[2], fg: ink(t.border) },
    ],
  ]
  for (let r = 0; r < GLOSS_ROWS; r++) rows.push([{ text: glossed[r] ?? "", fg: ink(t.textMuted) }])
  return rows
}

/** Line `n` of zen's window: blank outside it, dimmed outside the Spotlight, find matches marked. */
function zenLine({ s, t, view, spot, win }: Derived, n: number) {
  const l = n >= win.lo && n < win.hi ? view.lines[n] : undefined
  let spans = l?.spans ?? []
  const dim = !!l && !!spot && (n < spot[0] || n >= spot[1])
  if (dim) spans = dimSpans(spans, t, SPOT_DIM)
  return markMatches(spans, s.query, t)
}

/** The note's lines on screen: find matches marked, link labels over them, dimmed under the drawer's scrim. */
function noteLines({ s, L, t, view, top }: Derived) {
  const { CW, CH } = L
  const scrim = L.mode === "drawer" && L.shown
  const lb = s.labels && s.labels.geo === labelGeo(s, CW, view.lines.length, top) ? s.labels : null
  return (
    <box key="lines" style={{ flexDirection: "column", width: CW, height: CH, flexShrink: 0 }}>
      {view.lines.slice(top, top + CH).map((l: Line, i) => {
        let spans = markMatches(l.spans, s.query, t)
        if (lb)
          lb.spots.forEach((sp, k) => {
            const label = lb.labels[k]!
            if (sp.row === top + i && label.startsWith(lb.typed))
              spans = overlayAt(spans, sp.col, label, { fg: contrastOn(t.warning), bg: t.warning, attr: A.BOLD })
          })
        return <Row key={top + i} spans={scrim ? dimSpans(spans, t, SCRIM_DIM) : spans} />
      })}
    </box>
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
