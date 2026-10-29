import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { ensureHighlights } from "./highlight"
import { pendingHighlights, type Rendered } from "./markdown"
import { makeAIJobs, type Job } from "./app/ai-jobs"
import { makeDerive, makeMemo } from "./app/derive"
import { makeCore, makeNav, type Timers, type WelcomeState } from "./app/ctx"
import { makeLinks } from "./app/links"
import { makeZen } from "./app/zen"
import { makeSwitcher } from "./app/switcher"
import { makeWorkspace } from "./app/workspace"
import { useAppEffects } from "./app/effects"
import { makeActions } from "./app/actions"
import { makePopups } from "./app/popups"
import { panelBox } from "./app/Panel"
import { docBox, miniBox } from "./app/Document"
import { gapRow, ghostLine, progressLine, topRow } from "./app/Chrome"
import { findOverlay, helpOverlay, openOverlay, switchOverlay, themeOverlay, themePickView, zenOverlay } from "./app/Overlays"
import { ZEN_DIM, initUI, type FileRow, type Spot, type UI } from "./app/store"
import { PINNED, footerHints, type Ctx, type FooterState } from "./app/keymap"
import { STDIN } from "./workspace"
import { DRAWER_BELOW } from "./layout"
import { surface } from "./theme"
import { usePointer } from "./overlay"
import { STILL_TICK } from "./welcome"
import { INK_STEPS } from "./chrome"
import { emptyIndex, type VaultIndex } from "./vault"
import type { Geometry } from "./nav"
import type { EditResult } from "./editor"
import { GHOST_STEPS, fadeStep, tooSmall } from "./status"

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

  // the app context in layers (core, then nav) and the feature factories over it, rebuilt every render: handlers close
  // over this render's size and props, and read the store at call time
  const ctx = makeNav(
    makeCore({
      ui, set, bump, derive, dims, memo, vault, jobs, sidebarSeen, scrolls, matchSeen, W, H, renderer,
      fetchImpl, themeName, linkScanDelay, zenBack, timers, askMemo, rerankMemo, alive, hlSeen, left, welcome,
    }),
  )
  const aiJobs = makeAIJobs(ctx)
  const links = makeLinks(ctx)
  const zen = makeZen(ctx, aiJobs)
  const switcher = makeSwitcher(ctx, links)
  const workspace = makeWorkspace(ctx, switcher, aiJobs)
  const popups = makePopups(ctx)
  const { currentCtx, pokeHints, outlineGo, jumpChange, onKey } = makeActions(ctx, { aiJobs, links, zen, switcher, workspace, popups, edit: editImpl })

  // ---------------------------------------------------- effects
  const { openPath } = ui.current
  useAppEffects(ctx, { ...aiJobs, ...links, ...workspace })
  useKeyboard(onKey)

  // ---------------------------------------------------- render
  const d = derive()
  const { s, L, t } = d
  const paint = surface(t, s.transparent)

  // the panel and the document write the list tops and the welcome row back to the store as they draw: always built,
  // even when zen or a too-small terminal leaves them off screen
  const panelEl = panelBox(ctx, d, { outlineGo, jumpChange, openLink: links.openLink })
  const docEl = docBox(ctx, d, { ...workspace, ...zen })
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
    aiJobs.glossEntered()
  })

  // ghost line (row H-2): key hints on the left, a toast on the right; blank at rest
  const footer: FooterState = { query: !!s.query, preview: !s.source, disk: s.openPath !== STDIN, ai: !!s.ai, changes: !!s.ai && !!d.cv && d.cv.state !== "result" }
  const ghostEl = ghostLine(ctx, d, { ctx: ctxNow, pinned: PINNED.includes(ctxNow), hints: (c) => footerHints(c, footer) })

  const helpEl = helpOverlay(ctx, d, { version: VERSION, helpGo: popups.helpGo })
  const switchEl = switchOverlay(ctx, d, switcher)
  const openEl = openOverlay(ctx, d, workspace)
  const findEl = findOverlay(ctx, d, popups)
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
  const themeEl = themeOverlay(ctx, d, pickView, popups)
  const zenEl = zenOverlay(ctx, d, zen)

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
