// AI jobs: how many run at once, how they are keyed and how often streamed text redraws; then `makeAIJobs`, the
// TL;DR, gloss and reload-explain requests and their keys (`a`, `D`, zen `a`). Not pure: it closes over the app context.
import { basename } from "node:path"
import { PROMPTS, PROMPT_V, aiError, chat, noteText, shortModel, summarize, type Failure } from "../ai"
import { resolveAI, type AITarget, type GlossStyle } from "../ai-config"
import { loadConfig } from "../config"
import { deltaRequest, hhmm, parseDelta, type Change } from "../delta"
import { stem } from "../files"
import { glossKey, glossRequest, type GlossTarget } from "../gloss"
import { safeLine } from "../spans"
import { isFresh, loadGlosses, saveGlosses, saveSummaries, textHash, type Gloss } from "../summaries"
import { STDIN } from "../workspace"
import type { AppCtx } from "./ctx"

/** AI requests in flight at once, over every kind (TL;DR, gloss, reload explain, ask) */
export const MAX_JOBS = 3
/** What an AI job is for. Its key in `jobs` is `<kind>:<id>` (`tldr:<path>`, `gloss:<sectionId>`, `delta:<path>`), or the bare kind for `ask` (one at a time). */
export type JobKind = "tldr" | "gloss" | "delta" | "ask"
/** The `jobs` key of a job: `<kind>:<id>`, or the bare kind without an id. */
export const jobKey = (kind: JobKind, id?: string) => (id === undefined ? kind : `${kind}:${id}`)
/** A request in flight: its kind, the raw text streamed so far and how to cancel it. */
export interface Job {
  kind: JobKind
  raw: string
  abort: AbortController
}
/** streamed summary text re-renders at most this often (ms) */
export const AI_FRAME = 100

// ------------------------------------------------------------- jobs

/** The TL;DR, zen gloss and reload-explain requests: start, stream, cache, cancel. */
export function makeAIJobs(c: AppCtx) {
  const { ui, set, bump, derive, memo, jobs, timers, alive, fetchImpl, flash, runFade, focusPanel } = c

  /** one redraw per AI_FRAME while text streams in */
  const aiRedraw = () => {
    if (timers.current.ai) return
    timers.current.ai = setTimeout(() => {
      timers.current.ai = undefined
      if (alive.current) bump((x) => x + 1)
    }, AI_FRAME)
  }

  /** glosses.json is read once, and only when zen meets an `ai` block (auto-show needs it). */
  const ensureGlosses = () => {
    if (ui.current.ai && ui.current.glosses === null) set({ glosses: loadGlosses() })
  }

  /** The reading line left the sheet's section: fade it out over GHOST_STEPS, then drop it. */
  const fadeGloss = () => {
    const g = ui.current.gloss
    if (!g || g.fadeAt !== null) return
    set({ gloss: { ...g, fadeAt: Date.now() } })
    runFade("gloss", () => ui.current.gloss?.fadeAt ?? null, 0, () => set({ gloss: null }))
  }

  /** The reading line entered another section (or note, or zen): fade the old sheet; show a fresh cached gloss or a running stream. */
  const glossEntered = () => {
    const { s, gHere, gHash, gStyle } = derive()
    const g = s.gloss
    if (g && g.id !== gHere?.id) fadeGloss()
    if (!gHere || !s.ai || !s.glosses || (g?.id === gHere.id && g.fadeAt === null)) return
    const key = glossKey(gHere.id, gStyle)
    const e = s.glosses[key]
    // outdated or missing glosses never appear by themselves: they need `a`
    if (jobs.current.has(jobKey("gloss", gHere.id)) || (e && isFresh(e, gHash, PROMPTS.gloss)))
      set({ gloss: { id: gHere.id, key, heading: gHere.heading, hash: gHash, fadeAt: null } })
  }

  /** Send section `g` in `style`; the result is cached under its own section and style whatever is under the reading line by then. */
  const startGloss = (g: GlossTarget, style: GlossStyle, title: string, target: AITarget, model: string) => {
    const hash = textHash(g.text) // taken now: a section edited meanwhile shows the result as outdated
    const key = glossKey(g.id, style)
    const jk = jobKey("gloss", g.id)
    const job = { kind: "gloss" as const, raw: "", abort: new AbortController() }
    jobs.current.set(jk, job)
    set({ gloss: { id: g.id, key, heading: g.heading, hash, fadeAt: null } })
    void chat(target, glossRequest(style, title, g.trail, g.text, target.maxChars), {
      fetch: fetchImpl,
      signal: job.abort.signal,
      onDelta: (raw) => {
        job.raw = raw
        aiRedraw()
      },
    }).then((r) => {
      if (jobs.current.get(jk) !== job) return // cancelled
      jobs.current.delete(jk)
      if (!alive.current) return
      if (r.ok) {
        const entry: Gloss = { hash, v: PROMPTS.gloss, gloss: r.text, model, at: Date.now() }
        set({ glosses: { ...(ui.current.glosses ?? {}), [key]: entry } })
        // sectionId starts with the open path, and STDIN is the only relative one: a piped document lives for this run only
        if (!g.id.startsWith(`${STDIN}#`)) saveGlosses({ [key]: entry })
      } else if ("failure" in r) {
        // the sheet closes; the cached gloss returns only when the reading line re-enters the section (or on `a`)
        if (ui.current.gloss?.id === g.id) set({ gloss: null })
        const here = derive().gHere?.id === g.id
        bump((x) => x + 1)
        flash(aiError(r.failure, { host: target.host, keyEnv: target.keyEnv, key: target.key, noun: "gloss", note: here ? undefined : safeLine(g.heading) }), "error")
      }
    })
  }

  /** Send `text` for `path`; the result is cached for that path whatever note is current by then. */
  const startSummary = (path: string, text: string, target: AITarget, model: string) => {
    const hash = textHash(text) // taken now: a note edited meanwhile shows the result as outdated
    const key = jobKey("tldr", path)
    const job = { kind: "tldr" as const, raw: "", abort: new AbortController() }
    jobs.current.set(key, job)
    bump((x) => x + 1)
    void summarize(target, text, {
      fetch: fetchImpl,
      signal: job.abort.signal,
      onDelta: (raw) => {
        job.raw = raw
        aiRedraw()
      },
    }).then((r) => {
      if (jobs.current.get(key) !== job) return // cancelled
      jobs.current.delete(key)
      if (!alive.current) return
      if (r.ok) {
        const entry = { hash, v: PROMPT_V, summary: r.text, model, at: Date.now() }
        set({ summaries: { ...ui.current.summaries, [path]: entry } })
        if (path !== STDIN) saveSummaries({ [path]: entry }) // a piped document lives for this run only
      } else if ("failure" in r) {
        const note = ui.current.openPath === path ? undefined : stem(basename(path))
        bump((x) => x + 1)
        flash(aiError(r.failure, { host: target.host, keyEnv: target.keyEnv, key: target.key, note }), "error")
      }
    })
  }

  /** Forget the open note's baseline and explanation; a `D` still running for it is cancelled. */
  const dropDelta = () => {
    const s = ui.current
    if (s.delta) {
      const key = jobKey("delta", s.delta.path)
      jobs.current.get(key)?.abort.abort()
      jobs.current.delete(key)
    }
    if (s.baseline || s.delta) set({ baseline: null, delta: null })
  }

  /** Send the changed hunks of `path`; on success the baseline moves to the sent text, so later edits list anew. */
  const startDelta = (path: string, changes: Change[], text: string, props: string, title: string, target: AITarget, model: string) => {
    const key = jobKey("delta", path)
    const job = { kind: "delta" as const, raw: "", abort: new AbortController() }
    jobs.current.set(key, job)
    set({ delta: { path, changes, text, props, result: null } })
    void chat(target, deltaRequest(title, changes, target.maxChars), {
      fetch: fetchImpl,
      signal: job.abort.signal,
      onDelta: (raw) => {
        job.raw = raw
        aiRedraw()
      },
    }).then((r) => {
      if (jobs.current.get(key) !== job) return // cancelled, or the note was left
      jobs.current.delete(key)
      if (!alive.current) return
      const s = ui.current
      if (s.delta?.path !== path) return bump((x) => x + 1)
      const fail = (f: Failure) => {
        set({ delta: null })
        flash(aiError(f, { host: target.host, keyEnv: target.keyEnv, key: target.key, noun: "explanation" }), "error")
      }
      // a reply past MAX_DELTA keeps what had arrived: the summary and every finished § line
      const cut = !r.ok && "failure" in r && r.failure.kind === "tooLong" ? parseDelta(job.raw, changes, true) : null
      if (!r.ok && !cut) return "failure" in r ? fail(r.failure) : set({ delta: null })
      const parsed = cut ?? (r.ok ? parseDelta(r.text, changes) : null)
      if (!parsed) return fail({ kind: "invalid" })
      // edits made during the request now differ from the moved baseline and list as a new idle
      // change set; the reply is kept only when it still describes the note as it is
      const baseline = s.baseline?.path === path ? { ...s.baseline, text, props, at: Date.now() } : s.baseline
      set({ baseline, delta: derive().after === text ? { ...s.delta, result: { ...parsed, model: shortModel(model) } } : null })
    })
  }

  /** `a`: summarize the open note into Info's TL;DR; a running summary is cancelled instead. */
  const summarizeNote = () => {
    const ai = loadConfig().ai ?? null // re-read: editing config.json applies without a restart
    set({ ai })
    focusPanel("info")
    const s = ui.current
    const path = s.openPath
    const key = path ? jobKey("tldr", path) : ""
    const running = path ? jobs.current.get(key) : undefined
    if (running) { // a running request is cancelled first, whatever the config or the note now say
      running.abort.abort()
      jobs.current.delete(key)
      bump((x) => x + 1)
      return flash("summary cancelled")
    }
    if (!ai) return flash(`AI off · set "ai" in config.json`)
    const file = path ? memo.read(path, s.reload) : null
    const text = file && !file.error ? noteText(file.src) : ""
    if (!path || !text) return flash("nothing to summarize")
    if (jobs.current.size >= MAX_JOBS) return flash(`AI busy · ${MAX_JOBS} requests running`)
    const target = resolveAI(ai, process.env)
    if ("error" in target) return flash(target.error, "error")
    startSummary(path, text, target, ai.model) // a fresh summary is regenerated too: `a` is the explicit ask
  }

  /** `D`: explain the open note's changes since its baseline; a running explanation is cancelled instead. */
  const explainChange = () => {
    const ai = loadConfig().ai ?? null // re-read, as `a` does
    set({ ai })
    const d = derive()
    const path = d.s.openPath
    const key = path ? jobKey("delta", path) : ""
    const running = jobs.current.get(key)
    // cancel first: a request stays cancellable after its `ai` block goes or the note is reverted
    if (running) {
      running.abort.abort()
      jobs.current.delete(key)
      set({ delta: null })
      return flash("explanation cancelled")
    }
    if (!ai) return flash(`AI off · set "ai" in config.json`)
    if (d.changes === null) return flash("too large to compare")
    const base = d.s.baseline?.path === path ? d.s.baseline : null
    if (!path || !base || !d.changes.length) return flash(`no changes since ${hhmm(base?.at ?? Date.now())}`)
    if (jobs.current.size >= MAX_JOBS) return flash(`AI busy · ${MAX_JOBS} requests running`)
    const target = resolveAI(ai, process.env)
    if ("error" in target) return flash(target.error, "error")
    focusPanel("info")
    startDelta(path, d.changes, d.after, d.propsKey, d.title, target, ai.model)
  }

  /** zen `a`: gloss the section under the reading line, or show its fresh cached gloss; a running gloss is cancelled instead. */
  const zenGloss = () => {
    const ai = loadConfig().ai ?? null // re-read: editing config.json applies without a restart
    set({ ai })
    const here = derive().gHere
    const jk = here ? jobKey("gloss", here.id) : ""
    const running = jobs.current.get(jk)
    // cancel first: a request stays cancellable after its `ai` block goes
    if (here && running) {
      running.abort.abort()
      jobs.current.delete(jk)
      if (ui.current.gloss?.id === here.id) set({ gloss: null })
      bump((x) => x + 1)
      return flash("gloss cancelled")
    }
    if (!ai) return flash(`AI off · set "ai" in config.json`)
    ensureGlosses()
    const { s, gHere, gHash, gStyle, title } = derive()
    if (!gHere) return flash("nothing to gloss here")
    const key = glossKey(gHere.id, gStyle)
    const e = s.glosses?.[key]
    const shown = s.gloss?.id === gHere.id && s.gloss.fadeAt === null
    // a fresh gloss that isn't on screen (esc, an error, a cancel) comes back without a request
    if (e && !shown && isFresh(e, gHash, PROMPTS.gloss)) return set({ gloss: { id: gHere.id, key, heading: gHere.heading, hash: gHash, fadeAt: null } })
    // on screen (fresh or outdated), outdated or missing: the press is the explicit ask
    if (jobs.current.size >= MAX_JOBS) return flash(`AI busy · ${MAX_JOBS} requests running`)
    const target = resolveAI(ai, process.env)
    if ("error" in target) return flash(target.error, "error")
    startGloss(gHere, gStyle, title, target, ai.model)
  }

  return { ensureGlosses, glossEntered, dropDelta, summarizeNote, explainChange, zenGloss }
}
/** What `makeAIJobs` gives App and the other factories. */
export type AIJobs = ReturnType<typeof makeAIJobs>
