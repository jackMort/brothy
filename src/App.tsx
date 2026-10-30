// The app's root: the store and refs, the context and feature factories rebuilt every render, the effects that need
// this render's values, and the screen (zen or main) laid out from the parts in src/app/. Not pure.
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { type ReactNode, useRef, useState } from "react"
import { makeActions } from "./app/actions"
import { makeAIJobs } from "./app/ai-jobs"
import { gapRow, ghostLine, progressLine, topRow } from "./app/Chrome"
import { makeCtx, type Timers, type WelcomeState } from "./app/ctx"
import { docBox, miniBox } from "./app/Document"
import { type Derived, makeDerive, makeMemo } from "./app/derive"
import { useAppEffects, useRenderEffects } from "./app/effects"
import { type FooterState, footerHints, type KeyId, PINNED } from "./app/keymap"
import { makeLinks } from "./app/links"
import {
  findOverlay,
  helpOverlay,
  openOverlay,
  switchOverlay,
  themeOverlay,
  themePickView,
  zenOverlay,
} from "./app/Overlays"
import { panelBox } from "./app/Panel"
import { makePopups } from "./app/popups"
import { type FileRow, initUI, type Job, MIN_H, MIN_W, type Spot, type UI, ZEN_DIM } from "./app/store"
import { makeSwitcher } from "./app/switcher"
import { makeWorkspace } from "./app/workspace"
import { makeZen } from "./app/zen"
import type { Geometry, Rendered } from "./markdown/render"
import { emptyIndex, type VaultIndex } from "./notes/vault"
import { STDIN } from "./notes/workspace"
import type { EditResult } from "./system/editor"
import { surface } from "./theme/theme"
import { INK_STEPS } from "./ui/chrome"
import { DRAWER_BELOW } from "./ui/layout"
import { usePointer } from "./ui/overlay"
import { tldrHead, tldrWord } from "./ui/panel"
import { fadeStep, GHOST_STEPS, tooSmall } from "./ui/status"
import { STILL_TICK } from "./ui/welcome"

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

export function App({
  root: startRoot,
  initialFile,
  themeName,
  transparent,
  fetch: fetchImpl = globalThis.fetch,
  edit: editImpl,
  stdin,
  linkScanDelay = 0,
  motion,
}: AppProps) {
  const renderer = useRenderer()
  const pointer = usePointer()
  const { width: W, height: H } = useTerminalDimensions()
  const dims = useRef({ W, H })
  dims.current = { W, H }

  // a ref-like box built once, on the first render: handlers read `ui.current` at call time
  const [ui] = useState(() => ({
    current: initUI(startRoot, initialFile, themeName, transparent, stdin !== undefined, motion),
  }))
  const [, bump] = useState(0)
  const set = (patch: Partial<UI>) => {
    Object.assign(ui.current, patch)
    bump((x) => x + 1)
  }

  useDrawerCrossing(ui.current, W)

  const refs = useAppRefs(stdin, W, H)
  const derive = makeDerive({ ui, dims, ...refs })

  // the app context and the feature factories over it, rebuilt every render: handlers close over this render's size and
  // props, and read the store at call time
  const ctx = makeCtx({ ui, set, bump, derive, dims, ...refs, W, H, renderer, fetchImpl, themeName, linkScanDelay })
  const aiJobs = makeAIJobs(ctx)
  const links = makeLinks(ctx)
  const zen = makeZen(ctx, aiJobs)
  const switcher = makeSwitcher(ctx, links)
  const workspace = makeWorkspace(ctx, switcher, aiJobs)
  const popups = makePopups(ctx)
  const { currentCtx, pokeHints, outlineGo, jumpChange, onKey } = makeActions(ctx, {
    aiJobs,
    links,
    zen,
    switcher,
    workspace,
    popups,
    edit: editImpl,
  })

  // ---------------------------------------------------- effects and keys
  const { openPath } = ui.current
  useAppEffects(ctx, { ...aiJobs, ...links, ...workspace })
  useKeyboard(onKey)

  // ---------------------------------------------------- render
  const d = derive()
  const { L } = d

  // the panel and the document write the list tops and the welcome row back to the store as they draw: always built,
  // even when zen or a too-small terminal leaves them off screen
  const panelEl = panelBox(ctx, d, { outlineGo, jumpChange, openLink: links.openLink })
  const docEl = docBox(ctx, d, { ...workspace, ...zen })
  const miniEl = miniBox(ctx, d)
  const progressEl = progressLine(ctx, d)

  const ctxNow = currentCtx()

  // ghost line (row H-2): key hints on the left, a toast on the right; blank at rest
  const footer = footerState(d)
  const ghostEl = ghostLine(ctx, d, {
    ctx: ctxNow,
    pinned: PINNED.includes(ctxNow),
    hints: (c) => footerHints(c, footer, footerWords(d), d.askStage),
  })

  const helpEl = helpOverlay(ctx, d, { version: VERSION, helpGo: popups.helpGo })
  const switchEl = switchOverlay(ctx, d, switcher)
  const openEl = openOverlay(ctx, d, workspace)
  const findEl = findOverlay(ctx, d, popups)
  const pickView = themePickView(ctx, d)
  // zen gloss: runs when the reading line changes section (not on every scroll tick)
  const glossAt = L.zen && openPath ? `${openPath}\0${d.currentHeading}` : null
  useRenderEffects(
    ctx,
    { ctxNow, glossAt, sample: pickView?.sample ?? null },
    { pokeHints, glossEntered: aiJobs.glossEntered },
  )
  const themeEl = themeOverlay(ctx, d, pickView, popups)
  const zenEl = zenOverlay(ctx, d, zen)

  if (W < MIN_W || H < MIN_H) return tooSmallScreen(d, W, H)
  const parts: ScreenParts = {
    panelEl,
    docEl,
    miniEl,
    ghostEl,
    progressEl,
    helpEl,
    findEl,
    switchEl,
    openEl,
    themeEl,
    zenEl,
  }
  return L.zen ? zenScreen(d, W, H, pointer.note, parts) : mainScreen(d, W, H, pointer.note, parts)
}

// ------------------------------------------------------------- screen

type PanelMode = "inline" | "drawer"
type Pointer = ReturnType<typeof usePointer>

/** The refs the context carries (documented on `Base` and `DeriveRefs`), made in this order on every render. A hook. */
function useAppRefs(stdin: string | undefined, W: number, H: number) {
  return {
    vault: useRef<{ ix: VaultIndex; running: boolean }>({ ix: emptyIndex(), running: false }),
    // derived data, memoized so handlers and render can both pull it on demand
    memo: useRef(makeMemo(stdin)).current,
    matchSeen: useRef<{ matches: number[]; query: string }>({ matches: [], query: "" }),
    scrolls: useRef(new Map<string, { top: number; geo: Geometry }>()),
    zenBack: useRef<Spot | null>(null),
    sidebarSeen: useRef<{ rows: FileRow[] | null; cursorPath: string | null }>({ rows: null, cursorPath: null }),
    timers: useRef<Timers>({}),
    jobs: useRef(new Map<string, Job>()),
    askMemo: useRef(new Map<string, { queries: string[]; model: string }>()),
    rerankMemo: useRef(new Map<string, { order: string[]; why: Record<string, string>; model: string }>()),
    alive: useRef(true),
    hlSeen: useRef<Rendered | null>(null),
    left: useRef(false),
    welcome: useRef<WelcomeState>({ hl: 1, gen: 0, tick: STILL_TICK, ink: INK_STEPS - 1, run: "idle", at: 0, W, H }),
  }
}

/**
 * Crossing DRAWER_BELOW: a focused panel becomes an open drawer; widening shows it inline again. Applied to the store
 * before this render draws. A hook: it remembers the panel mode last drawn.
 */
function useDrawerCrossing(s: UI, W: number) {
  const seen = useRef<PanelMode | null>(null)
  const modeNow = W < DRAWER_BELOW ? "drawer" : "inline"
  if (seen.current === modeNow) return
  if (seen.current === "inline") s.drawerOpen = s.focus === "panel" && !s.hidden && !s.zen
  if (seen.current === "drawer") {
    s.drawerOpen = false
    if (s.hidden && s.focus === "panel") {
      s.focus = "doc"
      s.filterTyping = false
    }
  }
  seen.current = modeNow
}

/** What the footer hints wait for. */
function footerState({ s, cv, sv }: Derived): FooterState {
  return {
    query: !!s.query,
    preview: !s.source,
    disk: s.openPath !== STDIN,
    ai: !!s.ai,
    changes: !!s.ai && !!cv && cv.state !== "result",
    tldr: !!sv && tldrHead(sv) !== "fresh",
  }
}

/** The footer words that follow the TL;DR: what `a` does now, and `↑↓ move  ⏎ more|less` on its stop in Info. */
function footerWords({ sv, infoRows, linkRows, infoCur }: Derived): Partial<Record<KeyId, string>> {
  if (!sv) return {}
  const word = tldrWord(sv)
  const words: Partial<Record<KeyId, string>> = { summarize: word, summarizeHint: word }
  if (infoRows[linkRows[infoCur] ?? -1]?.kind !== "frule") return words
  return { ...words, infoMove: "move", infoOpen: sv.open ? "less" : "more" }
}

/** The parts both screens draw, built every render. */
interface ScreenParts {
  panelEl: ReactNode
  docEl: ReactNode
  miniEl: ReactNode
  ghostEl: ReactNode
  progressEl: ReactNode
  helpEl: ReactNode
  findEl: ReactNode
  switchEl: ReactNode
  openEl: ReactNode
  themeEl: ReactNode
  zenEl: ReactNode
}

/** Below MIN_W × MIN_H: only the size it needs. */
function tooSmallScreen({ s, t }: Derived, W: number, H: number) {
  const paint = surface(t, s.transparent)
  return (
    <box style={{ width: W, height: H, backgroundColor: paint.main, alignItems: "center", justifyContent: "center" }}>
      {tooSmall(W, H, `${MIN_W}×${MIN_H}`).map((l, i) => (
        <text key={i} wrapMode="none" fg={t.textMuted}>
          {l}
        </text>
      ))}
    </box>
  )
}

/** How far zen's top line has faded, for `topRow` (null: hidden). */
function zenTopFade(s: UI) {
  if (!s.zenCfg.ghost) return ZEN_DIM
  if (s.ghostAt === null) return null
  const step = fadeStep(Date.now() - s.ghostAt)
  return step === null ? null : step / (GHOST_STEPS + 1)
}

/** The zen screen: the document alone between the top line and the footer rows. */
function zenScreen(d: Derived, W: number, H: number, note: Pointer["note"], p: ScreenParts) {
  const { s, L, t } = d
  const paint = surface(t, s.transparent)
  // Ghost on: the top line is full after a key, then fades; Ghost off: dimmed. Hints and toasts have their own lifetimes.
  const topK = zenTopFade(s)
  return (
    <box key="zen" onMouse={note} style={{ width: W, height: H, flexDirection: "column", backgroundColor: paint.main }}>
      {topRow(d, topK)}
      {gapRow(d)}
      <box style={{ flexDirection: "row", height: L.bodyH, paddingLeft: 1, paddingRight: 1 }}>{p.docEl}</box>
      {p.ghostEl}
      {p.progressEl}
      {p.helpEl}
      {p.findEl}
      {p.switchEl}
      {p.openEl}
      {p.themeEl}
      {p.zenEl}
    </box>
  )
}

/** The main screen: the panel inline (or as a drawer over the rest), the document and the minimap. */
function mainScreen(d: Derived, W: number, H: number, note: Pointer["note"], p: ScreenParts) {
  const { s, L, t } = d
  const paint = surface(t, s.transparent)
  return (
    <box
      key="main"
      onMouse={note}
      style={{ width: W, height: H, flexDirection: "column", backgroundColor: paint.main }}
    >
      {topRow(d, 0)}
      {gapRow(d)}
      <box style={{ flexDirection: "row", height: L.bodyH, paddingLeft: 1, paddingRight: L.mini ? 0 : 1, gap: 1 }}>
        {L.inline ? p.panelEl : null}
        {p.docEl}
        {p.miniEl}
      </box>
      {p.ghostEl}
      {p.progressEl}
      {L.shown && !L.inline ? p.panelEl : null}
      {p.helpEl}
      {p.findEl}
      {p.switchEl}
      {p.openEl}
      {p.themeEl}
      {p.zenEl}
    </box>
  )
}
