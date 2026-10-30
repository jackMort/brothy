// The workspace in the app: the recent-projects record, `switchWorkspace` (every rebuild after the start), the `o` opener
// and the welcome page (its recent rows, keys and ink-in / steam animation). Not pure: `makeWorkspace` closes over the
// app context.

import { existsSync, statSync } from "node:fs"
import { dirname } from "node:path"
import type { KeyEvent } from "@opentui/core"
import type { Geometry } from "../markdown/render"
import { startHistory } from "../notes/history"
import { loadProjects, type OpenRow, projectName, remember, saveProjects, tildify } from "../notes/projects"
import { firstHit } from "../notes/vault"
import { projectRoot, workspace } from "../notes/workspace"
import { INK_MS, INK_STEPS } from "../ui/chrome"
import { keepHitVisible } from "../ui/nav"
import { errText } from "../ui/status"
import { STEAM_MS, welcomeFit } from "../ui/welcome"
import type { AIJobs } from "./ai-jobs"
import type { AppCtx } from "./ctx"
import type { SwitcherControl } from "./switcher"

/** The recent-projects record and the last one on the way out. */
function makeRecents(c: AppCtx) {
  const { ui, zenBack, scrolls, left } = c

  /**
   * Write the workspace to the recents: the open note and its Preview top with the geometry it was
   * taken at, so a reopen at another width remaps it (best effort). Zen not moved in still holds
   * the Preview's own spot in `zenBack`.
   */
  const recordProject = () => {
    const s = ui.current
    if (s.piped) return
    const key = `${s.openPath}:preview`
    const remembered = zenBack.current?.key === key ? zenBack.current : scrolls.current.get(key)
    const spot = s.openPath ? remembered : undefined
    const pos = spot ? { top: spot.top, geo: spot.geo } : { top: 0 }
    saveProjects(remember(loadProjects(), { root: projectRoot(s), lastNote: s.openPath, ...pos, at: Date.now() }))
  }

  /** The last record, on the way out: `q`, C-c and the renderer's end (OpenTUI's exit signals) all come here, once. */
  const leave = () => {
    if (left.current) return
    left.current = true
    recordProject()
  }

  return { recordProject, leave }
}

/** Why `root` cannot be a workspace, as a toast; null when it is a folder. */
function rootProblem(root: string) {
  try {
    if (!statSync(root).isDirectory()) return `not a folder: ${tildify(root)}`
  } catch (e) {
    return `cannot open ${tildify(root)}: ${errText(e)}`
  }
  return null
}

type SwitchDeps = Pick<ReturnType<typeof makeRecents>, "recordProject"> &
  Pick<SwitcherControl, "dropAsk" | "dropIndex"> &
  Pick<AIJobs, "dropDelta">

/** Make a folder the workspace: `switchWorkspace`, the one rebuild everything goes through. */
function makeSwitch(c: AppCtx, { recordProject, dropAsk, dropIndex, dropDelta }: SwitchDeps) {
  const { ui, set, bump, derive, memo, timers, zenBack, scrolls, sidebarSeen, flash, stopRolling } = c

  /**
   * Make `root` the workspace, opening `note` (when it still exists) at Preview line `top`; a
   * `single` note (opened on its own, as from the CLI) links through its vault. Every workspace
   * rebuild goes through here: tree, link tree, switcher index, watcher, history.
   */
  const switchWorkspace = (root: string, note?: string | null, top = 0, single = false, geo?: Geometry) => {
    const problem = rootProblem(root)
    if (problem) return flash(problem, "error")
    const keepNote = note && existsSync(note) ? note : null
    dropAsk() // the big set below closes the switcher
    recordProject()
    clearTimeout(timers.current.open)
    stopRolling()
    zenBack.current = null
    dropIndex() // a build still running sees it is stale and stops
    dropDelta() // even when `o` reopens the same note: the effect takes a fresh baseline
    sidebarSeen.current = { rows: null, cursorPath: null }
    const w = workspace(root, keepNote, single && !!keepNote)
    const s = ui.current
    set({
      ...w,
      filter: "",
      filterTyping: false,
      cursor: 0,
      listTop: { files: 0, outline: 0, info: 0 },
      infoSeen: "",
      outlineFilter: "",
      outlineCur: 0,
      infoCur: 0,
      query: "",
      matchLine: null,
      labels: null,
      lastAsk: null,
      prompt: null,
      switcher: null,
      opener: null,
      focus: "doc",
      drawerOpen: false,
      reloadedAt: null,
      summaryErr: {},
      tldrOpen: false,
      recent: w.openPath ? [w.openPath] : [],
      history: startHistory(w.openPath),
      reload: s.reload + 1,
      watchGen: s.watchGen + 1,
    })
    if (w.openPath && keepNote && top > 0) {
      // the Preview entry, whatever is shown: derive clamps it and remaps it from the recorded geometry
      scrolls.current.set(`${w.openPath}:preview`, { top, geo: geo ?? memo.geo(derive().doc) })
      bump((x) => x + 1)
    }
    recordProject()
    flash(`opened ${projectName(projectRoot(ui.current))}`)
  }

  return switchWorkspace
}

type SwitchWorkspace = ReturnType<typeof makeSwitch>

/** The `o` opener. */
function makeOpener(c: AppCtx, switchWorkspace: SwitchWorkspace) {
  const { ui, set, derive, flash } = c

  /** New query: the highlight goes back to the first row. */
  const opType = (q: string) => {
    const op = ui.current.opener
    if (!op) return
    const next = (ui.current.opener = { ...op, q, hl: 0, top: 0 }) // unbumped: only for `derive` below
    set({ opener: { ...next, hl: Math.max(0, firstHit(derive().opRows)) } })
  }

  /** Highlight row `hl`, scrolling so it (and its section title, when it is the first row) stays in view. */
  const opGo = (hl: number) => {
    const op = ui.current.opener
    if (!op) return
    const { opRows, L } = derive()
    set({ opener: { ...op, hl, top: keepHitVisible(op.top, opRows, hl, L.PH) } })
  }

  const openOpener = () => {
    set({ labels: null, opener: { q: "", hl: 0, top: 0, list: loadProjects() } })
    opType("")
  }

  /** `tab`: a path row's completion (a recent's folder) becomes the query. */
  const opComplete = () => {
    const { opRows, opHl } = derive()
    const r = opRows[opHl]
    if (r?.kind === "path") opType(r.completion)
    else if (r?.kind === "recent") opType(tildify(r.entry.root) + "/")
  }

  /** Open a row: a recent at its last note, a folder as the workspace, a note as a single note. */
  const opOpen = (r: OpenRow | undefined) => {
    const op = ui.current.opener
    if (!op || !r || r.kind === "header") return
    if (r.kind === "recent") {
      if (r.missing) {
        const list = op.list.filter((e) => e.root !== r.entry.root)
        saveProjects(loadProjects().filter((e) => e.root !== r.entry.root))
        set({ opener: { ...op, list } })
        opType(op.q)
        return flash(`“${r.name}” is gone`, "error")
      }
      return switchWorkspace(r.entry.root, r.entry.lastNote, r.entry.top, false, r.entry.geo)
    }
    if (r.dir) return switchWorkspace(r.path)
    switchWorkspace(dirname(r.path), r.path, 0, true)
  }

  return { opType, opGo, openOpener, opComplete, opOpen }
}

/** The welcome page's recent rows and keys. */
function makeWelcomeRows(c: AppCtx, switchWorkspace: SwitchWorkspace) {
  const { ui, bump, derive, memo, welcome, flash } = c

  /** The welcome page's recent rows (header first) and how many of them are on screen. */
  const welcomeRows = () => {
    const rows = memo.recents(ui.current.root, welcome.current.gen, ui.current.watchGen)
    const { L } = derive()
    return { rows, shown: rows.length ? welcomeFit(L.CW, L.CH, rows.length - 1).recents : 0 }
  }

  /** Welcome: open recent row `i` (row 0 is the header); a missing folder is dropped from the list instead. */
  const welcomeOpen = (i: number) => {
    const r = welcomeRows().rows[i]
    if (r?.kind !== "recent") return
    if (r.missing) {
      saveProjects(loadProjects().filter((e) => e.root !== r.entry.root))
      welcome.current.gen++
      return flash(`“${r.name}” is gone`, "error")
    }
    switchWorkspace(r.entry.root, r.entry.lastNote, r.entry.top, false, r.entry.geo)
  }

  /** Welcome keys: ↑ ↓ move the selection over the rows on screen, ⏎ opens it. */
  const welcomeKey = (k: KeyEvent) => {
    const { shown } = welcomeRows()
    if (!shown) return false
    const w = welcome.current
    if (k.name === "up" || k.name === "down") w.hl = Math.max(1, Math.min(shown, w.hl + (k.name === "down" ? 1 : -1)))
    else if (k.name === "return" || k.name === "enter") welcomeOpen(w.hl)
    else return false
    bump((x) => x + 1)
    return true
  }

  return { welcomeRows, welcomeOpen, welcomeKey }
}

/** The welcome page's ink-in / steam animation. */
function makeWelcomeMotion(c: AppCtx) {
  const { ui, bump, W, H, timers, welcome, alive } = c

  // welcome: the wordmark and bowl ink in once (INK_MS frames) and the steam rises every STEAM_MS, until a key,
  // a resize or a note opening stops it for good (`stopWelcome`); with motion off it is drawn still and inked
  const stopWelcome = () => {
    const w = welcome.current
    if (w.run !== "live") return
    w.run = "done"
    w.ink = INK_STEPS - 1
    clearTimeout(timers.current.steam)
    timers.current.steam = undefined
    bump((x) => x + 1) // a key that changes nothing else still shows the inked art
  }

  /** The welcome animation's effect (every render): start it on the welcome page with motion on, stop it once a note opens or the size changes. */
  const animateWelcome = () => {
    const w = welcome.current
    if (ui.current.openPath || (w.run === "live" && (w.W !== W || w.H !== H))) return stopWelcome()
    if (w.run !== "idle" || !ui.current.motion) return
    Object.assign(w, { run: "live", tick: 0, ink: 0, at: Date.now(), W, H })
    bump((x) => x + 1) // the first frame, in border
    const step = () => {
      timers.current.steam = undefined
      if (!alive.current || w.run !== "live") return
      const ms = Date.now() - w.at
      w.ink = Math.min(INK_STEPS - 1, Math.floor(ms / INK_MS))
      w.tick = Math.floor(ms / STEAM_MS)
      bump((x) => x + 1)
      timers.current.steam = setTimeout(step, w.ink < INK_STEPS - 1 ? INK_MS : STEAM_MS)
    }
    timers.current.steam = setTimeout(step, INK_MS)
  }

  return { stopWelcome, animateWelcome }
}

/** The workspace over the app context; a switch drops the ask, the vault index and the change baseline first. */
export function makeWorkspace(
  c: AppCtx,
  drops: Pick<SwitcherControl, "dropAsk" | "dropIndex">,
  delta: Pick<AIJobs, "dropDelta">,
) {
  const { recordProject, leave } = makeRecents(c)
  const switchWorkspace = makeSwitch(c, { recordProject, ...drops, ...delta })
  return {
    recordProject,
    leave,
    ...makeOpener(c, switchWorkspace),
    ...makeWelcomeRows(c, switchWorkspace),
    ...makeWelcomeMotion(c),
  }
}
/** What `makeWorkspace` gives App and the effects. */
export type WorkspaceControl = ReturnType<typeof makeWorkspace>
