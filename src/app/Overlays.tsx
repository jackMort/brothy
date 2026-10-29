// The popups over the page: the `? ?` help sheet, the switcher, the Open picker, Find in Document, the `t` theme picker
// and the zen settings. Not pure: drawn from the app context, with handlers that write the store. Each returns null
// while its popup is closed; the components themselves live in overlay.tsx.
import type { ReactNode } from "react"
import { askTitleNote } from "../ask"
import { folderCounts } from "../files"
import { ROW_PAD, innerWidth, popupWidth } from "../geometry"
import { helpLayout } from "../help"
import type { Rendered } from "../markdown"
import { findItems, keepVisible } from "../nav"
import { HelpSheet, OpenPicker, Overlay, PickerInput, PickerList, Switcher, ThemePicker, ZenSettings } from "../overlay"
import { truncate, plural } from "../text"
import type { Theme } from "../theme"
import { onlyMode, pickIndex, pickMode, pickMove, pickShown, pickTheme, pickTop, themeSplit, type FamilyHit, type ThemePick } from "../themepick"
import { stepRow } from "../vault"
import { zenRows } from "../zen"
import type { AppCtx } from "./ctx"
import type { Derived } from "./derive"
import { HELP_GROUPS } from "./keymap"
import type { SwitcherControl } from "./switcher"
import type { WorkspaceControl } from "./workspace"
import type { Zen } from "./zen"

/** The `? ?` sheet, scrolled to `helpTop`; its title names the version and, while it fits, the theme. */
export function helpOverlay(c: AppCtx, d: Derived, { version, helpGo }: { version: string; helpGo: (n: number) => void }): ReactNode {
  const { set, W, H } = c
  const { s, t } = d
  const hl = helpLayout(HELP_GROUPS, W, H)
  const helpTopC = Math.max(0, Math.min(s.helpTop, hl.rows - hl.vis))
  const helpNote = hl.rows > hl.vis ? `j/k scroll ${helpTopC + hl.vis}/${hl.rows}` : undefined
  // title row: padding 4 each side, then the note and `esc`; the theme name goes first, then the title is cut
  const titleRoom = Math.min(hl.width, W - 2) - 2 - 8 - 2 - 3 - (helpNote ? helpNote.length + 2 : 0)
  const helpFull = `Keybindings · brothy v${version} · ${t.name}`
  const helpTitle = truncate(helpFull.length <= titleRoom ? helpFull : `Keybindings · brothy v${version}`, Math.max(1, titleRoom))
  return s.help ? (
    <HelpSheet t={t} W={W} H={H} layout={hl} top={helpTopC} title={helpTitle} note={helpNote} onClose={() => set({ help: false })} onScroll={(dir) => helpGo(helpTopC + dir * 3)} />
  ) : null
}

/** The `C-p` switcher (Go to, or Ask for a `?` query), with the peek pane where it fits. */
export function switchOverlay(c: AppCtx, d: Derived, { closeSwitcher, swGo, swActivate, peekPane }: Pick<SwitcherControl, "closeSwitcher" | "swGo" | "swActivate" | "peekPane">): ReactNode {
  const { ui, set, W, H } = c
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
      onHover={(i) => i !== swHl && ui.current.switcher && set({ switcher: { ...ui.current.switcher, hl: i } })}
      onActivate={swActivate}
    />
  ) : null
}

/** The `o` Open picker: recent projects and path completions. */
export function openOverlay(c: AppCtx, d: Derived, { opGo, opOpen }: Pick<WorkspaceControl, "opGo" | "opOpen">): ReactNode {
  const { ui, set, W, H } = c
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
      onHover={(i) => i !== d.opHl && ui.current.opener && set({ opener: { ...ui.current.opener, hl: i } })}
      onActivate={(i) => opOpen(d.opRows[i])}
    />
  ) : null
}

/** What the Find picker does: the row Enter takes unmoved, move the highlight, submit a row, close. */
export interface FindActions {
  promptDefault: () => number
  promptHighlight: (hl: number) => void
  promptSubmit: (hl?: number) => void
  promptClose: () => void
}

/** The `/` picker: find in the document, one row per matching line. */
export function findOverlay(c: AppCtx, d: Derived, { promptDefault, promptHighlight, promptSubmit, promptClose }: FindActions): ReactNode {
  const { ui, set, W, H } = c
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
        onHover={(i) => i !== hl && ui.current.prompt && set({ prompt: { ...ui.current.prompt, hl: i, top: ptop } })}
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
  const sample = geo.split && hl >= 0 ? memo.themeSample(cand, geo.peekW, s.hl, s.headings) : null
  return { pick, rows, geo, hl, top, cand, sample }
}

/** What the theme picker does: close it, replace its state, apply the candidate. */
export interface ThemeActions {
  closeTheme: () => void
  themeSet: (p: ThemePick) => void
  applyTheme: () => void
}

/** The `t` picker drawn from `view` (null: closed). */
export function themeOverlay(c: AppCtx, d: Derived, view: ThemePickView | null, { closeTheme, themeSet, applyTheme }: ThemeActions): ReactNode {
  const { ui, memo, W, H } = c
  if (!view) return null
  const { pick, rows, geo, hl, top, cand, sample } = view
  /** row `i` becomes the highlight (hover, click); the list stays where it is under the pointer */
  const pickAt = (i: number) => {
    const p = ui.current.themePick
    const r = rows[i]
    if (p && r && r.family.name !== p.family) themeSet({ ...p, family: r.family.name, top })
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
      onScroll={(dir) => themeSet(pickMove(ui.current.themePick!, dir))}
      onHover={pickAt}
      onActivate={(i) => {
        pickAt(i)
        applyTheme()
      }}
      onPick={(i, m) => {
        pickAt(i)
        themeSet(pickMode(ui.current.themePick!, m))
        applyTheme()
      }}
      onMode={(m) => themeSet(pickMode(ui.current.themePick!, m))}
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
