// The app context every `src/app/*` factory closes over, built each render: the store, the refs, this render's size and
// props, toasts, fades and config saves, then navigation over them (scrolling, opening a note, focus, the Files cursor).
// Not pure: it holds the store and the timers.
import type { CliRenderer } from "@opentui/core"
import type { Dispatch, SetStateAction } from "react"
import { VIEWS, saveConfig, type Config, type SidebarConfig, type View } from "../system/config"
import { ancestorsOf, type FileNode } from "../notes/files"
import { keep, visit } from "../notes/history"
import type { Rendered } from "../markdown/render"
import { keepVisible } from "../ui/nav"
import { safeLine } from "../lib/spans"
import { GHOST_STEP, TOAST_HOLD, fadeStep, nextToast, type ToastKind } from "../ui/status"
import { clamp } from "../lib/text"
import { remember } from "../notes/vault"
import type { DeriveRefs, Derived } from "./derive"
import { OPEN_DELAY, type Spot, type UI } from "./store"

/** The timer slots: one pending timeout each (toast and hint fades, Files preview, teleprompter, AI redraw, …). */
export interface Timers {
  toast?: ReturnType<typeof setTimeout>
  open?: ReturnType<typeof setTimeout>
  roll?: ReturnType<typeof setTimeout>
  ghost?: ReturnType<typeof setTimeout>
  hints?: ReturnType<typeof setTimeout>
  logo?: ReturnType<typeof setTimeout>
  ai?: ReturnType<typeof setTimeout>
  gloss?: ReturnType<typeof setTimeout>
  steam?: ReturnType<typeof setTimeout>
}

/** The welcome page: highlighted row, recents generation, steam tick, ink frame, animation state, its start and size. */
export interface WelcomeState {
  hl: number
  gen: number
  tick: number
  ink: number
  run: "idle" | "live" | "done"
  at: number
  W: number
  H: number
}

/** What App builds from its hooks: the store and how to change it, this render's size and props, and the refs. */
export interface Base extends DeriveRefs {
  /** merge `patch` into the store and re-render */
  set: (patch: Partial<UI>) => void
  /** the raw re-render counter: `bump((x) => x + 1)` */
  bump: Dispatch<SetStateAction<number>>
  derive: () => Derived
  /** this render's terminal size */
  W: number
  H: number
  renderer: CliRenderer
  /** the `fetch` prop, else the global one */
  fetchImpl: typeof fetch
  /** the `themeName` prop (from `--theme` or the config) */
  themeName: string | undefined
  linkScanDelay: number
  /** normal-view position on entering zen; restored verbatim on exit unless the reader moved */
  zenBack: { current: Spot | null }
  timers: { current: Timers }
  /** tier 0 queries per question (foldSame), this session only: asking again sends nothing */
  askMemo: { current: Map<string, { queries: string[]; model: string }> }
  /** tier 1 orders per question + candidate list, this session only */
  rerankMemo: { current: Map<string, { order: string[]; why: Record<string, string>; model: string }> }
  /** false once unmounted: late timers and AI or highlight results drop their update */
  alive: { current: boolean }
  /** the document whose code highlighting was last asked for */
  hlSeen: { current: Rendered | null }
  /** `leave` has run: the last project record is written once */
  left: { current: boolean }
  welcome: { current: WelcomeState }
}

/** Fades, toasts and config saves. */
function makeFeedback(base: Base) {
  const { ui, set, bump, timers } = base
  /** Re-render through a fade: wait out `hold` after `at()`, then step every GHOST_STEP until hidden, then `done()`. */
  const runFade = (slot: "ghost" | "hints" | "toast" | "gloss", at: () => number | null, hold: number, done: () => void) => {
    clearTimeout(timers.current[slot])
    const tick = () => {
      const a = at()
      if (a === null) return
      const e = Date.now() - a
      if (fadeStep(e, hold) === null) return done()
      bump((x) => x + 1)
      timers.current[slot] = setTimeout(tick, e < hold ? hold - e : GHOST_STEP)
    }
    timers.current[slot] = setTimeout(tick, hold)
  }

  /** Toast on the ghost line's right; an error still holding is not replaced by ok / info. */
  const flash = (msg: string, kind: ToastKind = "info") => {
    const now = Date.now()
    // toasts carry names, paths and OS messages: never let one reach the terminal raw
    const next = nextToast(ui.current.toast, { msg: safeLine(msg), kind, at: now }, now)
    if (next === ui.current.toast) return
    set({ toast: next })
    runFade(
      "toast",
      () => ui.current.toast?.at ?? null,
      TOAST_HOLD[kind],
      () => set({ toast: null }),
    )
  }

  /** `saveConfig`, or an error toast when it refuses (a file that doesn't parse, a failed write). */
  const persist = (patch: Config) => {
    const ok = saveConfig(patch)
    if (!ok) flash("config.json not saved · it doesn't parse or can't be written", "error")
    return ok
  }

  return { runFade, flash, persist }
}

/** Scrolling the document: an explicit move, the teleprompter's stop, a find match. */
function makeScroll(base: Base) {
  const { ui, set, bump, derive, timers, scrolls, zenBack } = base
  const setTop = (n: number) => {
    zenBack.current = null // an explicit move (keys, find, jump, teleprompter tick) drops the exact restore
    const d = derive()
    scrolls.current.set(d.scrollKey, { top: Math.max(0, Math.min(n, d.maxTop)), geo: d.geo })
    bump((x) => x + 1)
  }

  const scrollBy = (n: number) => setTop(derive().top + n)

  // teleprompter: one line per tick at the configured wpm; any manual scroll pauses it
  const stopRolling = () => {
    clearTimeout(timers.current.roll)
    if (ui.current.rolling) set({ rolling: false })
  }

  /** Scroll so match line `m` sits a third of the way down (on the reading line in typewriter), and make it current. */
  const showMatch = (m: number) => {
    stopRolling()
    ui.current.matchLine = m
    const d = derive()
    setTop(d.tw || d.pg ? m : m - Math.floor(d.L.CH / 3))
  }

  return { setTop, scrollBy, stopRolling, showMatch }
}

/** Opening a note (history, the folders above it) and the Files cursor. */
function makeOpening(base: Base) {
  const { ui, set, derive, timers, sidebarSeen } = base
  /** The open note's scroll entry, as history keeps it. */
  const currentSpot = (): Spot | null => {
    if (!ui.current.openPath) return null
    const d = derive()
    return { key: d.scrollKey, top: d.top, geo: d.geo }
  }

  /** Open `path`; it goes into history (`peek`: a Files preview, replaced by the next open unless it gets focus). */
  const openFile = (path: string, how: "open" | "peek" | "history" = "open") => {
    clearTimeout(timers.current.open)
    const s = ui.current
    if (path === s.openPath) return
    const history = how === "history" ? s.history : visit(s.history, path, currentSpot(), how === "peek")
    // reveal it: every folder above the note opens (they are never closed automatically)
    const expanded = new Set(s.expanded)
    for (const a of ancestorsOf(s.tree, path)) expanded.add(a)
    set({ openPath: path, history, outlineCur: 0, infoCur: 0, matchLine: null, expanded, listTop: { ...s.listTop, outline: 0, info: 0 } })
    // the Files cursor jumps to the ● row and scrolls it into view
    const { rows, LH } = derive()
    const i = rows.findIndex((r) => r.node.path === path)
    if (i >= 0) {
      sidebarSeen.current.cursorPath = path
      set({ cursor: i, listTop: { ...ui.current.listTop, files: keepVisible(ui.current.listTop.files, i, LH, rows.length) } })
    }
  }

  /** Move the Files cursor; notes open once the cursor rests (`now` opens at once). */
  const selectRow = (i: number, open: "later" | "now" | "no" = "later") => {
    const { rows, LH } = derive()
    const s = ui.current
    const n = clamp(i, 0, rows.length - 1)
    const node = rows[n]?.node
    sidebarSeen.current.cursorPath = node?.path ?? null
    set({ cursor: n, listTop: { ...s.listTop, files: keepVisible(s.listTop.files, n, LH, rows.length) } })
    clearTimeout(timers.current.open)
    if (!node || node.dir || open === "no") return
    if (open === "now") openFile(node.path, "peek")
    else timers.current.open = setTimeout(() => openFile(node.path, "peek"), OPEN_DELAY)
  }

  const toggleDir = (node: FileNode, open?: boolean) => {
    const next = new Set(ui.current.expanded)
    if (open ?? !next.has(node.path)) next.add(node.path)
    else next.delete(node.path)
    set({ expanded: next })
  }

  return { currentSpot, openFile, selectRow, toggleDir }
}

/** The panel: its saved layout, the shown view, focus on the panel or the document. */
function makeFocus(c: Base & ReturnType<typeof makeFeedback> & ReturnType<typeof makeOpening>) {
  const { ui, set, derive, timers, persist, selectRow } = c
  /** Save the panel layout field that changed (`view` on change, `hidden` only by ^b inline); saveConfig merges it per field. */
  const saveSidebar = (patch: Partial<SidebarConfig>) => persist({ sidebar: patch, folds: undefined })

  /** Switch the panel view (saved). The Outline cursor starts on the heading being read. */
  const selectView = (v: View) => {
    if (v === ui.current.view) return
    if (v === "files" && ui.current.piped) v = "outline" // a piped session has no Files tab
    set({
      view: v,
      filterTyping: false,
      outlineFilter: "",
      ...(v === "outline"
        ? {
            outlineCur: Math.max(
              0,
              derive().oRows.findIndex((r) => r.current),
            ),
          }
        : {}),
    })
    if (!ui.current.piped) saveSidebar({ view: v })
  }

  /** The tabs, in `1 2 3` order: a piped session has no Files, also on a note followed from it. */
  const panelViews = (): readonly View[] => (ui.current.piped ? VIEWS.filter((v) => v !== "files") : VIEWS)

  /** Show the panel (unhide it inline, open the drawer) and focus it; Files lands on the open note. */
  const focusPanel = (v?: View) => {
    const was = derive().sideFocus
    if (v) selectView(v)
    const { L, rows, s, oRows } = derive()
    set({
      focus: "panel",
      ...(L.mode === "drawer" ? { drawerOpen: true } : { hidden: false }),
      ...(!was && s.view === "outline"
        ? {
            outlineCur: Math.max(
              0,
              oRows.findIndex((r) => r.current),
            ),
          }
        : {}),
    })
    if (!was && s.view === "files") {
      const i = rows.findIndex((r) => r.node.path === s.openPath)
      if (i >= 0) selectRow(i, "no")
    }
  }

  /** Focus the document; the drawer closes with it. */
  const focusDoc = () => {
    clearTimeout(timers.current.open)
    const s = ui.current
    set({ focus: "doc", drawerOpen: false, filterTyping: false, recent: remember(s.recent, s.openPath), history: keep(s.history) })
  }

  return { saveSidebar, selectView, panelViews, focusPanel, focusDoc }
}

/** The app context: `base` plus fades, toasts and config saves, then scrolling, opening a note, the Files cursor and focus. */
export function makeCtx(base: Base) {
  const core = { ...base, ...makeFeedback(base), ...makeScroll(base), ...makeOpening(base) }
  return { ...core, ...makeFocus(core) }
}
/** What every `src/app/*` factory takes. */
export type AppCtx = ReturnType<typeof makeCtx>
