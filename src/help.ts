// The `? ?` keys sheet's layout: KEYMAP groups as a chip row and key rows, one column below 100 columns,
// two from there (whole groups, Global and Panel left, the rest right), scrolled together by rows.
import { BODY_PAD, innerWidth, popupWidth } from "./geometry"
import { WORDMARK, fitWordmark } from "./status"
import { clamp } from "./text"

export interface HelpGroup {
  title: string
  entries: { keys: string; desc: string }[]
}
/** One row of a column: a group's chip, a binding, or the blank row between groups (null). */
export type HelpLine = { kind: "chip"; title: string } | { kind: "key"; keys: string; desc: string } | null
export interface HelpLayout {
  /** popup width (Overlay `width`) */
  width: number
  cols: HelpLine[][]
  /** width of one column */
  colW: number
  /** cells the keys are padded to */
  keyW: number
  /** the wordmark header fits */
  mark: boolean
  /** rows of the taller column */
  rows: number
  /** rows on screen */
  vis: number
}

export const HELP_TWO_COLS = 100
/** the two-column sheet's widest popup, and the columns it keeps free of the screen */
const HELP_WIDE_W = 112
const HELP_WIDE_MARGIN = 8
/** keys are padded to this many cells, as the popup has always done; a narrow column gives up to 7 of them */
export const HELP_KEY_W = 16
/** description cells a column keeps before its key padding shrinks */
const DESC_MIN = 33
/** Two-column placement by group title; a group not named here joins the shorter column. */
export const HELP_COLUMNS: readonly (readonly string[])[] = [["Global", "Panel"], ["Document", "AI", "Zen"]]
const COL_GAP = 4

const groupLines = (g: HelpGroup): HelpLine[] => [{ kind: "chip", title: g.title }, ...g.entries.map((e) => ({ kind: "key" as const, ...e }))]
const join = (gs: HelpGroup[]): HelpLine[] => gs.flatMap((g, i) => (i ? [null, ...groupLines(g)] : groupLines(g)))

export function helpLayout(groups: readonly HelpGroup[], W: number, H: number, columns = HELP_COLUMNS): HelpLayout {
  const two = W >= HELP_TWO_COLS
  const width = two ? Math.min(HELP_WIDE_W, W - HELP_WIDE_MARGIN) : popupWidth(W)
  // Overlay padding 1 and the body's 4 each side
  const inner = innerWidth(width) - BODY_PAD
  const colW = two ? Math.floor((inner - COL_GAP) / 2) : inner
  const keyW = clamp(colW - DESC_MIN, HELP_KEY_W - 7, HELP_KEY_W)
  const shown = groups.filter((g) => g.entries.length)
  let cols: HelpLine[][]
  if (!two) cols = [join(shown)]
  else {
    const picked = columns.map((titles) => titles.flatMap((title) => shown.filter((g) => g.title === title)))
    for (const g of shown) {
      if (picked.some((c) => c.includes(g))) continue
      const short = join(picked[0]!).length <= join(picked[1]!).length ? 0 : 1
      picked[short]!.push(g)
    }
    cols = picked.map(join)
  }
  // popup chrome: footer 2, padding 2, title row and its gap 2; the wordmark leaves 3 list rows
  const mark = !!fitWordmark(inner, H - 2 - 4 - 3 - 1)
  const rows = Math.max(0, ...cols.map((c) => c.length))
  const vis = clamp(rows, 3, H - 2 - 4 - (mark ? WORDMARK.length + 1 : 0))
  return { width, cols, colW, keyW, mark, rows, vis }
}
