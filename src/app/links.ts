// Links, link labels, history and landing: following a wikilink or an Info link, the `f` labels over the links on
// screen, `H` / `L` back and forward, and going to a changed section (`⏎` on a Changed row, `[ ]` while there). Not
// pure: `makeLinks` closes over the app context.
import { existsSync } from "node:fs"
import { basename } from "node:path"
import { changeRows, quoteNeedle, stepChange } from "../ai/delta"
import type { LinkTarget } from "../markdown/render"
import { scanTree, stem } from "../notes/files"
import { drop, go, keep, stepTo } from "../notes/history"
import { STDIN } from "../notes/workspace"
import { findQuote, linkLabels, narrowLabels, visibleLinks } from "../ui/nav"
import { findHeading, type InfoItem, linkDest, resolveLink } from "../ui/panel"
import type { AppCtx } from "./ctx"
import type { UI } from "./store"

/** What the label spots depend on: a highlight re-render keeps it, a reload, the mode, the width or the scroll changes it. */
export const labelGeo = (s: Pick<UI, "openPath" | "source" | "reload">, CW: number, rows: number, top: number) =>
  [s.openPath, s.source, s.reload, CW, rows, top].join("\0")

/** Following links over the app context. */
function makeFollow(c: AppCtx) {
  const { ui, set, derive, flash, openFile, focusDoc, setTop } = c

  /** A piped document scans the working folder for links the first time one is used. */
  const ensureLinks = () => {
    const s = ui.current
    if (s.linkLazy) set({ linkTree: scanTree(s.root), linkLazy: false })
  }

  /** Open a resolved Info link and read it; an unresolved one only says so, and Info keeps focus. */
  const openLink = (it: Extract<InfoItem, { kind: "link" }>) => {
    ensureLinks()
    const path = it.path ?? resolveLink(it.target, ui.current.linkTree, ui.current.openPath)
    if (!path) return flash(`no note named “${it.target}”`)
    set({ history: keep(ui.current.history) }) // a note followed from stays in history
    openFile(path)
    focusDoc()
  }

  /** Open where `l` leads: the note, then its heading; a URL or a missing target only says so. */
  const followLink = (l: LinkTarget) => {
    ensureLinks()
    const s = ui.current
    const dest = linkDest(l, s.openPath, s.linkTree)
    if (dest.url) return flash(dest.url)
    if (!dest.path) return flash(`no note named “${dest.label}”`)
    set({ history: keep(s.history) }) // a note followed from stays in history
    openFile(dest.path)
    focusDoc()
    if (!dest.heading) return
    const d = derive()
    const i = findHeading(d.view.headings, dest.heading)
    // a missing heading leaves the note at its remembered position
    if (i === null) flash(`no heading “${dest.heading}”`)
    else setTop(d.view.headings[i]!.line)
  }

  return { ensureLinks, openLink, followLink }
}

/** The `f` labels over the links on screen. */
function makeLabels(
  c: AppCtx,
  { ensureLinks, followLink }: Pick<ReturnType<typeof makeFollow>, "ensureLinks" | "followLink">,
) {
  const { ui, set, derive, flash } = c

  /** Labels still match what is drawn: same note, mode, width, length and scroll position. */
  const liveLabels = () => {
    const lb = ui.current.labels
    if (!lb) return null
    const d = derive()
    return lb.geo === labelGeo(ui.current, d.L.CW, d.view.lines.length, d.top) ? lb : null
  }

  const startLabels = () => {
    ensureLinks()
    const d = derive()
    if (d.s.source) return flash("links: preview only (s)")
    const spots = visibleLinks(d.view.lines, d.top, d.L.CH)
    if (!spots.length) return flash("no links on screen")
    const labels = linkLabels(spots.length)
    set({
      labels: {
        spots: spots.slice(0, labels.length),
        labels,
        typed: "",
        geo: labelGeo(ui.current, d.L.CW, d.view.lines.length, d.top),
      },
    })
  }

  const labelType = (ch: string) => {
    const lb = liveLabels()
    if (!lb) return set({ labels: null })
    const typed = lb.typed + ch
    const left = narrowLabels(lb.labels, typed)
    if (!left.length) return set({ labels: null })
    if (left.length === 1 && lb.labels[left[0]!] === typed) {
      const link = derive().view.links?.[lb.spots[left[0]!]!.link]
      set({ labels: null })
      if (link) followLink(link)
      return
    }
    set({ labels: { ...lb, typed } })
  }

  return { liveLabels, startLabels, labelType }
}

/** `H` / `L` back and forward. */
function makeHistory(c: AppCtx) {
  const { ui, set, derive, flash, scrolls, currentSpot, openFile } = c

  /** `H` / `L`: the note one step back / forward, where it was left; notes gone from disk are dropped. */
  const histMove = (dir: -1 | 1) => {
    let h = ui.current.history
    const gone: string[] = []
    const name = (p: string) => stem(basename(p))
    for (let i = stepTo(h, dir); i !== null; i = stepTo(h, dir)) {
      const e = h.entries[i]!
      if (e.path !== STDIN && !existsSync(e.path)) {
        // the piped document is relative, never on disk
        gone.push(`“${name(e.path)}” is gone`)
        h = drop(h, i)
        continue
      }
      const history = go(h, i, currentSpot())
      if (e.pos) scrolls.current.set(e.pos.key, { top: e.pos.top, geo: e.pos.geo })
      openFile(e.path, "history")
      set({ history: derive().sideFocus ? history : keep(history) }) // reached with document focus: read, not previewed
      return flash([...gone, `${dir < 0 ? "back" : "forward"} · ${name(e.path)}`].join(" · "))
    }
    set({ history: h })
    const none = dir < 0 ? "no earlier note" : "no later note"
    flash(gone.length ? gone.join(" · ") : none)
  }

  return { histMove }
}

/** Landing on a change: `⏎` on a Changed row (or `D` below 100 columns) goes to it and keeps its footnote; `[ ]` walk. */
function makeLanding(c: AppCtx) {
  const { set, derive, flash, setTop, focusDoc } = c

  /** Scroll to change `at` of the Changed block (the reply's quote when it is in that section, else its heading) and land on it. */
  const jumpChange = (at: number) => {
    const { cv, view, s } = derive()
    const ch = cv?.changes?.[at]
    if (!cv || !s.openPath || !ch || ch.status === "removed") return
    const { from, to } = changeRows(view, ch)
    const quote = cv.notes[at]?.quote
    const line = quote ? findQuote(view.plain, from, to, quoteNeedle(quote, s.source)) : null
    setTop(line === null ? from : Math.max(from, line - 1))
    set({ landing: { path: s.openPath, n: at + 1 } })
    focusDoc()
  }

  /** `[` `]` while landed: the previous / next change, removed ones skipped; at either end a toast. False when not landed. */
  const landStep = (dir: 1 | -1) => {
    const { land } = derive()
    if (!land) return false
    const n = stepChange(land.changes, land.n, dir)
    if (n === null) flash(dir > 0 ? "last change" : "first change")
    else jumpChange(n - 1)
    return true
  }

  return { jumpChange, landStep }
}

/** Links, labels, history and landing on a change, over the app context. */
export function makeLinks(c: AppCtx) {
  const { ensureLinks, openLink, followLink } = makeFollow(c)
  return {
    ensureLinks,
    openLink,
    ...makeLabels(c, { ensureLinks, followLink }),
    ...makeHistory(c),
    ...makeLanding(c),
  }
}
/** What `makeLinks` gives App and the other factories. */
export type Links = ReturnType<typeof makeLinks>
