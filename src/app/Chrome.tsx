// The status rows around the document: the top line (row 0), the gap row's rule, the ghost line (key hints and the
// toast, row H-2) and the progress line (row H-1). Not pure: drawn from the app context; the spans come from status.ts.
import { basename, dirname, resolve } from "node:path"
import type { ReactNode } from "react"
import type { Span } from "../lib/spans"
import { spanWidth } from "../lib/text"
import { fadeSpans } from "../ui/chrome"
import {
  fadeStep,
  GHOST_STEPS,
  gapSpans,
  HINT_HOLD,
  type HintItem,
  headerLayout,
  hintSpans,
  logoState,
  mainHeadingVisible,
  notePath,
  progressLabel,
  progressSpans,
  toastSpans,
  topLineSpans,
} from "../ui/status"
import { headingPath, minutesLeft } from "../ui/zen"
import type { AppCtx } from "./ctx"
import type { Derived } from "./derive"
import type { Ctx } from "./keymap"
import { Row } from "./Row"

/** The text column's left edge on screen: the frame, the inline panel and its gap, then the measure's padding. */
const textLeft = ({ L }: Derived) => 1 + (L.inline ? L.SW + 1 : 0) + L.padL

/** Row 0's spans: the logo at column 0, the folder over the panel, `Title › section` from the text's left edge, the state cluster at its right edge. */
function topLine(d: Derived): Span[] {
  const { s, L, t, file, view, top, matches, currentHeading } = d
  const logo = logoState({ gone: !!file?.error, reloadedAt: s.reloadedAt, now: Date.now() })
  if (!s.openPath) return topLineSpans(t, logo, null, false)
  const h = headerLayout({
    inline: L.inline,
    SW: L.SW,
    textLeft: textLeft(d),
    textWidth: L.CW,
    zen: L.zen,
    gap: !!L.gap,
    vault: basename(resolve(s.root)) || s.root,
    // a note reached through a link outside the opened folder is named from its vault's root
    folder: dirname(notePath(s.root, s.linkRoot, s.openPath)),
    title: d.title,
    trail: headingPath(view.headings, currentHeading),
    query: s.prompt ? "" : s.query,
    matchIdx: d.matchIdx,
    count: matches.length,
    source: s.source,
    wide: s.wide,
  })
  return topLineSpans(t, logo, h, mainHeadingVisible(view.headings, d.title, top, L.bodyH))
}

/** Row 0, faded `k` toward the background (0 = full); null draws nothing (ghosted away). */
export const topRow = (d: Derived, k: number | null): ReactNode => (
  <box style={{ height: 1, flexDirection: "row" }}>
    <Row spans={fadeSpans(d.t, k === null ? [] : topLine(d), k ?? 0)} />
  </box>
)

/** The gap row (H ≥ 28): a faint rule over the text column; blank in zen. */
export function gapRow(d: Derived): ReactNode {
  const { L, t } = d
  if (!L.gap) return null
  return (
    <box key="gap" style={{ height: 1, flexDirection: "row" }}>
      {L.zen ? null : <Row spans={gapSpans(t, textLeft(d), L.CW)} />}
    </box>
  )
}

/** The progress line (row H-1): read part in primary, then `34% · 3 min left`; the one permanent zen row. */
export function progressLine(c: AppCtx, d: Derived): ReactNode {
  const { s, t, file, view, top, maxTop, pg } = d
  const pl =
    s.openPath && !file?.error
      ? progressLabel({
          top,
          maxTop,
          minutes: minutesLeft(c.memo.words(view), top),
          page: pg ? { index: pg.index, count: pg.count } : undefined,
          wpm: s.rolling ? s.zenCfg.wpm : undefined,
        })
      : null
  return (
    <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
      <Row spans={progressSpans(t, pl, top, maxTop, c.W - 2)} />
    </box>
  )
}

/**
 * The ghost line (row H-2): key hints for context `ctx` on the left (`hints`, as many as fit beside the toast), the
 * toast on the right; blank at rest. `pinned` hints stay at full colour, others fade after HINT_HOLD.
 */
export function ghostLine(
  c: AppCtx,
  d: Derived,
  { ctx, pinned, hints }: { ctx: Ctx; pinned: boolean; hints: (ctx: Ctx) => HintItem[] },
): ReactNode {
  const { s, t } = d
  let hintK: number | null = null
  if (pinned) hintK = 0
  // the welcome page has its own keycaps: no hint row under it (popups opened from it keep theirs)
  else if (s.openPath && s.hintAt !== null && s.hintCtx === ctx) {
    const st = fadeStep(Date.now() - s.hintAt, HINT_HOLD)
    hintK = st === null ? null : st / (GHOST_STEPS + 1)
  }
  const toast = toastSpans(t, s.toast, Date.now(), c.W - 2)
  const hinted =
    hintK === null
      ? []
      : fadeSpans(t, hintSpans(t, hints(ctx), c.W - 2 - (toast.length ? spanWidth(toast) + 3 : 0)), hintK)
  return (
    <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
      <Row spans={hinted} />
      <Row spans={toast} />
    </box>
  )
}
