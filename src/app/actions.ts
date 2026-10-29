// The key side of the app: the action behind every KEYMAP binding, dispatch by mode, the key handler, and what decides
// the context (popup, zen, panel view or document) the keys and hints go by. Not pure: `makeActions` closes over the
// app context and the feature factories.
import type { KeyEvent } from "@opentui/core"
import type { AppProps } from "../App"
import { closeSync, openSync } from "node:fs"
import { basename, dirname } from "node:path"
import { askSection } from "../ask"
import { loadConfig } from "../config"
import { quoteNeedle } from "../delta"
import { editorCommand, runEditor, sourceLineAt, type EditResult } from "../editor"
import { ancestorsOf, folderCounts, scanTree } from "../files"
import { helpLayout } from "../help"
import { HEADING_STYLES, parseFrontMatter, sourceScan } from "../markdown"
import { MINI_MIN_W } from "../minimap"
import { findQuote, matchKey, stepMatch } from "../nav"
import { findHeading } from "../panel"
import { headingKey } from "../sections"
import { HINT_HOLD, errText, fadeStep } from "../status"
import { clamp } from "../text"
import { pickMode, pickMove, pickQuery } from "../themepick"
import { nextSection, stepRow } from "../vault"
import { STDIN } from "../workspace"
import { ZEN_ROWS, ZEN_WPM, stepMeasure } from "../zen"
import type { AIJobs } from "./ai-jobs"
import type { AppCtx } from "./ctx"
import { erase, typed } from "./input"
import { HELP_GROUPS, KEY_IDS, WELCOME_OFF, ZEN_OFF, isDown, keyDef, modeOf, type Ctx, type KeyId, type Mode } from "./keymap"
import type { Links } from "./links"
import type { Popups } from "./popups"
import type { Focus } from "./store"
import type { SwitcherControl } from "./switcher"
import type { WorkspaceControl } from "./workspace"
import type { Zen } from "./zen"

/** The feature factories the actions call, and the `edit` prop (tests stub the editor). */
export interface Features {
  aiJobs: AIJobs
  links: Links
  zen: Zen
  switcher: SwitcherControl
  workspace: WorkspaceControl
  popups: Popups
  edit: AppProps["edit"]
}

/** The actions over the app context; App registers `onKey` and draws with the rest. */
export function makeActions(c: AppCtx, { aiJobs, links, zen, switcher, workspace, popups, edit: editImpl }: Features) {
  const { ui, set, derive, dims, memo, renderer, runFade, flash, persist, setTop, scrollBy, stopRolling, openFile, selectRow, toggleDir, saveSidebar, selectView, panelViews, focusPanel, focusDoc, showMatch } = c
  const { ensureGlosses, summarizeNote, explainChange, zenGloss } = aiJobs
  const { openLink, liveLabels, startLabels, histMove, labelType } = links
  const { startRolling, pokeGhost, toggleZen, setZen, goPage, zenScroll, openZenSettings, revertZen, applyZen, zenEdit } = zen
  const { closeSwitcher, swType, swGo, dropIndex, openSwitcher, swActivate } = switcher
  const { leave, opType, opGo, openOpener, opComplete, opOpen, welcomeKey, stopWelcome } = workspace
  const { startFilter, filterText, filterType, filterStop, promptDefault, promptCount, promptHighlight, promptType, promptSubmit, promptClose, openTheme, closeTheme, themeSet, applyTheme, helpGo } = popups

  /** Context id outside popups and zen: the focused panel view, else the document. */
  const docMode = (): Ctx => {
    const v = derive().sideFocus
    if (v && ui.current.filterTyping) return "filter"
    return v ? `panel:${v}` : "doc"
  }

  const jumpMatch = (dir: 1 | -1) => {
    const { matches, win, L, s, pg } = derive()
    // pages: only the current page's own lines count as on screen (not the blank pad above it)
    const m = pg
      ? stepMatch(matches, s.matchLine, pg.top, Math.min(L.CH, pg.end - pg.top), dir)
      : stepMatch(matches, s.matchLine, win.first, L.CH, dir)
    if (m === undefined) return s.query ? flash(`no match for “${s.query}”`, "error") : flash("nothing to find · / to search", "error")
    showMatch(m)
  }

  const jumpHeading = (dir: 1 | -1) => {
    const { view, top } = derive()
    const hs = view.headings
    const target = dir === 1 ? hs.find((h) => h.line > top) : hs.findLast((h) => h.line < top)
    if (target) setTop(target.line)
  }

  /** Scroll the document to heading `i` of the shown view; `peek` keeps the panel focused. */
  const outlineGo = (i: number, peek = false) => {
    const d = derive()
    const h = d.view.headings[i]
    if (!h) return
    setTop(h.line)
    if (!peek) {
      set({ outlineFilter: "", filterTyping: false })
      focusDoc()
    }
  }

  /** Scroll to change `at` of the Changed block: the reply's quote when it is in that section, else its heading. */
  const jumpChange = (at: number) => {
    const { cv, view, s } = derive()
    const c = cv?.changes[at]
    if (!c || c.status === "removed") return
    const hs = view.headings
    // rows listed while a request runs come from the sent text: a heading that moved is found again by key
    const i = c.index < 0 || headingKey(hs[c.index]?.text ?? "") === c.key ? c.index : (findHeading(hs, c.path.at(-1) ?? "") ?? c.index)
    const from = i < 0 ? 0 : (hs[i]?.line ?? 0)
    const to = hs[i + 1]?.line ?? view.lines.length
    const quote = cv?.notes[at]?.quote
    const line = quote ? findQuote(view.plain, from, to, quoteNeedle(quote, s.source)) : null
    setTop(line === null ? from : Math.max(from, line - 1))
    focusDoc()
  }

  /** Show the key hints for context `c` now; they hold HINT_HOLD, then fade. */
  const pokeHints = (c: Ctx) => {
    set({ hintAt: Date.now(), hintCtx: c })
    runFade("hints", () => ui.current.hintAt, HINT_HOLD, () => set({ hintAt: null }))
  }

  /** Context id now: an open popup, else zen, else the panel view or the document. */
  const currentCtx = (): Ctx => {
    const s = ui.current
    if (s.themePick) return "theme"
    if (s.zenOrig !== null) return "zenSettings"
    if (s.opener) return "open"
    if (s.switcher) return "switch"
    if (s.prompt) return "prompt"
    if (liveLabels()) return "label"
    if (s.help) return "help"
    return derive().L.zen ? "zen" : docMode()
  }
  const hintsVisible = () => {
    const s = ui.current
    return s.hintAt !== null && s.hintCtx === currentCtx() && fadeStep(Date.now() - s.hintAt, HINT_HOLD) !== null
  }

  /** The bindings without keys (`type`, `a–z`, `^p ?`) are there for help and the footer: `onKey` routes the typing itself. */
  const typing = () => {}

  const actions: Record<KeyId, (k: KeyEvent) => void> = {
    views: (k) => {
      const v = panelViews()[Number(k.name) - 1]
      if (!v) return
      if (derive().sideFocus) selectView(v)
      else focusPanel(v)
    },
    source: () => {
      set({ source: !ui.current.source, matchLine: null })
      pokeHints(currentCtx())
    },
    // the Source shown over zen (`z s`) is not zen on screen: z, w and esc go by the layout
    zen: () => toggleZen(!derive().L.zen),
    zenSettings: openZenSettings,
    sidebar: () => {
      const { L, sideFocus, s } = derive()
      if (L.mode === "drawer") return sideFocus ? focusDoc() : focusPanel()
      const hidden = !s.hidden
      set({ hidden, ...(hidden ? { focus: "doc" as Focus } : {}) })
      saveSidebar({ hidden })
    },
    width: () => {
      if (derive().L.zen) return // zen has its own measure (< >); full width is not shown there
      const wide = !ui.current.wide
      set({ wide })
      if (persist({ wide })) flash(wide ? "full width" : "measure 80")
    },
    minimap: () => {
      if (dims.current.W < MINI_MIN_W) return flash(`minimap needs ${MINI_MIN_W} columns`)
      const minimap = !ui.current.minimap
      set({ minimap })
      if (persist({ minimap })) flash(minimap ? "minimap on" : "minimap off")
    },
    headings: () => {
      const headingStyle = HEADING_STYLES[(HEADING_STYLES.indexOf(ui.current.headingStyle) + 1) % HEADING_STYLES.length]!
      set({ headingStyle })
      if (persist({ headings: headingStyle })) flash(`headings · ${headingStyle}`)
    },
    transparent: () => {
      const transparent = !ui.current.transparent
      set({ transparent })
      if (persist({ transparent })) flash(transparent ? "transparent background" : "opaque background")
    },
    switcher: openSwitcher,
    open: openOpener,
    slash: () => {
      const { sideFocus } = derive()
      if (!sideFocus) return set({ prompt: { value: "", hl: -1, top: 0 } })
      if (sideFocus === "info") selectView("files")
      startFilter()
    },
    focus: () => (derive().sideFocus ? focusDoc() : focusPanel()),
    theme: openTheme,
    reload: () => {
      const s = ui.current
      const piped = s.piped
      const tree = piped ? s.tree : scanTree(s.root)
      // folders that are gone are forgotten; the open note's path stays open
      const folders = folderCounts(tree)
      const expanded = new Set([...s.expanded].filter((p) => folders.has(p)))
      if (s.openPath) for (const a of ancestorsOf(tree, s.openPath)) expanded.add(a)
      const linkTree = piped ? (s.linkLazy ? s.linkTree : scanTree(s.root)) : s.linkRoot ? scanTree(s.linkRoot) : tree
      set({ tree, linkTree, expanded, reload: s.reload + 1, watchGen: s.watchGen + 1, ai: loadConfig().ai ?? null })
      if (ui.current.zen) ensureGlosses()
      dropIndex()
      flash("reloaded")
    },
    clear: () => {
      const { s, sideFocus, sheet } = derive()
      if (sideFocus) {
        if (sideFocus === "files" && s.filter) return set({ filter: "" })
        if (sideFocus === "outline" && s.outlineFilter) return set({ outlineFilter: "" })
        return focusDoc()
      }
      // a gloss on screen goes first; it stays hidden until the reading line leaves its section (a fading one falls through)
      if (sheet && sheet.fadeAt === null) return set({ gloss: null })
      if (s.toast?.kind === "error") set({ toast: null })
      if (s.query) set({ query: "", matchLine: null })
      else if (derive().L.zen) toggleZen(false)
    },
    // the welcome page shows no hints, so ? opens the sheet at once
    help: () => (hintsVisible() || !ui.current.openPath ? set({ help: true, helpTop: 0 }) : pokeHints(currentCtx())),
    histBack: () => histMove(-1),
    histForward: () => histMove(1),
    summarize: summarizeNote,
    explainChange,
    edit: () => {
      const s = ui.current
      if (!s.openPath) return flash("no note to edit", "error")
      if (s.openPath === STDIN) return flash("stdin · nothing to edit")
      const d = derive()
      const src = memo.read(s.openPath, s.reload)?.src ?? ""
      const line = sourceLineAt({ source: s.source, top: d.top, srcRow: d.view.srcRow, headings: d.view.headings, scan: sourceScan(src).headings, offset: parseFrontMatter(src).offset })
      const argv = editorCommand(process.env, s.openPath, line)
      const run =
        editImpl ??
        ((a: string[], piped: boolean) =>
          runEditor(a, piped, {
            openTTY: () => openSync("/dev/tty", "r"),
            close: closeSync,
            spawn: (argv, stdin) => Bun.spawnSync(argv, { stdio: [stdin, "inherit", "inherit"] }),
            suspend: () => renderer.suspend(),
            resume: () => renderer.resume(),
          }))
      let res: EditResult | void
      try {
        res = run(argv, s.piped)
      } catch (e) {
        return flash(`cannot run ${argv[0]}: ${errText(e)}`, "error")
      }
      if (res && "error" in res) return flash(res.error, "error")
      set({ reload: s.reload + 1 }) // a failed editor may still have saved
      const ed = basename(argv[0]!)
      if (res && res.code !== 0) return flash(res.signal ? `${ed} ended by ${res.signal}` : `${ed} exited with ${res.code}`, "error")
      flash(`edited · ${basename(s.openPath)}`)
    },
    quit: () => {
      leave()
      renderer.destroy()
      process.exit(0)
    },

    docLine: (k) => scrollBy(isDown(k) ? 1 : -1),
    docHalf: (k) => scrollBy((isDown(k) ? 1 : -1) * Math.max(1, Math.floor(derive().L.CH / 2))),
    docPage: (k) => scrollBy((isDown(k) ? 1 : -1) * (derive().L.CH - 2)),
    docEnds: (k) => setTop(k.name === "g" && !k.shift ? 0 : k.name === "home" ? 0 : derive().maxTop),
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
    zenGloss,
    zenSection: (k) => {
      stopRolling()
      const dir = k.sequence === "]" || k.sequence === "}" ? 1 : -1
      const { pg } = derive()
      if (pg) goPage(pg.index + dir)
      else jumpHeading(dir)
    },
    zenMeasure: (k) => {
      if (setZen({ measure: stepMeasure(ui.current.zenCfg.measure, k.sequence === ">" ? 1 : -1) }, true)) flash(`measure ${ui.current.zenCfg.measure}`)
    },
    zenSpeed: (k) => {
      if (setZen({ wpm: ui.current.zenCfg.wpm + (k.sequence === "+" ? 1 : -1) * ZEN_WPM.step }, true)) flash(`${ui.current.zenCfg.wpm} wpm`)
    },

    outlineMove: (k) => {
      const { outlineCur, oRows } = derive()
      const n = oRows.length
      const next = k.name === "g" ? (k.shift ? n - 1 : 0) : outlineCur + (isDown(k) ? 1 : -1)
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

    infoMove: (k) => {
      const { linkRows, infoRows, infoCur, LH, s } = derive()
      const max = Math.max(0, infoRows.length - LH)
      const scroll = (to: number) => set({ listTop: { ...s.listTop, info: Math.max(0, Math.min(max, to)) } })
      const toEdge = k.name === "g" ? (k.shift ? max : 0) : undefined
      const dir = isDown(k) ? 1 : -1
      if (!linkRows.length) return scroll(toEdge ?? s.listTop.info + dir)
      // at the first/last link the keys scroll the rest of the list into view
      const last = linkRows.length - 1
      if (k.name === "g" ? infoCur === (k.shift ? last : 0) : infoCur === (dir > 0 ? last : 0)) return scroll(toEdge ?? s.listTop.info + dir)
      set({ infoCur: clamp(k.name === "g" ? (k.shift ? last : 0) : infoCur + dir, 0, linkRows.length - 1) })
    },
    infoOpen: () => {
      const { infoRows, linkRows, infoCur } = derive()
      const it = infoRows[linkRows[infoCur] ?? -1]
      if (it?.kind === "link") openLink(it)
      else if (it?.kind === "change") jumpChange(it.at)
    },

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
      if (pr && promptCount() > 0) promptHighlight((pr.hl >= 0 ? pr.hl : promptDefault()) + (k.name === "down" ? 1 : -1))
    },
    promptApply: () => promptSubmit(),
    promptClear: promptClose,
    promptErase: () => {
      if (ui.current.prompt) promptType(erase(ui.current.prompt.value))
    },
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

    themeType: typing,
    themeMove: (k) => themeSet((p) => pickMove(p, k.name === "down" || (k.ctrl && k.name === "n") ? 1 : -1)),
    // ← → move across the board (dark / light), tab and S-tab flip; a single-mode family stays put (pickMode)
    themeMode: (k) => themeSet((p) => pickMode(p, k.name === "left" ? "dark" : k.name === "right" ? "light" : undefined)),
    themeApply: applyTheme,
    themeClose: closeTheme,
    themeErase: () => themeSet((p) => pickQuery(p, erase(p.q))),

    zsMove: (k) => set({ zenRow: clamp(ui.current.zenRow + (isDown(k) ? 1 : -1), 0, ZEN_ROWS.length - 1) }),
    zsToggle: () => zenEdit(ui.current.zenRow, 0),
    zsAdjust: (k) => zenEdit(ui.current.zenRow, k.name === "right" || k.name === "l" ? 1 : -1),
    zsSave: applyZen,
    zsRevert: revertZen,
  }

  /** Run the first binding of the given modes (in order) that matches `k`; `skip` bindings are ignored. */
  const dispatch = (modes: Mode[], k: KeyEvent, skip: readonly KeyId[] = []) => {
    for (const m of modes)
      for (const id of KEY_IDS) {
        if (skip.includes(id)) continue
        const def = keyDef(id)
        if (def.modes.includes(m) && def.keys.some((spec) => matchKey(spec, k))) {
          actions[id](k)
          return true
        }
      }
    return false
  }

  /** The key handler: C-c, then the open popup or typing, then zen, the welcome page and the bindings of the focused view. */
  const onKey = (key: KeyEvent) => {
    // C-c quits the same way from every popup and mode (OpenTUI would only end the renderer)
    if (matchKey("C-c", key)) return actions.quit(key)
    stopWelcome()
    const s = ui.current
    if (s.zen && s.zenCfg.ghost) pokeGhost()
    const text = typed(key)
    if (s.themePick) {
      if (!dispatch(["theme"], key) && text) themeSet((p) => pickQuery(p, p.q + text))
      return
    }
    if (s.zenOrig !== null) return void dispatch(["zenSettings"], key)
    if (s.opener) {
      if (!dispatch(["open"], key) && text) opType(s.opener.q + text)
      return
    }
    if (s.switcher) {
      if (!dispatch(["switch"], key) && text) swType(s.switcher.q + text)
      return
    }
    if (s.prompt) {
      if (!dispatch(["prompt"], key) && text) promptType(s.prompt.value + text)
      return
    }
    // labels the view has moved out from under (reload, resize, scroll) are dropped and the key is swallowed, like any other that cancels
    if (s.labels && !liveLabels()) return void set({ labels: null })
    if (s.labels) {
      if (dispatch(["label"], key)) return
      if (text && /^[a-z]$/.test(text)) return labelType(text)
      return void set({ labels: null }) // any other key cancels
    }
    if (s.help) {
      if (!dispatch(["help"], key)) set({ help: false })
      return
    }
    // the panel filter row captures typing, j k 1 2 3 / ? included
    if (s.filterTyping && derive().sideFocus) {
      if (!dispatch(["filter"], key) && text) filterType(filterText() + text)
      return
    }
    // zen bindings shadow the document ones; n / N and the global keys fall through
    if (derive().L.zen) return void dispatch(["zen", "global", "doc"], key, ZEN_OFF)
    if (!s.openPath && docMode() === "doc" && welcomeKey(key)) return
    dispatch(["global", modeOf(docMode())], key, s.openPath ? undefined : WELCOME_OFF)
  }

  return { currentCtx, pokeHints, outlineGo, jumpChange, onKey }
}
