// The popups over the page: the `? ?` help sheet, the switcher, the Open picker, Find in Document, the `t` theme picker
// and the zen settings. Not pure: drawn from the app context, with handlers that write the store. Each returns null
// while its popup is closed; the components themselves live in overlay.tsx.
import type { ReactNode } from "react"
import { askTitleNote } from "../ai/ask"
import { folderCounts } from "../notes/files"
import { ROW_PAD, innerWidth, popupWidth } from "../ui/geometry"
import { helpLayout } from "../ui/help"
import type { Rendered } from "../markdown/render"
import { findItems, keepVisible } from "../ui/nav"
import { HelpSheet, OpenPicker, Overlay, PickerInput, PickerList, Switcher, ThemePicker, ZenSettings } from "../ui/overlay"
import { truncate, plural } from "../lib/text"
import type { Theme } from "../theme/theme"
import { onlyMode, pickIndex, pickMode, pickMove, pickShown, pickTheme, pickTop, themeSplit, type FamilyHit, type ThemePick } from "../theme/themepick"
import { stepRow } from "../notes/vault"
import { zenRows } from "../ui/zen"
import type { AppCtx } from "./ctx"
import type { Derived } from "./derive"
import { HELP_GROUPS } from "./keymap"
import { WHEEL_ROWS } from "./store"
import type { Popups } from "./popups"
import type { SwitcherControl } from "./switcher"
import type { WorkspaceControl } from "./workspace"
import type { Zen } from "./zen"

/** The `? ?` sheet, scrolled to `helpTop`; its title names the version and, while it fits, the theme. */
export function helpOverlay(c: AppCtx, d: Derived, { version, helpGo }: { version: string } & Pick<Popups, "helpGo">): ReactNode {
  const { set, W, H } = c
  const { s, t } = d
  const layout = helpLayout(HELP_GROUPS, W, H)
  const helpTopC = Math.max(0, Math.min(s.helpTop, layout.rows - layout.vis))
  const helpNote = layout.rows > layout.vis ? `j/k scroll ${helpTopC + layout.vis}/${layout.rows}` : undefined
  // title row: padding 4 each side, then the note and `esc`; the theme name goes first, then the title is cut
  const titleRoom = Math.min(layout.width, W - 2) - 2 - 8 - 2 - 3 - (helpNote ? helpNote.length + 2 : 0)
  const helpFull = `Keybindings · brothy v${version} · ${t.name}`
  const helpTitle = truncate(helpFull.length <= titleRoom ? helpFull : `Keybindings · brothy v${version}`, Math.max(1, titleRoom))
  return s.help ? (
    <HelpSheet t={t} W={W} H={H} layout={layout} top={helpTopC} title={helpTitle} note={helpNote} onClose={() => set({ help: false })} onScroll={(dir) => helpGo(helpTopC + dir * WHEEL_ROWS)} />
  ) : null
}

/** Hover: row `i` becomes popup `key`'s highlight (with `top`, for Find), unless it already is or the popup has closed. */
function hoverRow({ ui, set }: AppCtx, key: "switcher" | "opener" | "prompt", hl: number, top?: number) {
  return (i: number) => {
    const p = ui.current[key]
    if (i !== hl && p) set({ [key]: { ...p, hl: i, ...(top === undefined ? {} : { top }) } })
  }
}

/** The `C-p` switcher (Go to, or Ask for a `?` query), with the peek pane where it fits. */
export function switchOverlay(c: AppCtx, d: Derived, { closeSwitcher, swGo, swActivate, peekPane }: Pick<SwitcherControl, "closeSwitcher" | "swGo" | "swActivate" | "peekPane">): ReactNode {
  const { W, H } = c
  const { s, L, t, swRows, swHl, question } = d
  const notesLabel = s.indexing ? `indexing ${s.indexing[0]}/${s.indexing[1]}` : plural(folderCounts(s.linkTree).get(s.linkTree.path) ?? 0, "note")
  const peek = peekPane(d)
  return s.switcher ? (
    <Switcher
      t={t}
      W={W}
      H={H}
      title={question ? "Ask" : "Go to"}
      q={s.switcher.q}
      rows={swRows}
      hl={swHl}
      top={keepVisible(s.switcher.top, Math.max(0, swHl), L.PH, swRows.length)}
      height={L.PH}
      note={question ? askTitleNote({ off: !s.ai, state: s.switcher.ask, indexing: s.indexing ? notesLabel : null, notes: notesLabel }) : notesLabel}
      peek={peek}
      onClose={closeSwitcher}
      onScroll={(dir) => swGo(stepRow(swRows, swHl, dir))}
      onHover={hoverRow(c, "switcher", swHl)}
      onActivate={swActivate}
    />
  ) : null
}

/** The `o` Open picker: recent projects and path completions. */
export function openOverlay(c: AppCtx, d: Derived, { opGo, opOpen }: Pick<WorkspaceControl, "opGo" | "opOpen">): ReactNode {
  const { set, W, H } = c
  const { s, L, t } = d
  return s.opener ? (
    <OpenPicker
      t={t}
      W={W}
      H={H}
      q={s.opener.q}
      rows={d.opRows}
      hl={d.opHl}
      top={keepVisible(s.opener.top, Math.max(0, d.opHl), L.PH, d.opRows.length)}
      height={L.PH}
      onClose={() => set({ opener: null })}
      onScroll={(dir) => opGo(stepRow(d.opRows, d.opHl, dir))}
      onHover={hoverRow(c, "opener", d.opHl)}
      onActivate={(i) => opOpen(d.opRows[i])}
    />
  ) : null
}

/** The `/` picker: find in the document, one row per matching line. */
export function findOverlay(c: AppCtx, d: Derived, { promptDefault, promptHighlight, promptSubmit, promptClose }: Pick<Popups, "promptDefault" | "promptHighlight" | "promptSubmit" | "promptClose">): ReactNode {
  const { W, H } = c
  const { s, L, t, view, matches } = d
  const { prompt } = s
  if (!prompt) return null
  const popupW = popupWidth(W)
  const height = L.PH
  const items = findItems(view.lines, matches, prompt.value, s.source, innerWidth(popupW) - ROW_PAD, t)
  const hl = Math.min(items.length - 1, prompt.hl >= 0 ? prompt.hl : promptDefault())
  const ptop = keepVisible(prompt.hl >= 0 ? prompt.top : 0, Math.max(0, hl), height, items.length)
  const note = prompt.value ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : undefined
  return (
    <Overlay
      t={t}
      W={W}
      H={H}
      width={popupW}
      title="Find in Document"
      onClose={promptClose}
      onScroll={(dir) => items.length && promptHighlight(hl + dir)}
    >
      <PickerInput t={t} value={prompt.value} placeholder="Find in document..." note={note} width={popupW} />
      <PickerList
        t={t}
        items={items}
        hl={hl}
        top={ptop}
        height={height}
        innerW={popupW - 2}
        empty={!prompt.value ? "Type to search" : "No results found"}
        onHover={hoverRow(c, "prompt", hl, ptop)}
        onActivate={(i) => promptSubmit(i)}
      />
    </Overlay>
  )
}

/** The `t` picker as drawn this render: its rows, geometry, highlighted row and window, and the candidate with its sample. */
export interface ThemePickView {
  pick: ThemePick
  rows: FamilyHit[]
  geo: ReturnType<typeof themeSplit>
  hl: number
  /** the board's first row */
  top: number
  /** the theme ⏎ would apply */
  cand: Theme
  /** the sample rendered in the candidate, for the pane (split popup and a row listed only) */
  sample: Rendered | null
}

/** The `t` picker's view, null while it is closed; App asks for the sample's code highlights between this and `themeOverlay`. */
export function themePickView(c: AppCtx, d: Derived): ThemePickView | null {
  const { memo, W, H } = c
  const { s, L } = d
  // the chrome stays in `t`; from PEEK_MIN_W the pane draws the candidate's sample on its own background
  const pick = s.themePick
  if (!pick) return null
  const rows = memo.themeRows(pick.q)
  const geo = themeSplit(W, H, L.PH)
  const hl = pickIndex(pick, rows)
  // the board's rows under the header; hover holds the window where it is, keys and the wheel centre it again
  const top = pickTop(pick, hl, Math.max(1, geo.rows - 1), rows.length)
  const cand = pickTheme(pick)
  const sample = geo.split && hl >= 0 ? memo.themeSample(cand, geo.peekW, s.hl, s.headingStyle) : null
  return { pick, rows, geo, hl, top, cand, sample }
}

/** The `t` picker drawn from `view` (null: closed). */
export function themeOverlay(c: AppCtx, d: Derived, view: ThemePickView | null, { closeTheme, themeSet, applyTheme }: Pick<Popups, "closeTheme" | "themeSet" | "applyTheme">): ReactNode {
  const { ui, memo, W, H } = c
  if (!view) return null
  const { pick, rows, geo, hl, top, cand, sample } = view
  /** row `i` becomes the highlight (hover, click); the list stays where it is under the pointer */
  const pickAt = (i: number) => {
    const r = rows[i]
    if (r && r.family.name !== ui.current.themePick?.family) themeSet((p) => ({ ...p, family: r.family.name, top }))
  }
  return (
    <ThemePicker
      t={d.t}
      W={W}
      H={H}
      q={pick.q}
      rows={rows}
      hl={hl}
      top={top}
      mode={pick.mode}
      shown={pickShown(pick)}
      only={hl >= 0 ? onlyMode(rows[hl]!.family) : undefined}
      orig={pick.orig}
      geo={geo}
      pane={sample ? { theme: cand, lines: memo.themePane(cand, sample, geo.peekW, geo.rows) } : undefined}
      onClose={closeTheme}
      onScroll={(dir) => themeSet((p) => pickMove(p, dir))}
      onHover={pickAt}
      onActivate={(i) => {
        pickAt(i)
        applyTheme()
      }}
      onPick={(i, m) => {
        pickAt(i)
        themeSet((p) => pickMode(p, m))
        applyTheme()
      }}
      onMode={(m) => themeSet((p) => pickMode(p, m))}
    />
  )
}

/** The `Z` zen settings popup. */
export function zenOverlay(c: AppCtx, d: Derived, { revertZen, zenEdit }: Pick<Zen, "revertZen" | "zenEdit">): ReactNode {
  const { ui, set, W, H } = c
  const { s, t } = d
  return s.zenOrig !== null ? (
    <ZenSettings
      t={t}
      W={W}
      H={H}
      rows={zenRows(s.zenCfg)}
      cursor={s.zenRow}
      onClose={revertZen}
      onHover={(i) => i !== ui.current.zenRow && set({ zenRow: i })}
      onActivate={(i) => {
        set({ zenRow: i })
        zenEdit(i, 0)
      }}
    />
  ) : null
}
