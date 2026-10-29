// Screen geometry, pure: where the status rows, the panel or drawer, the document column and the minimap go for a
// terminal size and the store's view state.
import type { UI } from "./app/store"
import { MINI_MIN_W, MINI_W } from "./minimap"

/** Reading measure: the document never wraps wider than this. */
export const MEASURE = 80
/** Below this width the panel is a drawer over the text instead of a column beside it. */
export const DRAWER_BELOW = 100

/**
 * Screen rows: top line, gap (H ≥ 28), body (panel + document), ghost line, progress line.
 * At DRAWER_BELOW columns and wider the panel is a column left of the document (unless hidden);
 * below that it is a drawer over the document, and the document lays out as if it were not there.
 * The document wraps at `CW` = min(available, MEASURE), centered (`wide` / zen "full": the
 * area minus a 2-column margin each side). Zen (unless Source is shown) drops the panel.
 */
export function layout(W: number, H: number, s: Pick<UI, "hidden" | "drawerOpen" | "zen" | "source" | "zenCfg" | "wide" | "minimap" | "openPath">) {
  const zen = s.zen && !s.source
  const mode: "inline" | "drawer" = W < DRAWER_BELOW ? "drawer" : "inline"
  // the welcome page (no note open) has the whole width: no panel, drawer or minimap; the saved sidebar is left alone
  const welcome = !s.openPath
  const shown = !zen && !welcome && (mode === "drawer" ? s.drawerOpen : !s.hidden)
  const SW = Math.min(40, Math.max(24, Math.round(W * 0.27)))
  /** drawer width; its `▏` edge is one more column */
  const DW = Math.min(W - 8, Math.max(28, Math.min(40, Math.round(W * 0.45))))
  const inline = shown && mode === "inline"
  const gap = H >= 28 ? 1 : 0
  const bodyH = Math.max(4, H - 3 - gap)
  const areaW = W - 2 - (inline ? SW + 1 : 0)
  const want = zen ? s.zenCfg.measure : s.wide ? "full" : MEASURE
  let CW = Math.max(20, want === "full" ? areaW - 4 : Math.min(want, areaW - 4))
  let padL = Math.max(0, Math.floor((areaW - CW) / 2))
  // the minimap takes the last MINI_W columns (the right margin and padding): the text keeps its
  // column while it fits left of the minimap's gap, then the measure shrinks (left margin kept)
  const mini = s.minimap && !zen && !welcome && W >= MINI_MIN_W
  if (mini) {
    const room = W - MINI_W - 1 - (inline ? SW + 1 : 0)
    CW = Math.max(20, Math.min(CW, room - 2))
    padL = Math.max(0, Math.min(padL, room - CW))
  }
  return {
    zen,
    mode,
    shown,
    inline,
    SW,
    DW,
    /** panel width on screen */
    PNW: mode === "drawer" ? DW : SW,
    gap,
    bodyH,
    areaW,
    CW,
    CH: bodyH,
    /** document left margin inside its area */
    padL,
    /** the braille minimap is drawn at the right edge */
    mini,
    /** visible rows of the `/` popup list: panel padding 2, title, input, two gaps */
    PH: Math.max(1, Math.min(16, H - 2 - 6)),
  }
}
