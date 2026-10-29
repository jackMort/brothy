import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { closeSync, openSync } from "node:fs"
import { basename, dirname } from "node:path"
import { useEffect, useRef, useState } from "react"
import { ancestorsOf, folderCounts, scanTree } from "./files"
import { ensureHighlights } from "./highlight"
import { HEADING_STYLES, parseFrontMatter, sourceScan, pendingHighlights, type Rendered } from "./markdown"
import { clamp } from "./text"
import { headingKey } from "./sections"
import { makeAIJobs, type Job } from "./app/ai-jobs"
import { makeDerive, makeMemo } from "./app/derive"
import { makeCore, makeNav, type Timers, type WelcomeState } from "./app/ctx"
import { makeLinks } from "./app/links"
import { makeZen } from "./app/zen"
import { makeSwitcher } from "./app/switcher"
import { makeWorkspace } from "./app/workspace"
import { useAppEffects } from "./app/effects"
import { erase, typed } from "./app/input"
import { panelBox } from "./app/Panel"
import { docBox, miniBox } from "./app/Document"
import { gapRow, ghostLine, progressLine, topRow } from "./app/Chrome"
import { findOverlay, helpOverlay, openOverlay, switchOverlay, themeOverlay, themePickView, zenOverlay } from "./app/Overlays"
import { ZEN_DIM, initUI, type FileRow, type Focus, type Spot, type UI } from "./app/store"
import { FOOTERS, HELP_GROUPS, KEY_IDS, WELCOME_OFF, ZEN_OFF, isDown, keyDef, modeOf, type Ctx, type KeyId, type Mode } from "./app/keymap"
import { STDIN } from "./workspace"
import { DRAWER_BELOW } from "./layout"
import { surface, themes } from "./theme"
import { usePointer } from "./overlay"
import { helpLayout } from "./help"
import { STILL_TICK } from "./welcome"
import { INK_STEPS } from "./chrome"
import { emptyIndex, nextSection, stepRow, type VaultIndex } from "./vault"
import { MINI_MIN_W } from "./minimap"
import { filterFamilies, pickIndex, pickMode, pickMove, pickQuery, pickStart, pickTheme, type ThemePick } from "./themepick"
import { loadConfig } from "./config"
import { findQuote, keepVisible, matchKey, stepMatch, type Geometry } from "./nav"
import { editorCommand, runEditor, sourceLineAt, type EditResult } from "./editor"
import { askSection } from "./ask"
import { GHOST_STEPS, HINT_HOLD, errText, fadeStep, tooSmall, type HintItem } from "./status"
import { findHeading } from "./panel"
import { quoteNeedle } from "./delta"
import { ZEN_ROWS, ZEN_WPM, stepMeasure } from "./zen"

export const VERSION = "0.2.0"

export interface AppProps {
  root: string
  initialFile?: string
  themeName?: string
  /** `--transparent`: wins over the config for this run (a live toggle still saves). */
  transparent?: boolean
  /** injected by tests; the CLI uses the global fetch */
  fetch?: typeof fetch
  /** runs the editor and waits (tests stub it; the default is `runEditor`); `piped`: keys come from /dev/tty */
  edit?: (argv: string[], piped: boolean) => EditResult | void
  /** Markdown piped on stdin: the only document, with no Files tree, watcher or project record */
  stdin?: string
  /** ms after mount before a piped document's links start scanning in the background (tests delay it) */
  linkScanDelay?: number
  /** animations; tests and snapshots run without them unless this says true (default: config `motion`, on) */
  motion?: boolean
}

// ------------------------------------------------------------- app

export function App({ root: startRoot, initialFile, themeName, transparent, fetch: fetchImpl = globalThis.fetch, edit: editImpl, stdin, linkScanDelay = 0, motion }: AppProps) {
  const renderer = useRenderer()
  const pointer = usePointer()
  const { width: W, height: H } = useTerminalDimensions()
  const dims = useRef({ W, H })
  dims.current = { W, H }

  // a ref-like box built once, on the first render: handlers read `ui.current` at call time
  const [ui] = useState(() => ({ current: initUI(startRoot, initialFile, themeName, transparent, stdin !== undefined, motion) }))
  const [, bump] = useState(0)
  const set = (patch: Partial<UI>) => {
    Object.assign(ui.current, patch)
    bump((x) => x + 1)
  }

  // crossing DRAWER_BELOW: a focused panel becomes an open drawer; widening shows it inline again
  const modeSeen = useRef<"inline" | "drawer" | null>(null)
  const modeNow = W < DRAWER_BELOW ? "drawer" : "inline"
  if (modeSeen.current !== modeNow) {
    const s0 = ui.current
    if (modeSeen.current === "inline") s0.drawerOpen = s0.focus === "panel" && !s0.hidden && !s0.zen
    if (modeSeen.current === "drawer") {
      s0.drawerOpen = false
      if (s0.hidden && s0.focus === "panel") {
        s0.focus = "doc"
        s0.filterTyping = false
      }
    }
    modeSeen.current = modeNow
  }

  // derived data, memoized so handlers and render can both pull it on demand
  /** the switcher's index of `linkTree`; replaced (never mutated) when dropped, so a stale build sees it and stops */
  const vault = useRef<{ ix: VaultIndex; running: boolean }>({ ix: emptyIndex(), running: false })
  const memo = useRef(makeMemo(stdin)).current
  /** The match list last derived, to remap `matchLine` when the lines are re-wrapped. */
  const matchSeen = useRef<{ matches: number[]; query: string }>({ matches: [], query: "" })
  const scrolls = useRef(new Map<string, { top: number; geo: Geometry }>())
  /** Normal-view position on entering zen; restored verbatim on exit unless the reader moved. */
  const zenBack = useRef<Spot | null>(null)
  const sidebarSeen = useRef<{ rows: FileRow[] | null; cursorPath: string | null }>({ rows: null, cursorPath: null })
  const timers = useRef<Timers>({})
  /** AI requests in flight by `jobKey`: the raw streamed text and how to cancel it */
  const jobs = useRef(new Map<string, Job>())
  /** tier 0 queries per question (foldSame), this session only: asking again sends nothing */
  const askMemo = useRef(new Map<string, { queries: string[]; model: string }>())
  /** tier 1 orders per question + candidate list, this session only */
  const rerankMemo = useRef(new Map<string, { order: string[]; why: Record<string, string>; model: string }>())
  /** the context the hints were last poked for */
  const ctxSeen = useRef<Ctx | null>(null)
  /** the note and section the gloss auto-show last ran for (null: outside zen) */
  const glossSeen = useRef<string | null>(null)
  /** false once unmounted: late timers and AI or highlight results drop their update */
  const alive = useRef(true)
  /** the document and the theme sample whose code highlighting was last asked for */
  const hlSeen = useRef<Rendered | null>(null)
  const hlSample = useRef<Rendered | null>(null)
  /** `leave` has run: the last project record is written once */
  const left = useRef(false)
  /** the welcome page: highlighted row, recents generation, steam tick, ink frame, animation state, its start and size */
  const welcome = useRef<WelcomeState>({ hl: 1, gen: 0, tick: STILL_TICK, ink: INK_STEPS - 1, run: "idle", at: 0, W, H })

  const derive = makeDerive({ ui, dims, memo, vault, jobs, sidebarSeen, scrolls, matchSeen })
  /** Context id outside popups and zen: the focused panel view, else the document. */
  const docMode = (): Ctx => {
    const v = derive().sideFocus
    if (v && ui.current.filterTyping) return "filter"
    return v ? `panel:${v}` : "doc"
  }

  // the app context in layers (core, then nav) and the feature factories over it, rebuilt every render: handlers close
  // over this render's size and props, and read the store at call time
  const ctx = makeNav(
    makeCore({
      ui, set, bump, derive, dims, memo, vault, jobs, sidebarSeen, scrolls, matchSeen, W, H, renderer,
      fetchImpl, themeName, linkScanDelay, zenBack, timers, askMemo, rerankMemo, alive, hlSeen, left, welcome,
    }),
  )
  const { runFade, flash, persist, setTop, scrollBy, stopRolling, openFile, selectRow, toggleDir, saveSidebar, selectView, panelViews, focusPanel, focusDoc, showMatch } =
    ctx
  const aiJobs = makeAIJobs(ctx)
  const { ensureGlosses, glossEntered, dropDelta, summarizeNote, explainChange, zenGloss } = aiJobs
  const links = makeLinks(ctx)
  const { ensureLinks, openLink, liveLabels, startLabels, histMove, labelType } = links
  const { startRolling, pokeGhost, toggleZen, setZen, goPage, zenScroll, openZenSettings, revertZen, applyZen, zenEdit } =
    makeZen(ctx, aiJobs)
  const switcher = makeSwitcher(ctx, links)
  const { closeSwitcher, swType, swGo, dropIndex, openSwitcher, swActivate } = switcher
  const workspaceControl = makeWorkspace(ctx, switcher, aiJobs)
  const { recordProject, leave, opType, opGo, openOpener, opComplete, opOpen, welcomeRows, welcomeOpen, welcomeKey, stopWelcome, animateWelcome } =
    workspaceControl

  // ---------------------------------------------------- actions
  const startFilter = () => set({ filterTyping: true })
  /** The filter text of the shown view (Files or Outline). */
  const filterText = () => (ui.current.view === "outline" ? ui.current.outlineFilter : ui.current.filter)
  const filterType = (v: string) => {
    clearTimeout(timers.current.open) // a preview armed for the old results must not fire
    set(ui.current.view === "outline" ? { outlineFilter: v, outlineCur: 0 } : { filter: v })
  }
  /** Leave typing; `clear` also empties the shown view's filter. */
  const filterStop = (clear: boolean) => {
    clearTimeout(timers.current.open)
    set({ filterTyping: false, ...(clear ? (ui.current.view === "outline" ? { outlineFilter: "" } : { filter: "" }) : {}) })
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
    const quote = cv!.notes[at]?.quote
    const line = quote ? findQuote(view.plain, from, to, quoteNeedle(quote, s.source)) : null
    setTop(line === null ? from : Math.max(from, line - 1))
    focusDoc()
  }

  // `t` picker: the app stays in its theme while you move (only the pane shows the candidate); ⏎ applies and saves, esc changes nothing
  const openTheme = () => set({ themePick: pickStart(themes[ui.current.themeIdx]!) })
  const closeTheme = () => set({ themePick: null })
  const themeSet = (p: ThemePick) => set({ themePick: p })
  /** ⏎ or a click: the candidate becomes the theme; with no row listed nothing happens */
  const applyTheme = () => {
    const p = ui.current.themePick
    if (!p || pickIndex(p, filterFamilies(p.q)) < 0) return
    const name = pickTheme(p).name
    set({ themeIdx: themes.findIndex((x) => x.name === name), themePick: null })
    if (persist({ theme: name })) flash(`theme · ${name}`, "ok")
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

  /** The popup row Enter acts on when the highlight hasn't been moved. */
  const promptDefault = () => {
    const { matches, top } = derive()
    return Math.max(0, matches.findIndex((m) => m >= top))
  }
  const promptCount = () => derive().matches.length
  const promptHighlight = (hl: number) => {
    const pr = ui.current.prompt
    if (!pr) return
    const { L } = derive()
    const n = clamp(hl, 0, promptCount() - 1)
    const top = keepVisible(pr.hl >= 0 ? pr.top : keepVisible(0, promptDefault(), L.PH, promptCount()), n, L.PH, promptCount())
    set({ prompt: { ...pr, hl: n, top } })
  }
  const promptType = (v: string) => set({ prompt: { ...ui.current.prompt!, value: v, hl: -1, top: 0 }, query: v, matchLine: null })
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

  const helpGo = (n: number) => {
    const l = helpLayout(HELP_GROUPS, dims.current.W, dims.current.H)
    set({ helpTop: Math.max(0, Math.min(l.rows - l.vis, n)) })
  }

  // ---------------------------------------------------- effects
  const { openPath } = ui.current
  useAppEffects(ctx, { dropDelta, ensureLinks, recordProject, leave, animateWelcome })

  // ---------------------------------------------------- keys
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
      const headings = HEADING_STYLES[(HEADING_STYLES.indexOf(ui.current.headings) + 1) % HEADING_STYLES.length]!
      set({ headings })
      if (persist({ headings })) flash(`headings · ${headings}`)
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
      const line = sourceLineAt({ source: s.source, top: d.top, srcRow: d.view.srcRow, headings: d.view.headings, scan: sourceScan(src, themes[s.themeIdx]!).headings, offset: parseFrontMatter(src).offset })
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
    labelType: () => {},
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

    filterType: () => {},
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
      const pr = ui.current.prompt!
      if (promptCount() > 0) promptHighlight((pr.hl >= 0 ? pr.hl : promptDefault()) + (k.name === "down" ? 1 : -1))
    },
    promptApply: () => promptSubmit(),
    promptClear: promptClose,
    promptErase: () => promptType(erase(ui.current.prompt!.value)),
    swType: () => {},
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
    swAsk: () => {}, // help only: a `?` query is typed like any other
    opType: () => {},
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

    themeType: () => {},
    themeMove: (k) => themeSet(pickMove(ui.current.themePick!, k.name === "down" || (k.ctrl && k.name === "n") ? 1 : -1)),
    // ← → move across the board (dark / light), tab and S-tab flip; a single-mode family stays put (pickMode)
    themeMode: (k) => themeSet(pickMode(ui.current.themePick!, k.name === "left" ? "dark" : k.name === "right" ? "light" : undefined)),
    themeApply: applyTheme,
    themeClose: closeTheme,
    themeErase: () => {
      const p = ui.current.themePick!
      themeSet(pickQuery(p, erase(p.q)))
    },

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

  useKeyboard((key: KeyEvent) => {
    // C-c quits the same way from every popup and mode (OpenTUI would only end the renderer)
    if (matchKey("C-c", key)) return actions.quit(key)
    stopWelcome()
    const s = ui.current
    if (s.zen && s.zenCfg.ghost) pokeGhost()
    const text = typed(key)
    if (s.themePick) {
      if (!dispatch(["theme"], key) && text) themeSet(pickQuery(s.themePick, s.themePick.q + text))
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
  })

  // ---------------------------------------------------- render
  const d = derive()
  const { s, L, t } = d
  const paint = surface(t, s.transparent)

  // the panel and the document write the list tops and the welcome row back to the store as they draw: always built,
  // even when zen or a too-small terminal leaves them off screen
  const panelEl = panelBox(ctx, d, { outlineGo, jumpChange, openLink })
  const docEl = docBox(ctx, d, { welcomeRows, welcomeOpen, zenScroll })
  const miniEl = miniBox(ctx, d)
  const progressEl = progressLine(ctx, d)

  // any context change (focus, view, zen, popup closed, typing ended) shows the new context's hints
  const ctxNow = currentCtx()
  useEffect(() => {
    if (ctxNow === ctxSeen.current) return
    ctxSeen.current = ctxNow
    pokeHints(ctxNow)
  })

  // zen gloss: runs when the reading line changes section (not on every scroll tick)
  const glossAt = L.zen && openPath ? `${openPath}\0${d.currentHeading}` : null
  useEffect(() => {
    if (glossAt === glossSeen.current) return
    glossSeen.current = glossAt
    glossEntered()
  })

  // ghost line (row H-2): key hints on the left, a toast on the right; blank at rest
  const pinned = ["prompt", "theme", "zenSettings", "help", "filter", "label", "switch", "open"].includes(ctxNow)
  /** Key hints for context `c`, before fitting. */
  const hintRow = (c: Ctx): HintItem[] => {
    const items: HintItem[] = []
    for (const h of FOOTERS[c]) {
      const [id, word] = Array.isArray(h) ? h : [h, undefined]
      if (id === "docMatch" && !s.query) continue
      if (id === "links" && s.source) continue // labels are Preview only
      if (id === "edit" && s.openPath === STDIN) continue // nothing on disk to edit
      if ((id === "summarize" || id === "zenGloss") && !s.ai) continue // AI is off until an `ai` block is configured
      if (id === "explainChange" && (!s.ai || !d.cv || d.cv.state === "result")) continue // only while there are changes to explain
      const def = keyDef(id)
      items.push({ key: def.short ?? def.label, word: word ?? def.hint ?? "", spare: id === "links" || id === "histBack" || id === "summarize" || id === "zenGloss" || id === "explainChange" || id === "edit" || id === "themeType" })
    }
    return items
  }
  const ghostEl = ghostLine(ctx, d, { ctx: ctxNow, pinned, hints: hintRow })

  const helpEl = helpOverlay(ctx, d, { version: VERSION, helpGo })
  const switchEl = switchOverlay(ctx, d, switcher)
  const openEl = openOverlay(ctx, d, workspaceControl)
  const findEl = findOverlay(ctx, d, { promptDefault, promptHighlight, promptSubmit, promptClose })
  const pickView = themePickView(ctx, d)
  const pickSample = pickView?.sample ?? null
  // the sample's code block colours in once the highlighter answers (its cache serves every theme after that)
  useEffect(() => {
    if (!pickSample || pickSample === hlSample.current) return
    hlSample.current = pickSample
    const reqs = pendingHighlights(pickSample)
    if (reqs.length)
      ensureHighlights(reqs).then((changed) => {
        if (changed && alive.current) set({ hl: ui.current.hl + 1 })
      })
  })
  const themeEl = themeOverlay(ctx, d, pickView, { closeTheme, themeSet, applyTheme })
  const zenEl = zenOverlay(ctx, d, { revertZen, zenEdit })

  if (W < 60 || H < 14)
    return (
      <box style={{ width: W, height: H, backgroundColor: paint.main, alignItems: "center", justifyContent: "center" }}>
        {tooSmall(W, H).map((l, i) => (
          <text key={i} wrapMode="none" fg={t.textMuted}>
            {l}
          </text>
        ))}
      </box>
    )

  if (L.zen) {
    // Ghost on: the top line is full after a key, then fades; Ghost off: dimmed. Hints and toasts have their own lifetimes.
    const step = s.zenCfg.ghost ? (s.ghostAt === null ? null : fadeStep(Date.now() - s.ghostAt)) : undefined
    const topK = step === undefined ? ZEN_DIM : step === null ? null : step / (GHOST_STEPS + 1)
    return (
      <box key="zen" onMouse={pointer.note} style={{ width: W, height: H, flexDirection: "column", backgroundColor: paint.main }}>
        {topRow(d, topK)}
        {gapRow(d)}
        <box style={{ flexDirection: "row", height: L.bodyH, paddingLeft: 1, paddingRight: 1 }}>{docEl}</box>
        {ghostEl}
        {progressEl}
        {helpEl}
        {findEl}
        {switchEl}
        {openEl}
        {themeEl}
        {zenEl}
      </box>
    )
  }

  return (
    <box key="main" onMouse={pointer.note} style={{ width: W, height: H, flexDirection: "column", backgroundColor: paint.main }}>
      {topRow(d, 0)}
      {gapRow(d)}
      <box style={{ flexDirection: "row", height: L.bodyH, paddingLeft: 1, paddingRight: L.mini ? 0 : 1, gap: 1 }}>
        {L.inline ? panelEl : null}
        {docEl}
        {miniEl}
      </box>
      {ghostEl}
      {progressEl}
      {L.shown && !L.inline ? panelEl : null}
      {helpEl}
      {findEl}
      {switchEl}
      {openEl}
      {themeEl}
      {zenEl}
    </box>
  )
}
