// The app's effects, in the order they run: live reload, the change baseline, the project record, the config theme
// toast, a piped document's link scan, exit and copy-on-select listeners, the unmount cleanups, the welcome animation and
// code-block highlighting. A hook: App calls it once per render, at the same place, so the hook order holds.
import { basename } from "node:path"
import { useEffect } from "react"
import { reloadToast } from "../ai/delta"
import { ensureHighlights } from "../markdown/highlight"
import { pendingHighlights } from "../markdown/render"
import { copiedCount, selectedText } from "../ui/nav"
import { LOGO_HOLD } from "../ui/status"
import { plural } from "../lib/text"
import { resolveTheme } from "../theme/themepick"
import { watchPath } from "../notes/watch"
import { STDIN } from "../notes/workspace"
import type { AIJobs } from "./ai-jobs"
import type { AppCtx } from "./ctx"
import type { Links } from "./links"
import { jobKey } from "./store"
import type { WorkspaceControl } from "./workspace"

/** What the effects call from the feature factories. */
export type EffectDeps = Pick<AIJobs, "dropDelta"> & Pick<Links, "ensureLinks"> & Pick<WorkspaceControl, "recordProject" | "leave" | "animateWelcome">

/** Register every effect of App on the app context (hooks: call it unconditionally, before any early return). */
export function useAppEffects(c: AppCtx, { dropDelta, ensureLinks, recordProject, leave, animateWelcome }: EffectDeps) {
  const { ui, set, bump, derive, memo, timers, jobs, vault, alive, hlSeen, renderer, themeName, linkScanDelay, flash } = c
  const { openPath, watchGen } = ui.current
  useEffect(() => {
    if (!openPath || openPath === STDIN) return
    return watchPath(openPath, {
      change: () => {
        set({ reload: ui.current.reload + 1, reloadedAt: Date.now() })
        clearTimeout(timers.current.logo)
        timers.current.logo = setTimeout(() => bump((x) => x + 1), LOGO_HOLD + 20)
        const d = derive()
        // a shown explanation goes once the list moves on, or once it can't be compared
        const dl = d.s.delta
        if (dl?.result && (d.changes === null || d.changes.length) && !jobs.current.has(jobKey("delta", dl.path))) set({ delta: null })
        flash(reloadToast(d.changes, d.propsChanged, !!d.s.ai))
      },
      error: (msg) => flash(msg, "error"),
    })
  }, [openPath, watchGen])
  // a failed read is a toast too (the document shows the message as well); the change list
  // compares against the text the note had when it opened: leaving it or a failed read drops it
  const { reload } = ui.current
  useEffect(() => {
    const f = derive().file
    if (f?.error && openPath) flash(`cannot open “${basename(openPath)}”: ${f.error}`, "error")
    if (!openPath || !f || f.error) return dropDelta()
    if (ui.current.baseline?.path === openPath) return
    dropDelta()
    set({ baseline: { path: openPath, text: memo.note(f.src), props: memo.propsKey(memo.fm(f.src)), at: Date.now() } })
  }, [openPath, reload])
  // the start is a project opened too
  useEffect(recordProject, [])
  // `--theme` is checked by the CLI, so a name nothing resolves came from config.json (brothy stands in)
  useEffect(() => {
    if (themeName !== undefined && !resolveTheme(themeName)) flash(`unknown theme "${themeName}" in config`, "error")
  }, [])
  // a piped document's links resolve once the cwd scan has run: start it after the first frame, unless a link got there first
  useEffect(() => {
    if (!ui.current.linkLazy) return
    const id = setTimeout(ensureLinks, linkScanDelay)
    return () => clearTimeout(id)
  }, [])
  // SIGTERM / SIGHUP (the terminal closing) end the renderer without `quit`
  useEffect(() => {
    renderer.on("destroy", leave)
    return () => void renderer.off("destroy", leave)
  }, [])
  // copy on select: a finished mouse drag goes to the clipboard over OSC 52
  useEffect(() => {
    const copy = (sel: { getSelectedText(): string }) => {
      const text = selectedText(sel.getSelectedText())
      if (!text) return
      if (renderer.copyToClipboardOSC52(text)) flash(`copied ${plural(...copiedCount(text))}`, "ok")
      else flash("copy: the terminal has no clipboard (OSC 52)", "error")
    }
    renderer.on("selection", copy)
    return () => void renderer.off("selection", copy)
  }, [])
  // a build still running after unmount must not touch the store
  useEffect(() => () => void (vault.current = { ...vault.current }), [])
  useEffect(() => () => {
    clearTimeout(timers.current.toast)
    clearTimeout(timers.current.hints)
    clearTimeout(timers.current.open)
    clearTimeout(timers.current.roll)
    clearTimeout(timers.current.ghost)
    clearTimeout(timers.current.logo)
    clearTimeout(timers.current.ai)
    clearTimeout(timers.current.gloss)
    clearTimeout(timers.current.steam)
    for (const job of jobs.current.values()) job.abort.abort() // nothing would show or cache the result
  }, [])
  useEffect(() => () => void (alive.current = false), [])
  // the welcome page's ink-in and steam
  useEffect(animateWelcome)
  // code blocks render plain first; once their parser results land, re-render the document
  useEffect(() => {
    const doc = derive().doc
    if (doc === hlSeen.current) return
    hlSeen.current = doc
    const reqs = pendingHighlights(doc)
    if (!reqs.length) return
    ensureHighlights(reqs).then((changed) => {
      if (changed && alive.current) set({ hl: ui.current.hl + 1 })
    })
  })
}
