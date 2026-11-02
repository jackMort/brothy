// The Graph sheet in the app: open it on the note, move through the list, walk to a neighbour and back, depth and
// renderer (both saved), the filter, open a note, the pointer; and the sheet's image, made once per raster. Not pure:
// closes over the app context.
import { existsSync } from "node:fs"
import { NativeImage } from "@opentui/core"
import { nearestNode, type Picture } from "../graph/picture"
import { type GraphTerm, graphMode, graphTerm, isGraphStop, nextStop } from "../graph/sheet"
import { keep } from "../notes/history"
import { STDIN } from "../notes/workspace"
import type { GraphRender } from "../system/config"
import { keepVisible } from "../ui/nav"
import type { AppCtx } from "./ctx"
import { erase } from "./input"
import type { Links } from "./links"
import type { GraphImage, GraphState } from "./store"
import type { SwitcherControl } from "./switcher"

type PointerKind = "hover" | "click"

/** A second click on the same spot within this many ms is a double-click: it opens the note the first one centred on. */
const GRAPH_DOUBLE_MS = 400
/** A new centre, list or depth: the focus on its first stop, put there by no key. */
const FRESH = { hl: 0, top: 0, keyed: false } as const

/** Opening the sheet, and `H` `L` out of it. */
function makeGraphOpen(
  c: AppCtx,
  { ensureLinks, histMove }: Pick<Links, "ensureLinks" | "histMove">,
  { indexVault }: Pick<SwitcherControl, "indexVault">,
) {
  const { ui, set, flash, renderer } = c

  /** The first open this run, `auto` drawing pixels inside a multiplexer: say how to switch (herdr says yes even over mosh). */
  const muxToast = (term: GraphTerm) => {
    const s = ui.current
    if (s.graphMuxTold || s.graphRender !== "auto" || !term.mux) return
    if (graphMode(s.graphRender, term, s.graphFailed) !== "pixels") return
    set({ graphMuxTold: true })
    flash("graph · pixels · p braille")
  }

  const graphOpen = () => {
    const s = ui.current
    if (!s.openPath) return flash("no note open")
    ensureLinks()
    indexVault()
    const term = graphTerm(renderer.capabilities, renderer.resolution, renderer.terminalWidth, renderer.terminalHeight)
    set({
      labels: null,
      graph: { centre: s.openPath, walk: [], ...FRESH, q: "", typing: false, open: false, term, click: null },
    })
    muxToast(term)
  }

  /** `H` `L` in the sheet: close it, then step history. */
  const graphHist = (dir: 1 | -1) => {
    set({ graph: null })
    histMove(dir)
  }
  return { graphOpen, graphHist }
}

/** Moving the focus, walking, opening, closing, the filter. */
function makeGraphMoves(c: AppCtx) {
  const { ui, set, derive, flash, openFile, focusDoc } = c
  const put = (patch: Partial<GraphState>) => {
    const g = ui.current.graph
    if (g) set({ graph: { ...g, ...patch } })
  }

  /** Focus list row `hl` when the focus can rest there, scrolled into view; `keyed`: by a key (a click on it opens). */
  const focusAt = (hl: number, keyed: boolean) => {
    const v = derive().graph
    if (v && isGraphStop(v.rows[hl]))
      put({ hl, keyed, top: keepVisible(v.top, hl, Math.max(1, v.geo.listH), v.rows.length) })
  }
  /** `↑↓ j k` and the wheel. */
  const graphMove = (dir: 1 | -1) => {
    const v = derive().graph
    if (v) focusAt(nextStop(v.rows, v.hl, dir), true)
  }
  /** The pointer moved onto row `hl`: focus it, unless it has the focus already (a key's focus stays a key's). */
  const graphHover = (hl: number) => {
    if (hl !== derive().graph?.hl) focusAt(hl, false)
  }

  /** The focused row's note, when there is one to open or centre on. */
  const focused = () => {
    const v = derive().graph
    const r = v?.rows[v.hl]
    return r?.kind === "node" && r.dir !== "unresolved" ? r : null
  }

  /** Note `path` becomes the centre; the one before goes on the walk. */
  const centreOn = (path: string) => {
    const g = ui.current.graph
    if (g && path !== g.centre)
      put({ centre: path, walk: [...g.walk, g.centre], ...FRESH, q: "", typing: false, open: false })
  }
  /** `l`: the focused note becomes the centre. */
  const graphCentre = () => {
    const r = focused()
    if (r) centreOn(r.path)
  }

  /** `h`: back to the centre before, the focus on the note just left. */
  const graphBack = () => {
    const g = ui.current.graph
    const prev = g?.walk.at(-1)
    if (!g || prev === undefined) return
    const next: GraphState = {
      ...g,
      centre: prev,
      walk: g.walk.slice(0, -1),
      hl: 0,
      top: 0,
      q: "",
      typing: false,
      open: false,
      keyed: true,
    }
    ui.current.graph = next // unbumped: only for `derive` below
    const v = derive().graph!
    const hl = Math.max(
      0,
      v.rows.findIndex((r) => r.kind === "node" && r.path === g.centre),
    )
    set({ graph: { ...next, hl, top: keepVisible(0, hl, Math.max(1, v.geo.listH), v.rows.length) } })
  }

  /** Close the sheet and read note `path`; the note it was opened on stays in history, even a Files preview. */
  const openNote = (path: string) => {
    if (path !== STDIN && !existsSync(path)) return flash("note gone")
    set({ graph: null, history: keep(ui.current.history) })
    openFile(path)
    focusDoc()
  }

  /** `⏎` (or a click on a row a key focused, or on `+ n more`): `+ n more` opens or folds the rest; a note opens. */
  const graphGo = (at?: number) => {
    const v = derive().graph
    const g = ui.current.graph
    const r = v?.rows[at ?? v.hl]
    if (!g || !r) return
    if (r.kind === "more") return put({ open: !g.open })
    if (r.kind === "node" && r.dir !== "unresolved") openNote(r.path)
  }

  /** `esc`: the filter first, then the sheet. */
  const graphClose = () => {
    const g = ui.current.graph
    if (g?.q || g?.typing) return put({ q: "", typing: false, ...FRESH })
    set({ graph: null })
  }

  const graphType = (q: string) => put({ q, ...FRESH })
  return {
    graphMove,
    graphHover,
    centreOn,
    openNote,
    graphCentre,
    graphBack,
    graphGo,
    graphClose,
    graphType,
    graphFilter: () => put({ typing: true }),
    graphLeave: () => put({ typing: false }),
    graphErase: () => graphType(erase(ui.current.graph?.q ?? "")),
  }
}
type GraphMoves = ReturnType<typeof makeGraphMoves>

/** Depth and renderer (saved under `graph`), and the fall back to braille when pixels fail. */
function makeGraphSettings(c: AppCtx) {
  const { ui, set, flash, persist } = c

  const graphDepth = (depth: 1 | 2) => {
    const g = ui.current.graph
    if (!g || depth === ui.current.graphDepth) return
    set({ graphDepth: depth, graph: { ...g, ...FRESH } })
    if (persist({ graph: { depth } })) flash(`graph · depth ${depth}`)
  }

  /** `p`: pixels ⇄ braille; where pixels cannot show, it says so and saves nothing. */
  const graphRenderer = () => {
    const { graph: g, graphRender, graphFailed } = ui.current
    if (!g) return
    if (graphMode("pixels", g.term, graphFailed) === "braille")
      return flash("graph · pixels unavailable here · braille")
    const render: GraphRender = graphMode(graphRender, g.term, graphFailed) === "pixels" ? "braille" : "pixels"
    set({ graphRender: render })
    if (persist({ graph: { render } })) flash(`graph · ${render}`)
  }

  /** The image could not be made or shown: braille for the rest of the run. */
  const pixelsFailed = () => {
    if (ui.current.graphFailed) return
    set({ graphFailed: true })
    flash("graph · pixels failed · braille instead", "error")
  }
  return { graphDepth, graphRenderer, pixelsFailed }
}

/**
 * The pointer: hover focuses; a click centres on its note, but opens the one a key focused, and `+ n more` is `⏎`; a
 * second click on the same spot soon after (a double-click) opens the note the first one centred on.
 */
function makeGraphPointer(
  c: AppCtx,
  { graphHover, centreOn, openNote, graphGo }: Pick<GraphMoves, "graphHover" | "centreOn" | "openNote" | "graphGo">,
) {
  const { ui, set, derive } = c

  /** The note a click on `spot` just before centred on, when this one makes it a double-click. */
  const doubled = (spot: string) => {
    const last = ui.current.graph?.click
    return last && last.spot === spot && Date.now() - last.at <= GRAPH_DOUBLE_MS ? last.path : null
  }

  /** A single click on row `at` at `spot`: `⏎` on `+ n more` or the row a key focused, else centre on its note. */
  const pick = (at: number, spot: string) => {
    const v = derive().graph
    const r = v?.rows[at]
    if (!v || !r || !isGraphStop(r)) return
    if (r.kind !== "node" || (at === v.hl && ui.current.graph?.keyed)) return graphGo(at)
    centreOn(r.path)
    const g = ui.current.graph
    if (g) set({ graph: { ...g, click: { spot, path: r.path, at: Date.now() } } })
  }

  /** A click on row `at` (-1: none) at `spot`, a list row or a picture cell. */
  const click = (at: number, spot: string) => {
    const twice = doubled(spot)
    return twice ? openNote(twice) : pick(at, spot)
  }

  const graphRow = (at: number, kind: PointerKind) =>
    kind === "click" ? click(at, `row ${at - (derive().graph?.top ?? 0)}`) : graphHover(at)

  /** Cell (col, row) of the picture: the nearest node within 2 cells, through its list row. */
  const graphPointer = (col: number, row: number, kind: PointerKind) => {
    const v = derive().graph
    const g = ui.current.graph
    if (!v || !g) return
    const i = nearestNode(v.picture.at, col, row, g.term.cellH / g.term.cellW)
    const at = i === null ? -1 : v.rows.findIndex((r) => r.kind === "node" && r.i === i)
    if (kind === "click") click(at, `cell ${col},${row}`)
    else if (at >= 0) graphHover(at)
  }
  return { graphRow, graphPointer }
}

/** The Graph sheet's actions over the app context. */
export function makeGraph(
  c: AppCtx,
  links: Pick<Links, "ensureLinks" | "histMove">,
  switcher: Pick<SwitcherControl, "indexVault">,
) {
  const moves = makeGraphMoves(c)
  return { ...makeGraphOpen(c, links, switcher), ...moves, ...makeGraphSettings(c), ...makeGraphPointer(c, moves) }
}
/** What `makeGraph` gives App and the actions. */
export type Graph = ReturnType<typeof makeGraph>

type MakeImage = (px: Uint8Array, w: number, h: number) => NativeImage

/** Dispose the sheet's image, if any. */
export function releaseImage(ref: { current: GraphImage }) {
  ref.current.img?.dispose()
  ref.current = { px: null, img: null }
}

/**
 * The image for this raster: made once per raster, the one before released; null in braille or when it cannot be made
 * (`failed` runs after the render, never during it).
 */
export function imageFor(
  ref: { current: GraphImage },
  rgba: Picture["rgba"],
  failed: () => void,
  make: MakeImage = (px, w, h) => NativeImage.fromRgba(px, w, h),
): NativeImage | null {
  if (!rgba) {
    releaseImage(ref)
    return null
  }
  if (ref.current.px === rgba.px) return ref.current.img
  releaseImage(ref)
  let img: NativeImage | null = null
  try {
    img = make(rgba.px, rgba.w, rgba.h)
  } catch {
    queueMicrotask(failed)
  }
  ref.current = { px: rgba.px, img }
  return img
}
