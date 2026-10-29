// Popup geometry, pure: the widths and paddings the switcher, open, theme and help popups share, so the sums that
// size a popup, its list and its pane read as names. Overlay (overlay.tsx) draws the paddings; peek.ts, themepick.ts
// and help.ts size the popups with them.

/** from this many columns the switcher and the theme picker widen and split into a list and a pane */
export const PEEK_MIN_W = 100
/** the usual popup width: switcher, open and help below two columns */
export const POPUP_W = 70
/** the zen settings popup's width */
export const ZEN_POPUP_W = 52
/** columns a popup leaves free at the screen edges */
export const POPUP_EDGE = 2
/** Overlay's padding of 1 each side: a popup's inner width is its width minus this */
export const POPUP_INSET = 2
/** PickerList and ThemeBoard pad each row 3 and the box 1 each side: a row's text is `innerW` minus this */
export const ROW_PAD = 8
/** PickerInput and the help body pad 4 each side */
export const BODY_PAD = 8
/** the split popup keeps this many columns free of the screen (`min(W − SPLIT_MARGIN, SPLIT_MAX_W)` wide) */
export const SPLIT_MARGIN = 12
/** the widest the split popup gets */
export const SPLIT_MAX_W = 116
/** the widest the switcher's list gets beside its pane */
export const LIST_MAX_W = 70
/** the `│` between a list and its pane */
export const DIVIDER_W = 1
/** a pane pads its text 2 left and 4 right */
export const PANE_PAD = 6
/** rows the theme picker's split popup leaves free of the screen (`rows` is `H` minus this) */
export const SPLIT_ROWS_MARGIN = 10

/** A popup of at most `cap` columns that still fits the screen with its edge margin. */
export const popupWidth = (W: number, cap: number = POPUP_W): number => Math.min(cap, W - POPUP_EDGE)

/** The split popup's width on a `W`-wide screen. */
export const splitWidth = (W: number): number => Math.min(W - SPLIT_MARGIN, SPLIT_MAX_W)

/** Columns inside a popup of `width`, where its list or board goes. */
export const innerWidth = (width: number): number => width - POPUP_INSET

/** Text columns of a pane beside a list of `listW` in a popup whose inner width is `inner`. */
export const paneWidth = (inner: number, listW: number): number => inner - listW - DIVIDER_W - PANE_PAD
