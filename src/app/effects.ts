// The app's effects, in the order they run: live reload, the change baseline, the project record, the config theme
// toast, a piped document's link scan, exit and copy-on-select listeners, the unmount cleanups, the welcome animation and
// code-block highlighting; then, in `useRenderEffects`, the ones that watch what this render drew (the hint context, the
// zen reading section, the theme sample). Hooks: App calls each once per render, at the same place, so the hook order holds.
import { basename } from "node:path"
import { useEffect, useRef } from "react"
import { reloadToast } from "../ai/delta"
import { plural } from "../lib/text"
import { ensureHighlights } from "../markdown/highlight"
import { pendingHighlights, type Rendered } from "../markdown/render"
import { watchPath } from "../notes/watch"
import { STDIN } from "../notes/workspace"
import { resolveTheme } from "../theme/themepick"
import { copiedCount, selectedText } from "../ui/nav"
import { LOGO_HOLD } from "../ui/status"
import type { AIJobs } from "./ai-jobs"
import type { AppCtx } from "./ctx"
import type { Ctx } from "./keymap"
import type { Links } from "./links"
import { jobKey } from "./store"
import type { WorkspaceControl } from "./workspace"

/** What the effects call from the feature factories. */
export type EffectDeps = Pick<AIJobs, "dropDelta"> &
  Pick<Links, "ensureLinks"> &
  Pick<WorkspaceControl, "recordProject" | "leave" | "animateWelcome">

/** Register every effect of App on the app context (hooks: call it unconditionally, before any early return). */
export function useAppEffects(c: AppCtx, { dropDelta, ensureLinks, recordProject, leave, animateWelcome }: EffectDeps) {
  useNoteWatch(c, dropDelta)
  useStartup(c, ensureLinks, recordProject)
  useRendererListeners(c, leave)
  useUnmountCleanups(c)
  // the welcome page's ink-in and steam
  useEffect(animateWelcome)
  // code blocks render plain first; once their parser results land, re-render the document
  useEffect(() => colourIn(c, c.derive().doc, c.hlSeen))
}

/** Live reload of the open note, then its change baseline. */
function useNoteWatch(
  { ui, set, bump, derive, memo, timers, jobs, flash }: AppCtx,
  dropDelta: EffectDeps["dropDelta"],
) {
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
        if (dl?.result && (d.changes === null || d.changes.length) && !jobs.current.has(jobKey("delta", dl.path)))
          set({ delta: null })
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
}

/** What runs once at mount: the project record, the config theme toast and a piped document's link scan. */
function useStartup(
  { ui, themeName, linkScanDelay, flash }: AppCtx,
  ensureLinks: EffectDeps["ensureLinks"],
  recordProject: EffectDeps["recordProject"],
) {
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
}

/** The renderer's `destroy` and `selection` events. */
function useRendererListeners({ renderer, flash }: AppCtx, leave: EffectDeps["leave"]) {
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
}

/** What stops on unmount: the index build, the timers and AI jobs, and the `alive` flag. */
function useUnmountCleanups({ timers, jobs, vault, alive }: AppCtx) {
  // a build still running after unmount must not touch the store
  useEffect(() => () => void (vault.current = { ...vault.current }), [])
  useEffect(
    () => () => {
      for (const id of Object.values(timers.current)) clearTimeout(id)
      for (const job of jobs.current.values()) job.abort.abort() // nothing would show or cache the result
    },
    [],
  )
  useEffect(() => () => void (alive.current = false), [])
}

/** What the render-time effects watch, as App draws it: the hint context, the zen reading section and the theme sample. */
export interface RenderWatch {
  ctxNow: Ctx
  /** the open note and the reading line's section in zen, else null */
  glossAt: string | null
  sample: Rendered | null
}

/** What the render-time effects call: the hint poke and the gloss auto-show. */
type RenderDeps = { pokeHints: (ctx: Ctx) => void } & Pick<AIJobs, "glossEntered">

/**
 * The effects that need this render's values, in order: hints for a new context, the zen gloss on a section change, the
 * theme sample's highlighting (hooks: call it unconditionally, before any early return).
 */
export function useRenderEffects(
  c: AppCtx,
  { ctxNow, glossAt, sample }: RenderWatch,
  { pokeHints, glossEntered }: RenderDeps,
) {
  /** the context the hints were last poked for */
  const ctxSeen = useRef<Ctx | null>(null)
  /** the note and section the gloss auto-show last ran for (null: outside zen) */
  const glossSeen = useRef<string | null>(null)
  /** the theme sample whose code highlighting was last asked for */
  const hlSample = useRef<Rendered | null>(null)
  // any context change (focus, view, zen, popup closed, typing ended) shows the new context's hints
  useEffect(() => {
    if (ctxNow === ctxSeen.current) return
    ctxSeen.current = ctxNow
    pokeHints(ctxNow)
  })
  // zen gloss: runs when the reading line changes section (not on every scroll tick)
  useEffect(() => {
    if (glossAt === glossSeen.current) return
    glossSeen.current = glossAt
    glossEntered()
  })
  // the sample's code block colours in once the highlighter answers (its cache serves every theme after that)
  useEffect(() => colourIn(c, sample, hlSample))
}

/** Ask for `r`'s code highlights unless `seen` already did; once they land, re-render with them. */
function colourIn({ ui, set, alive }: AppCtx, r: Rendered | null, seen: { current: Rendered | null }) {
  if (!r || r === seen.current) return
  seen.current = r
  const reqs = pendingHighlights(r)
  if (!reqs.length) return
  ensureHighlights(reqs).then((changed) => {
    if (changed && alive.current) set({ hl: ui.current.hl + 1 })
  })
}
