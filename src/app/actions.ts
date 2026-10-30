// The key side of the app: the action behind every KEYMAP binding and what decides the context (popup, zen, panel view
// or document) the keys and hints go by. `makeActions` composes one factory per family of bindings: the global ones here,
// the document, zen, panel and popup ones in view-actions.ts; the key handler is in dispatch.ts. Not pure: the factories
// close over the app context and the feature factories.

import { closeSync, openSync } from "node:fs"
import { basename } from "node:path"
import type { KeyEvent } from "@opentui/core"
import { parseFrontMatter } from "../markdown/frontmatter"
import { HEADING_STYLES } from "../markdown/heading-style"
import { sourceScan } from "../markdown/source"
import { ancestorsOf, folderCounts, scanTree } from "../notes/files"
import { STDIN } from "../notes/workspace"
import { loadConfig, type View } from "../system/config"
import { type EditResult, editorCommand, runEditor, sourceLineAt } from "../system/editor"
import { MEASURE } from "../ui/layout"
import { MINI_MIN_W } from "../ui/minimap"
import { stepMatch } from "../ui/nav"
import type { InfoItem } from "../ui/panel"
import { errText, fadeStep, HINT_HOLD } from "../ui/status"
import type { AIJobs } from "./ai-jobs"
import type { AppCtx } from "./ctx"
import { makeOnKey } from "./dispatch"
import type { Ctx, KeyId } from "./keymap"
import type { Links } from "./links"
import type { Popups } from "./popups"
import type { Focus, UI } from "./store"
import type { SwitcherControl } from "./switcher"
import {
  makeDocActions,
  makeFilesActions,
  makeFilterActions,
  makeInfoActions,
  makeOutlineActions,
  makePopupActions,
  makeSwitcherActions,
  makeZenActions,
} from "./view-actions"
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
  edit: ((argv: string[], piped: boolean) => EditResult | void) | undefined
}

/** One action per KEYMAP id; each family's factory returns its part. */
export type Actions = Record<KeyId, (k: KeyEvent) => void>

/** The actions over the app context; App registers `onKey` and draws with the rest. */
export function makeActions(c: AppCtx, f: Features) {
  const keys = makeKeyContext(c, f.links)
  const moves = makeMoves(c, f.links)
  const actions: Actions = {
    ...makeToggleActions(c, f, keys),
    ...makeGlobalActions(c, f, keys),
    ...makeEditAction(c, f),
    ...makeDocActions(c, f.links, moves),
    ...makeZenActions(c, f, moves),
    ...makeOutlineActions(c, moves),
    ...makeInfoActions(c, moves),
    ...makeFilesActions(c),
    ...makeFilterActions(c, f.popups, moves),
    ...makePopupActions(c, f),
    ...makeSwitcherActions(c, f),
  }
  const { currentCtx, pokeHints } = keys
  return {
    currentCtx,
    pokeHints,
    outlineGo: moves.outlineGo,
    infoGo: moves.infoGo,
    onKey: makeOnKey(c, f, actions, keys.docMode),
  }
}

/** The context the keys and hints go by, and the key hints' fade. */
function makeKeyContext(c: AppCtx, { liveLabels }: Pick<Links, "liveLabels">) {
  const { ui, set, derive, runFade } = c

  /** Context id outside popups and zen: the focused panel view, else the document. */
  const docMode = (): Ctx => {
    const v = derive().sideFocus
    if (v && ui.current.filterTyping) return "filter"
    return v ? `panel:${v}` : "doc"
  }

  /** Show the key hints for context `c` now; they hold HINT_HOLD, then fade. */
  const pokeHints = (c: Ctx) => {
    set({ hintAt: Date.now(), hintCtx: c })
    runFade(
      "hints",
      () => ui.current.hintAt,
      HINT_HOLD,
      () => set({ hintAt: null }),
    )
  }

  /** Context id now: an open popup, else zen, else the panel view or the document. */
  const currentCtx = (): Ctx => {
    const s = ui.current
    const popup = popupCtx(s)
    if (popup) return popup
    if (liveLabels()) return "label"
    if (s.help) return "help"
    const d = derive()
    if (d.L.zen) return "zen"
    const doc = docMode()
    return doc === "doc" && d.land ? "landing" : doc
  }
  const hintsVisible = () => {
    const s = ui.current
    return s.hintAt !== null && s.hintCtx === currentCtx() && fadeStep(Date.now() - s.hintAt, HINT_HOLD) !== null
  }

  return { docMode, pokeHints, currentCtx, hintsVisible }
}
type KeyContext = ReturnType<typeof makeKeyContext>

/** The open popup's context (they take every key, in this order), else null. */
function popupCtx(s: UI): Ctx | null {
  if (s.themePick) return "theme"
  if (s.zenOrig !== null) return "zenSettings"
  if (s.opener) return "open"
  if (s.switcher) return "switch"
  return s.prompt ? "prompt" : null
}

/** Moves within the note and Info: to a find match, a heading, an Outline heading, a Changed row; Info's stops. */
function makeMoves(c: AppCtx, { openLink, jumpChange }: Pick<Links, "openLink" | "jumpChange">) {
  const { set, derive, flash, setTop, focusDoc, showMatch } = c

  const jumpMatch = (dir: 1 | -1) => {
    const { matches, win, L, s, pg } = derive()
    // pages: only the current page's own lines count as on screen (not the blank pad above it)
    const m = pg
      ? stepMatch(matches, s.matchLine, pg.top, Math.min(L.CH, pg.end - pg.top), dir)
      : stepMatch(matches, s.matchLine, win.first, L.CH, dir)
    if (m === undefined)
      return s.query ? flash(`no match for “${s.query}”`, "error") : flash("nothing to find · / to search", "error")
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

  /** `+ n more`: list every change, or fold back to MAX_CHANGE_ROWS; Info's cursor stays on the row. */
  const toggleChanges = () => {
    set({ changesOpen: !derive().s.changesOpen })
    const { linkRows, infoRows } = derive()
    set({
      infoCur: Math.max(
        0,
        linkRows.findIndex((i) => infoRows[i]?.kind === "cmore"),
      ),
    })
  }

  /** `⏎` or a click on an Info stop: follow the link, go to the change, open or fold `+ n more` or a long TL;DR. */
  const infoGo = (it: InfoItem) => {
    if (it.kind === "link") openLink(it)
    else if (it.kind === "change") jumpChange(it.at)
    else if (it.kind === "cmore") toggleChanges()
    else if (it.kind === "frule") set({ tldrOpen: !derive().s.tldrOpen })
  }

  return { jumpMatch, jumpHeading, outlineGo, infoGo }
}
export type Moves = ReturnType<typeof makeMoves>

/** The global switches: panel views and visibility, Source, zen, width, minimap, heading style, background. */
function makeToggleActions(c: AppCtx, { zen }: Features, { pokeHints, currentCtx }: KeyContext) {
  const { ui, set, derive, dims, flash, persist, saveSidebar, selectView, panelViews, focusPanel, focusDoc } = c
  return {
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
    zen: () => zen.toggleZen(!derive().L.zen),
    zenSettings: zen.openZenSettings,
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
      if (persist({ wide })) flash(wide ? "full width" : `measure ${MEASURE}`)
    },
    minimap: () => {
      if (dims.current.W < MINI_MIN_W) return flash(`minimap needs ${MINI_MIN_W} columns`)
      const minimap = !ui.current.minimap
      set({ minimap })
      if (persist({ minimap })) flash(minimap ? "minimap on" : "minimap off")
    },
    headings: () => {
      const headingStyle =
        HEADING_STYLES[(HEADING_STYLES.indexOf(ui.current.headingStyle) + 1) % HEADING_STYLES.length]!
      set({ headingStyle })
      if (persist({ headings: headingStyle })) flash(`headings · ${headingStyle}`)
    },
    transparent: () => {
      const transparent = !ui.current.transparent
      set({ transparent })
      if (persist({ transparent })) flash(transparent ? "transparent background" : "opaque background")
    },
  } satisfies Partial<Actions>
}

/** The other global keys: pickers, find, focus, reload, esc, help, history, the AI keys and quit. */
function makeGlobalActions(
  c: AppCtx,
  { aiJobs, links, zen, switcher, workspace, popups }: Features,
  { pokeHints, currentCtx, hintsVisible }: KeyContext,
) {
  const { ui, set, derive, renderer, flash, selectView, focusPanel, focusDoc } = c
  /** `esc` in the panel: the view's filter first, then back to the document. */
  const clearPanel = (s: UI, view: View) => {
    if (view === "files" && s.filter) return set({ filter: "" })
    if (view === "outline" && s.outlineFilter) return set({ outlineFilter: "" })
    focusDoc()
  }
  return {
    switcher: switcher.openSwitcher,
    open: workspace.openOpener,
    slash: () => {
      const { sideFocus } = derive()
      if (!sideFocus) return set({ prompt: { value: "", hl: -1, top: 0 } })
      if (sideFocus === "info") selectView("files")
      set({ filterTyping: true })
    },
    focus: () => (derive().sideFocus ? focusDoc() : focusPanel()),
    theme: popups.openTheme,
    reload: () => {
      const s = ui.current
      const ai = loadConfig().ai ?? null
      set({
        ...rescan(s),
        reload: s.reload + 1,
        watchGen: s.watchGen + 1,
        ai,
        summaryErr: {},
        lastAsk: null,
        delta: s.delta && { ...s.delta, error: null },
      })
      if (ui.current.zen) aiJobs.ensureGlosses()
      switcher.dropIndex()
      flash("reloaded")
    },
    clear: () => {
      const { s, sideFocus, sheet } = derive()
      if (sideFocus) return clearPanel(s, sideFocus)
      // a gloss on screen goes first; it stays hidden until the reading line leaves its section (a fading one falls through)
      if (sheet && sheet.fadeAt === null) return set({ gloss: null })
      if (s.landed) set({ landed: null })
      if (s.toast?.kind === "error") set({ toast: null })
      if (s.query) set({ query: "", matchLine: null })
      else if (s.landing) set({ landing: null })
      else if (derive().L.zen) zen.toggleZen(false)
    },
    // the welcome page shows no hints, so ? opens the sheet at once
    help: () => (hintsVisible() || !ui.current.openPath ? set({ help: true, helpTop: 0 }) : pokeHints(currentCtx())),
    histBack: () => links.histMove(-1),
    histForward: () => links.histMove(1),
    summarize: aiJobs.summarizeNote,
    summarizeHint: aiJobs.summarizeNote, // hint only: no keys of its own
    explainChange: aiJobs.explainChange,
    quit: () => {
      workspace.leave()
      renderer.destroy()
      process.exit(0)
    },
  } satisfies Partial<Actions>
}

/** `r`'s new trees: Files (a piped session keeps its own), the link tree, and the open folders that are still there. */
function rescan(s: UI) {
  const tree = s.piped ? s.tree : scanTree(s.root)
  // folders that are gone are forgotten; the open note's path stays open
  const folders = folderCounts(tree)
  const expanded = new Set([...s.expanded].filter((p) => folders.has(p)))
  if (s.openPath) for (const a of ancestorsOf(tree, s.openPath)) expanded.add(a)
  let linkTree = tree
  if (s.piped) linkTree = s.linkLazy ? s.linkTree : scanTree(s.root)
  else if (s.linkRoot) linkTree = scanTree(s.linkRoot)
  return { tree, linkTree, expanded }
}

/** `e`: the note in $EDITOR at the top line, the renderer suspended meanwhile. */
function makeEditAction(c: AppCtx, { edit: editImpl }: Features) {
  const { ui, set, derive, memo, renderer, flash } = c
  return {
    edit: () => {
      const s = ui.current
      if (!s.openPath) return flash("no note to edit", "error")
      if (s.openPath === STDIN) return flash("stdin · nothing to edit")
      const d = derive()
      const src = memo.read(s.openPath, s.reload)?.src ?? ""
      const line = sourceLineAt({
        source: s.source,
        top: d.top,
        srcRow: d.view.srcRow,
        headings: d.view.headings,
        scan: sourceScan(src).headings,
        offset: parseFrontMatter(src).offset,
      })
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
      if (res && res.code !== 0)
        return flash(res.signal ? `${ed} ended by ${res.signal}` : `${ed} exited with ${res.code}`, "error")
      flash(`edited · ${basename(s.openPath)}`)
    },
  } satisfies Partial<Actions>
}
