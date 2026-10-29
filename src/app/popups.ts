// What the popups and the panel filter row do to the store: Find in Document, the `t` theme picker, the help sheet's
// scroll and the filter's typing. Not pure: `makePopups` closes over the app context.

import { clamp } from "../lib/text"
import { themes } from "../theme/theme"
import { filterFamilies, pickIndex, pickStart, pickTheme, type ThemePick } from "../theme/themepick"
import { helpLayout } from "../ui/help"
import { keepVisible } from "../ui/nav"
import type { AppCtx } from "./ctx"
import { HELP_GROUPS } from "./keymap"

/** The panel filter row's typing. */
function makeFilter(c: AppCtx) {
  const { ui, set, timers } = c

  /** The filter text of the shown view (Files or Outline). */
  const filterText = () => (ui.current.view === "outline" ? ui.current.outlineFilter : ui.current.filter)
  const filterType = (v: string) => {
    clearTimeout(timers.current.open) // a preview armed for the old results must not fire
    set(ui.current.view === "outline" ? { outlineFilter: v, outlineCur: 0 } : { filter: v })
  }
  /** Leave typing; `clear` also empties the shown view's filter. */
  const filterStop = (clear: boolean) => {
    clearTimeout(timers.current.open)
    const emptied = ui.current.view === "outline" ? { outlineFilter: "" } : { filter: "" }
    set({ filterTyping: false, ...(clear ? emptied : {}) })
  }

  return { filterText, filterType, filterStop }
}

/** Find in Document's popup. */
function makeFind(c: AppCtx) {
  const { ui, set, derive, flash, focusDoc, showMatch } = c

  /** The popup row Enter acts on when the highlight hasn't been moved. */
  const promptDefault = () => {
    const { matches, top } = derive()
    return Math.max(
      0,
      matches.findIndex((m) => m >= top),
    )
  }
  const promptCount = () => derive().matches.length
  const promptHighlight = (hl: number) => {
    const pr = ui.current.prompt
    if (!pr) return
    const { L } = derive()
    const n = clamp(hl, 0, promptCount() - 1)
    const top = keepVisible(
      pr.hl >= 0 ? pr.top : keepVisible(0, promptDefault(), L.PH, promptCount()),
      n,
      L.PH,
      promptCount(),
    )
    set({ prompt: { ...pr, hl: n, top } })
  }
  const promptType = (v: string) => set({ prompt: { value: v, hl: -1, top: 0 }, query: v, matchLine: null })
  const promptSubmit = (hl = ui.current.prompt?.hl ?? -1) => {
    if (!ui.current.prompt) return
    set({ prompt: null })
    // results land in the document, which takes focus so n / N work next
    focusDoc()
    const { matches, top, s } = derive()
    const m = hl >= 0 ? matches[hl] : (matches.find((x) => x >= top) ?? matches[0])
    if (m !== undefined) showMatch(m)
    else if (s.query) flash(`no match for “${s.query}”`, "error")
  }
  const promptClose = () => {
    if (ui.current.prompt) set({ prompt: null, query: "", matchLine: null })
  }

  return { promptDefault, promptCount, promptHighlight, promptType, promptSubmit, promptClose }
}

/** The `t` theme picker. */
function makeThemePicker(c: AppCtx) {
  const { ui, set, flash, persist } = c

  // `t` picker: the app stays in its theme while you move (only the pane shows the candidate); ⏎ applies and saves, esc changes nothing
  const openTheme = () => set({ themePick: pickStart(themes[ui.current.themeIdx]!) })
  const closeTheme = () => set({ themePick: null })
  /** The open picker's next state from `f` (nothing while it is closed). */
  const themeSet = (f: (p: ThemePick) => ThemePick) => {
    const p = ui.current.themePick
    if (p) set({ themePick: f(p) })
  }
  /** ⏎ or a click: the candidate becomes the theme; with no row listed nothing happens */
  const applyTheme = () => {
    const p = ui.current.themePick
    if (!p || pickIndex(p, filterFamilies(p.q)) < 0) return
    const name = pickTheme(p).name
    set({ themeIdx: themes.findIndex((x) => x.name === name), themePick: null })
    if (persist({ theme: name })) flash(`theme · ${name}`, "ok")
  }

  return { openTheme, closeTheme, themeSet, applyTheme }
}

/** The popups and the filter row over the app context. */
export function makePopups(c: AppCtx) {
  const { set, dims } = c

  /** Scroll the `? ?` sheet so row `n` is its first, within its rows. */
  const helpGo = (n: number) => {
    const l = helpLayout(HELP_GROUPS, dims.current.W, dims.current.H)
    set({ helpTop: Math.max(0, Math.min(l.rows - l.vis, n)) })
  }

  return { ...makeFilter(c), ...makeFind(c), ...makeThemePicker(c), helpGo }
}
/** What `makePopups` gives App and the actions. */
export type Popups = ReturnType<typeof makePopups>
