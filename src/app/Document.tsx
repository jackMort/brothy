// The document area: the welcome page with no note open, an open error, zen's lines (typewriter gutter, Spotlight and
// the gloss sheet) or the note's lines (find matches, link labels, the drawer's scrim), and the minimap beside it.
// Not pure: drawn from the app context, and it clamps the welcome page's highlighted row as it draws, so App calls it
// once per render, before its too-small return.
import { MouseButton, type MouseEvent } from "@opentui/core"
import type { ReactNode } from "react"
import { GLOSS_ROWS, glossRows, glossRule } from "../ai/gloss"
import type { Line } from "../markdown/render"
import { MINI_W, miniCells, miniColors, miniJump } from "../ui/minimap"
import { markMatches, overlayAt } from "../ui/nav"
import { Welcome } from "../ui/overlay"
import { A, type Span } from "../lib/spans"
import { GHOST_STEPS, fadeStep, notePath } from "../ui/status"
import { truncate } from "../lib/text"
import { contrastOn, mix } from "../theme/theme"
import { SPOT_DIM, dimSpans } from "../ui/zen"
import type { AppCtx } from "./ctx"
import type { Derived } from "./derive"
import { WELCOME_KEYS, keyDef } from "./keymap"
import { labelGeo } from "./links"
import { Row } from "./Row"
import { SCRIM_DIM, WHEEL_ROWS } from "./store"
import type { WorkspaceControl } from "./workspace"
import type { Zen } from "./zen"

/** The document box: borderless, wrapped at the reading measure and centered; a click focuses it, the wheel scrolls it. */
export function docBox(c: AppCtx, d: Derived, { welcomeRows, welcomeOpen, zenScroll }: Pick<WorkspaceControl, "welcomeRows" | "welcomeOpen"> & Pick<Zen, "zenScroll">): ReactNode {
  const { welcome, bump, focusDoc, scrollBy } = c
  const { s, L, t, file, view, top, tw, spot, win, sheet } = d
  const { bodyH, CW, CH, padL } = L
  const { openPath, query } = s
  // a note reached through a link outside the opened folder is named from its vault's root
  const rel = notePath(s.root, s.linkRoot, openPath)

  const scrim = L.mode === "drawer" && L.shown
  let content: ReactNode
  if (!openPath) {
    const { rows: recents, shown } = welcomeRows()
    const w = welcome.current
    w.hl = Math.max(1, Math.min(shown, w.hl))
    content = (
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
  } else if (file?.error) {
    content = (
      <box key="error" style={{ flexDirection: "column", paddingLeft: L.zen ? 2 : 0 }}>
        <Row spans={[{ text: "Could not open ", fg: t.error, attr: 1 }, { text: rel, fg: t.text }]} />
        <Row spans={[]} />
        <Row spans={[{ text: truncate(file.error, CW), fg: t.textMuted }]} />
      </box>
    )
  } else if (L.zen) {
    // a 2-column gutter left of the text carries the typewriter marker
    const gutter = mix(t.textMuted, t.background, 0.4)
    // the gloss sheet: a rule and GLOSS_ROWS muted rows over the bottom body rows, faded toward the background
    const sheetK = !sheet || sheet.fadeAt === null ? 0 : (fadeStep(Date.now() - sheet.fadeAt, 0) ?? GHOST_STEPS + 1) / (GHOST_STEPS + 1)
    const ink = (color: typeof t.text) => mix(color, t.background, sheetK)
    const sheetAt = sheet ? CH - 1 - GLOSS_ROWS : CH
    const sheetRule = sheet ? glossRule(sheet.state, sheet.heading, CW) : null
    const glossed = sheet ? glossRows(sheet.text, CW) : []
    content = (
      <box key="zen-lines" style={{ flexDirection: "column", width: CW + 2, height: CH, flexShrink: 0 }}>
        {Array.from({ length: CH }, (_, i) => {
          if (sheetRule && i >= sheetAt) {
            const r = i - sheetAt
            const spans: Span[] = r
              ? [{ text: glossed[r - 1] ?? "", fg: ink(t.textMuted) }]
              : [{ text: sheetRule[0], fg: ink(t.border) }, { text: sheetRule[1], fg: ink(t.textMuted) }, { text: sheetRule[2], fg: ink(t.border) }]
            return <Row key={"gloss" + r} spans={[{ text: "  " }, ...spans]} />
          }
          const n = win.first + i
          const l = n >= win.lo && n < win.hi ? view.lines[n] : undefined
          let spans = l?.spans ?? []
          const dim = !!l && !!spot && (n < spot[0] || n >= spot[1])
          if (dim) spans = dimSpans(spans, t, SPOT_DIM)
          return <Row key={n} spans={[{ text: tw && n === top ? "▸ " : "  ", fg: gutter }, ...markMatches(spans, query, t)]} />
        })}
      </box>
    )
  } else {
    content = (
      <box key="lines" style={{ flexDirection: "column", width: CW, height: CH, flexShrink: 0 }}>
        {view.lines.slice(top, top + CH).map((l: Line, i) => {
          let spans = markMatches(l.spans, query, t)
          const lb = s.labels && s.labels.geo === labelGeo(s, CW, view.lines.length, top) ? s.labels : null
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
  return (
    <box
      key="doc"
      style={{ flexDirection: "column", flexGrow: 1, height: bodyH, paddingLeft: L.zen ? padL - 2 : padL }}
      onMouseDown={() => focusDoc()}
      onMouseScroll={(e: MouseEvent) => (L.zen ? zenScroll : scrollBy)(e.scroll?.direction === "up" ? -WHEEL_ROWS : WHEEL_ROWS)}
    >
      {content}
    </box>
  )
}

/** The minimap: a gap column, two braille cells and the find lane, over the body rows; a click jumps there. Null when off. */
export function miniBox(c: AppCtx, d: Derived): ReactNode {
  const { memo, setTop } = c
  const { s, L, t, file, view, top, maxTop, matches } = d
  const { bodyH, CW, CH } = L
  const miniInkData = L.mini && s.openPath && !file?.error ? memo.mini(view, CW, bodyH, view.srcRow ? String(view.srcRow.length).length + 2 : 0) : null
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
        ? miniCells(miniInkData, { top, h: CH, heads: memo.geo(view).heads, hits: matches, total: view.lines.length, lane: !!s.query }).map((row, i) => (
            <Row key={i} spans={row.map((cell) => ({ text: cell.ch, fg: mc[cell.kind], bg: cell.band ? t.backgroundElement : undefined }))} />
          ))
        : null}
    </box>
  ) : null
}
