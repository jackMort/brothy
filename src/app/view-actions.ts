// The actions of the document, zen, the panel views (Outline, Info, Files and the filter row) and the popups (help,
// find, the switcher, the opener, the theme picker and zen settings), one factory per family; `makeActions` composes
// them. Not pure: they close over the app context and the feature factories.
import { dirname } from "node:path"
import { askSection } from "../ai/ask"
import { clamp } from "../lib/text"
import { ancestorsOf } from "../notes/files"
import { nextSection, stepRow } from "../notes/vault"
import { pickMode, pickMove, pickQuery } from "../theme/themepick"
import { helpLayout } from "../ui/help"
import { stepMeasure, ZEN_ROWS, ZEN_WPM } from "../ui/zen"
import type { Actions, Features, Moves } from "./actions"
import type { AppCtx } from "./ctx"
import { erase } from "./input"
import { HELP_GROUPS, isDown } from "./keymap"
import type { Links } from "./links"
import type { Popups } from "./popups"

/** The bindings without keys (`type`, `a–z`, `^p ?`) are there for help and the footer: `onKey` routes the typing itself. */
const typing = () => {}

/** The document: scrolling, headings, matches, and the link labels. */
export function makeDocActions(
  c: AppCtx,
  { startLabels }: Pick<Links, "startLabels">,
  { jumpHeading, jumpMatch }: Moves,
) {
  const { ui, set, derive, setTop, scrollBy, focusPanel } = c
  return {
    docLine: (k) => scrollBy(isDown(k) ? 1 : -1),
    docHalf: (k) => scrollBy((isDown(k) ? 1 : -1) * Math.max(1, Math.floor(derive().L.CH / 2))),
    docPage: (k) => scrollBy((isDown(k) ? 1 : -1) * (derive().L.CH - 2)),
    docEnds: (k) => setTop(k.name === "home" || (k.name === "g" && !k.shift) ? 0 : derive().maxTop),
    docHeading: (k) => jumpHeading(k.sequence === "]" || k.sequence === "}" ? 1 : -1),
    docMatch: (k) => jumpMatch(k.shift ? -1 : 1),
    back: () => focusPanel(),
    links: startLabels,
    labelType: typing,
    labelErase: () => {
      const lb = ui.current.labels
      if (lb) set({ labels: { ...lb, typed: erase(lb.typed) } })
    },
    labelCancel: () => set({ labels: null }),
  } satisfies Partial<Actions>
}

/** Zen: scrolling (pages flip, space rolls the teleprompter), sections, measure, speed and the gloss. */
export function makeZenActions(c: AppCtx, { aiJobs, zen }: Features, { jumpHeading }: Moves) {
  const { ui, derive, flash, setTop, stopRolling } = c
  const { startRolling, setZen, goPage, zenScroll } = zen
  return {
    zenLine: (k) => zenScroll(isDown(k) ? 1 : -1),
    zenHalf: (k) => zenScroll((isDown(k) ? 1 : -1) * Math.max(1, Math.floor(derive().L.CH / 2))),
    zenPage: (k) => {
      const { pg, L, prompter } = derive()
      if (k.name === "space" && prompter) return ui.current.rolling ? stopRolling() : startRolling()
      const step = L.CH - 2
      if (!pg) return zenScroll((isDown(k) ? 1 : -1) * step)
      // a tall page scrolls to its end first, then the next press flips
      if (isDown(k)) {
        if (pg.top < pg.maxTop) zenScroll(step)
        else goPage(pg.index + 1)
      } else if (pg.top > pg.start) zenScroll(-step)
      else goPage(pg.index - 1)
    },
    zenEnds: (k) => {
      stopRolling()
      const toTop = (k.name === "g" && !k.shift) || k.name === "home"
      if (derive().pg) return goPage(toTop ? 0 : Infinity)
      setTop(toTop ? 0 : derive().maxTop)
    },
    zenGloss: aiJobs.zenGloss,
    zenRegen: aiJobs.zenRegen,
    zenSection: (k) => {
      stopRolling()
      const dir = k.sequence === "]" || k.sequence === "}" ? 1 : -1
      const { pg } = derive()
      if (pg) goPage(pg.index + dir)
      else jumpHeading(dir)
    },
    zenMeasure: (k) => {
      if (setZen({ measure: stepMeasure(ui.current.zenCfg.measure, k.sequence === ">" ? 1 : -1) }, true))
        flash(`measure ${ui.current.zenCfg.measure}`)
    },
    zenSpeed: (k) => {
      if (setZen({ wpm: ui.current.zenCfg.wpm + (k.sequence === "+" ? 1 : -1) * ZEN_WPM.step }, true))
        flash(`${ui.current.zenCfg.wpm} wpm`)
    },
  } satisfies Partial<Actions>
}

/** The Outline tab: move, jump and read, jump and keep the panel. */
export function makeOutlineActions(c: AppCtx, { outlineGo }: Moves) {
  const { set, derive } = c
  return {
    outlineMove: (k) => {
      const { outlineCur, oRows } = derive()
      const n = oRows.length
      let next = outlineCur + (isDown(k) ? 1 : -1)
      if (k.name === "g") next = k.shift ? n - 1 : 0
      set({ outlineCur: clamp(next, 0, n - 1) })
    },
    outlineJump: () => {
      const { oRows, outlineCur } = derive()
      const r = oRows[outlineCur]
      if (r) outlineGo(r.index)
    },
    outlinePeek: () => {
      const { oRows, outlineCur } = derive()
      const r = oRows[outlineCur]
      if (r) outlineGo(r.index, true)
    },
  } satisfies Partial<Actions>
}

/** The Info tab: step through its links and Changed rows, open one. */
export function makeInfoActions(c: AppCtx, { openLink }: Pick<Links, "openLink">, { jumpChange }: Moves) {
  const { set, derive } = c
  return {
    infoMove: (k) => {
      const { linkRows, infoRows, infoCur, LH, s } = derive()
      const max = Math.max(0, infoRows.length - LH)
      const dir = isDown(k) ? 1 : -1
      // g / G go to the first / last link (or row); the other keys step one
      const jump = k.name === "g"
      const toEnd = jump ? !!k.shift : dir > 0
      const edgeTop = toEnd ? max : 0
      const scroll = () =>
        set({
          listTop: { ...s.listTop, info: Math.max(0, Math.min(max, jump ? edgeTop : s.listTop.info + dir)) },
        })
      const edge = toEnd ? linkRows.length - 1 : 0
      // without links, or at the first/last one, the keys scroll the rest of the list into view
      if (!linkRows.length || infoCur === edge) return scroll()
      set({ infoCur: jump ? edge : clamp(infoCur + dir, 0, linkRows.length - 1) })
    },
    infoOpen: () => {
      const { infoRows, linkRows, infoCur } = derive()
      const it = infoRows[linkRows[infoCur] ?? -1]
      if (it?.kind === "link") openLink(it)
      else if (it?.kind === "change") jumpChange(it.at)
    },
  } satisfies Partial<Actions>
}

/** The Files tab: move the cursor, open or peek a note, fold folders. */
export function makeFilesActions(c: AppCtx) {
  const { ui, set, derive, openFile, selectRow, toggleDir, focusDoc } = c
  return {
    filesMove: (k) => {
      const { s, rows, LH } = derive()
      const half = Math.max(1, Math.floor(LH / 2))
      if (k.name === "g") return selectRow(k.shift ? rows.length - 1 : 0)
      if (k.name === "pagedown" || k.name === "d") return selectRow(s.cursor + half)
      if (k.name === "pageup" || k.name === "u") return selectRow(s.cursor - half)
      selectRow(s.cursor + (isDown(k) ? 1 : -1))
    },
    filesOpen: () => {
      const { s, rows } = derive()
      const row = rows[s.cursor]
      if (!row) return
      if (row.node.dir) return toggleDir(row.node)
      openFile(row.node.path)
      focusDoc()
    },
    filesPeek: () => {
      const { s, rows } = derive()
      const row = rows[s.cursor]
      if (!row) return
      if (row.node.dir) return toggleDir(row.node, true)
      openFile(row.node.path)
    },
    filesUp: () => {
      const { s, rows } = derive()
      const row = rows[s.cursor]
      if (!row) return
      if (row.node.dir && s.expanded.has(row.node.path)) return toggleDir(row.node, false)
      const pi = rows.findIndex((r) => r.node.path === dirname(row.node.path))
      if (pi >= 0) selectRow(pi, "no")
    },
    filesTidy: () => {
      const s = ui.current
      set({ expanded: new Set(s.openPath ? ancestorsOf(s.tree, s.openPath) : []) })
    },
  } satisfies Partial<Actions>
}

/** The panel filter row (Files or Outline) while typing. */
export function makeFilterActions(c: AppCtx, { filterText, filterType, filterStop }: Popups, { outlineGo }: Moves) {
  const { ui, set, derive, openFile, selectRow, focusDoc } = c
  return {
    filterType: typing,
    filterMove: (k) => {
      const dn = k.name === "down" || k.name === "n"
      if (ui.current.view === "outline") {
        const { oRows, outlineCur } = derive()
        return set({ outlineCur: clamp(outlineCur + (dn ? 1 : -1), 0, oRows.length - 1) })
      }
      selectRow(ui.current.cursor + (dn ? 1 : -1))
    },
    filterOpen: () => {
      if (ui.current.view === "outline") {
        const { oRows, outlineCur } = derive()
        const r = oRows[outlineCur]
        filterStop(true)
        if (r) outlineGo(r.index)
        return
      }
      const { rows, s } = derive()
      const row = rows[s.cursor]
      filterStop(false)
      if (row && !row.node.dir) {
        openFile(row.node.path)
        focusDoc()
      }
    },
    filterClear: () => filterStop(true),
    filterLeave: () => {
      filterStop(false)
      focusDoc()
    },
    filterErase: () => {
      const v = filterText()
      if (!v) return filterStop(true)
      filterType(erase(v))
    },
  } satisfies Partial<Actions>
}

/** The help sheet, the find popup, the theme picker and the zen settings. */
export function makePopupActions(c: AppCtx, { zen, popups }: Features) {
  const { ui, set, dims } = c
  const {
    promptDefault,
    promptCount,
    promptHighlight,
    promptType,
    promptSubmit,
    promptClose,
    closeTheme,
    themeSet,
    applyTheme,
    helpGo,
  } = popups
  return {
    helpScroll: (k) => {
      const vis = helpLayout(HELP_GROUPS, dims.current.W, dims.current.H).vis
      const top = ui.current.helpTop
      if (k.name === "g" || k.name === "home") return helpGo(k.shift ? Infinity : 0)
      if (k.name === "end") return helpGo(Infinity)
      const page = ["space", "pagedown", "b", "pageup"].includes(k.name) || k.ctrl
      helpGo(top + (isDown(k) ? 1 : -1) * (page ? vis - 1 : 1))
    },
    helpClose: () => set({ help: false }),

    promptMove: (k) => {
      const pr = ui.current.prompt
      if (pr && promptCount() > 0)
        promptHighlight((pr.hl >= 0 ? pr.hl : promptDefault()) + (k.name === "down" ? 1 : -1))
    },
    promptApply: () => promptSubmit(),
    promptClear: promptClose,
    promptErase: () => {
      if (ui.current.prompt) promptType(erase(ui.current.prompt.value))
    },

    themeType: typing,
    themeMove: (k) => themeSet((p) => pickMove(p, k.name === "down" || (k.ctrl && k.name === "n") ? 1 : -1)),
    // ← → move across the board (dark / light), tab and S-tab flip; a single-mode family stays put (pickMode)
    themeMode: (k) => {
      if (k.name === "left") return themeSet((p) => pickMode(p, "dark"))
      themeSet((p) => pickMode(p, k.name === "right" ? "light" : undefined))
    },
    themeApply: applyTheme,
    themeClose: closeTheme,
    themeErase: () => themeSet((p) => pickQuery(p, erase(p.q))),

    zsMove: (k) => set({ zenRow: clamp(ui.current.zenRow + (isDown(k) ? 1 : -1), 0, ZEN_ROWS.length - 1) }),
    zsToggle: () => zen.zenEdit(ui.current.zenRow, 0),
    zsAdjust: (k) => zen.zenEdit(ui.current.zenRow, k.name === "right" || k.name === "l" ? 1 : -1),
    zsSave: zen.applyZen,
    zsRevert: zen.revertZen,
  } satisfies Partial<Actions>
}

/** The `C-p` switcher (ask included) and the `o` opener. */
export function makeSwitcherActions(c: AppCtx, { switcher, workspace }: Features) {
  const { ui, set, derive } = c
  const { closeSwitcher, swType, swGo, swActivate } = switcher
  const { opType, opGo, opComplete, opOpen } = workspace
  return {
    swType: typing,
    swMove: (k) => {
      const { swRows, swHl } = derive()
      swGo(stepRow(swRows, swHl, k.name === "down" || (k.ctrl && k.name === "n") ? 1 : -1))
    },
    swSection: () => {
      const { swRows, swHl, question } = derive()
      swGo(question ? askSection(swRows, swHl) : nextSection(swRows, swHl))
    },
    swOpen: () => swActivate(derive().swHl),
    swClose: closeSwitcher,
    swErase: () => {
      if (ui.current.switcher) swType(erase(ui.current.switcher.q))
    },
    swAsk: typing, // a `?` query is typed like any other
    opType: typing,
    opMove: (k) => {
      const { opRows, opHl } = derive()
      opGo(stepRow(opRows, opHl, k.name === "down" || (k.ctrl && k.name === "n") ? 1 : -1))
    },
    opComplete,
    opOpen: () => {
      const { opRows, opHl } = derive()
      opOpen(opRows[opHl])
    },
    opClose: () => set({ opener: null }),
    opErase: () => {
      if (ui.current.opener) opType(erase(ui.current.opener.q))
    },
  } satisfies Partial<Actions>
}
