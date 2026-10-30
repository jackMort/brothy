// AI jobs: how many run at once and how often streamed text redraws; `makeJobs`, the gate and
// lifecycle every AI action shares (the switcher's ask too); then `makeAIJobs`, the TL;DR, gloss and reload-explain
// requests and their keys (`a`, `D`, zen `a`). Not pure: both close over the app context.
import { basename } from "node:path"
import { type Gloss, isFresh, loadGlosses, saveGlosses, saveSummaries, textHash } from "../ai/cache"
import {
  aiError,
  aiMessage,
  type ChatReq,
  type ChatResult,
  chat,
  type ErrCtx,
  type Failure,
  noteText,
  shortModel,
  summaryRequest,
} from "../ai/client"
import { type AIConfig, type AITarget, type GlossStyle, PROMPT_V, PROMPTS, resolveAI } from "../ai/config"
import { type Change, type DeltaParse, deltaRequest, hhmm, parseDelta, stepChange } from "../ai/delta"
import { GLOSS_DWELL, type GlossTarget, glossKey, glossRequest } from "../ai/gloss"
import { safeLine } from "../lib/spans"
import { stem } from "../notes/files"
import { STDIN } from "../notes/workspace"
import { loadConfig } from "../system/config"
import type { AppCtx } from "./ctx"
import type { Derived } from "./derive"
import type { Links } from "./links"
import { type Job, type JobKind, jobKey, type UI } from "./store"

/** AI requests in flight at once, over every kind (TL;DR, gloss, reload explain, ask) */
const MAX_JOBS = 3
/** streamed summary text re-renders at most this often (ms) */
const AI_FRAME = 100
/** a job with no text yet redraws once a second, so its waiting row counts */
const WAIT_TICK = 1000

/** Toasts every AI action shares. */
export const AI_OFF = `AI off · set "ai" in config.json`
const AI_BUSY = `AI busy · ${MAX_JOBS} requests running`

/** How `startJob` runs a request. */
interface JobRun {
  /** each delta lands in `job.raw` and redraws at most every AI_FRAME */
  stream?: boolean
  /** runs once the job is registered, before the request goes out */
  begin?: () => void
  /** the result, only while the job is still the one under its key (not cancelled or replaced), once it left `jobs`, and while App is mounted */
  done: (r: ChatResult, job: Job) => void
}

// ------------------------------------------------------------- lifecycle

/** Starting and cancelling jobs, which live in the context's refs (`jobs`, `timers`). */
function makeRunner(c: AppCtx) {
  const { jobs, timers, bump, alive, fetchImpl } = c

  /** one redraw per AI_FRAME while text streams in */
  const aiRedraw = () => {
    if (timers.current.ai) return
    timers.current.ai = setTimeout(() => {
      timers.current.ai = undefined
      if (alive.current) bump((x) => x + 1)
    }, AI_FRAME)
  }

  /** One redraw per second while some job has no text yet, on the next whole second of the soonest; never calls the network. */
  const ensureWaitTick = () => {
    if (timers.current.wait) return
    const now = Date.now()
    const waiting = [...jobs.current.values()].filter((j) => !j.live)
    if (!waiting.length) return
    const next = Math.min(...waiting.map((j) => WAIT_TICK - ((now - j.at) % WAIT_TICK)))
    timers.current.wait = setTimeout(() => {
      timers.current.wait = undefined
      if (!alive.current) return
      bump((x) => x + 1)
      ensureWaitTick()
    }, next)
  }

  /** Abort job `key` and forget it; false when none runs. */
  const cancelJob = (key: string) => {
    const job = jobs.current.get(key)
    if (!job) return false
    job.abort.abort()
    jobs.current.delete(key)
    return true
  }

  /** Send `req` to `target` as job `<kind>:<id>` (`jobKey`); `run` says whether it streams and what follows. */
  const startJob = (kind: JobKind, id: string | undefined, target: AITarget, req: ChatReq, run: JobRun) => {
    const key = jobKey(kind, id)
    const job: Job = { kind, raw: "", abort: new AbortController(), at: Date.now(), model: target.model, live: false }
    jobs.current.set(key, job)
    ensureWaitTick()
    run.begin?.()
    const onDelta = run.stream
      ? (raw: string) => {
          job.raw = raw
          if (!job.live) job.live = req.clean(raw) !== ""
          aiRedraw()
        }
      : undefined
    void chat(target, req, { fetch: fetchImpl, signal: job.abort.signal, onDelta }).then((r) => {
      if (jobs.current.get(key) !== job) return // cancelled, replaced, or the note was left
      jobs.current.delete(key)
      if (alive.current) run.done(r, job)
    })
  }

  return { cancelJob, startJob }
}

/**
 * What every AI action shares: re-reading the `ai` block, the gate, starting and cancelling a job, the failure toast.
 * `makeAIJobs` and `makeSwitcher` each build one; its state lives in the context's refs (`jobs`, `timers`).
 */
export function makeJobs(c: AppCtx) {
  const { set, jobs, flash } = c

  /** Re-read the `ai` block into the store (editing config.json applies without a restart); null: AI off. */
  const reloadAI = () => {
    const ai = loadConfig().ai ?? null
    set({ ai })
    return ai
  }

  /** Room for one more request and the target `ai` resolves to; else its toast (`busy` also hears the busy one) and null. */
  const aiGate = (ai: AIConfig, busy?: (msg: string) => void): AITarget | null => {
    if (jobs.current.size >= MAX_JOBS) {
      flash(AI_BUSY)
      busy?.(AI_BUSY)
      return null
    }
    const target = resolveAI(ai, process.env)
    if (!("error" in target)) return target
    flash(target.error, "error")
    return null
  }

  /** The toast for failure `f` of a request to `target`: what it was for (`noun`), and the note or heading when it is not the current one. */
  const failText = (target: AITarget, f: Failure, noun?: ErrCtx["noun"], note?: string) =>
    aiError(f, { host: target.host, keyEnv: target.keyEnv, key: target.key, noun, note })

  return { reloadAI, aiGate, failText, ...makeRunner(c) }
}

export type Jobs = ReturnType<typeof makeJobs>

// ------------------------------------------------------------- jobs

/** The zen gloss note: the cache read once, fading out, showing a cached or streaming gloss when the reading line enters its section. */
function makeGlossSheet(c: AppCtx) {
  const { ui, set, derive, jobs, timers, alive, runFade } = c

  /** glosses.json is read once, and only when zen meets an `ai` block (auto-show needs it). */
  const ensureGlosses = () => {
    if (ui.current.ai && ui.current.glosses === null) set({ glosses: loadGlosses() })
  }

  /** The reading line left the note's section: fade it out over GHOST_STEPS, then drop it. */
  const fadeGloss = () => {
    const g = ui.current.gloss
    if (!g || g.fadeAt !== null) return
    set({ gloss: { ...g, fadeAt: Date.now() } })
    runFade(
      "gloss",
      () => ui.current.gloss?.fadeAt ?? null,
      0,
      () => set({ gloss: null }),
    )
  }

  /**
   * The reading line entered another section (or note, or zen): fade the old note. A running request for the new section
   * shows at once; a cached gloss, fresh or outdated, after GLOSS_DWELL so skimming with `]` stays quiet (at once when
   * zen was just entered: `immediate`).
   */
  const glossEntered = (immediate: boolean) => {
    clearTimeout(timers.current.dwell)
    const d = derive()
    const { s, gHere } = d
    const g = s.gloss
    if (g && g.id !== gHere?.id) fadeGloss()
    if (!gHere || !s.ai || !s.glosses || (g?.id === gHere.id && g.fadeAt === null)) return
    if (jobs.current.has(jobKey("gloss", gHere.id))) return showGloss(set, d)
    if (!s.glosses[glossKey(gHere.id, d.gStyle)]) return
    if (immediate) return showGloss(set, d)
    const id = gHere.id
    timers.current.dwell = setTimeout(() => {
      const now = derive()
      const shown = now.s.gloss?.id === id && now.s.gloss.fadeAt === null
      if (alive.current && now.gHere?.id === id && !shown) showGloss(set, now)
    }, GLOSS_DWELL)
  }

  return { ensureGlosses, glossEntered }
}

/** Show the reading section's note, collapsed, as `d` derives it. */
function showGloss(set: AppCtx["set"], { gHere, gHash, gStyle }: Derived) {
  if (!gHere) return
  const key = glossKey(gHere.id, gStyle)
  set({
    gloss: { id: gHere.id, index: gHere.index, key, heading: gHere.heading, hash: gHash, fadeAt: null, open: false },
  })
}

/** Send one section to the AI as a gloss and cache the reply. */
function makeStartGloss(c: AppCtx, { failText, startJob }: Pick<Jobs, "failText" | "startJob">) {
  const { ui, set, bump, derive, flash } = c

  /** Send section `g` in `style`; the result is cached under its own section and style whatever is under the reading line by then. */
  const startGloss = (g: GlossTarget, style: GlossStyle, title: string, target: AITarget, model: string) => {
    const hash = textHash(g.text) // taken now: a section edited meanwhile shows the result as outdated
    const key = glossKey(g.id, style)
    startJob("gloss", g.id, target, glossRequest(style, title, g.trail, g.text, target.maxChars), {
      stream: true,
      begin: () =>
        set({ gloss: { id: g.id, index: g.index, key, heading: g.heading, hash, fadeAt: null, open: false } }),
      done: (r) => {
        if (r.ok) {
          const entry: Gloss = { hash, v: PROMPTS.gloss, gloss: r.text, model, at: Date.now() }
          set({ glosses: { ...(ui.current.glosses ?? {}), [key]: entry } })
          // sectionId starts with the open path, and STDIN is the only relative one: a piped document lives for this run only
          if (!g.id.startsWith(`${STDIN}#`)) saveGlosses({ [key]: entry })
        } else if ("failure" in r) {
          // the note closes; the cached gloss returns only when the reading line re-enters the section (or on `a`)
          if (ui.current.gloss?.id === g.id) set({ gloss: null })
          const reading = derive().gHere?.id === g.id
          bump((x) => x + 1)
          flash(failText(target, r.failure, "gloss", reading ? undefined : safeLine(g.heading)), "error")
        }
      },
    })
  }

  return startGloss
}

/** A gloss request about to go: the `ai` block, this derive and its reading section. */
type GlossAsk = { ai: AIConfig; d: Derived; gHere: GlossTarget }

/** zen `a` and `A`: gloss the section under the reading line. */
function makeZenGloss(
  c: AppCtx,
  jobs: Jobs,
  { ensureGlosses }: Pick<ReturnType<typeof makeGlossSheet>, "ensureGlosses">,
) {
  const { ui, set, bump, derive, flash } = c
  const { reloadAI, cancelJob, aiGate } = jobs
  const startGloss = makeStartGloss(c, jobs)

  /** Cancel the gloss running for section `id` and close its note; false when none runs. */
  const cancelGloss = (id: string) => {
    if (!cancelJob(jobKey("gloss", id))) return false
    if (ui.current.gloss?.id === id) set({ gloss: null })
    bump((x) => x + 1)
    return true
  }

  /** What a gloss request needs: AI on, the cache read, a section to gloss; null after toasting why not. */
  const glossReady = (ai: AIConfig | null): GlossAsk | null => {
    if (!ai) {
      flash(AI_OFF)
      return null
    }
    ensureGlosses()
    const d = derive()
    if (d.gHere) return { ai, d, gHere: d.gHere }
    flash("nothing to gloss here")
    return null
  }

  /** Ask for the reading section's gloss (busy and `resolveAI` toast instead). */
  const askGloss = ({ ai, d, gHere }: GlossAsk) => {
    const target = aiGate(ai)
    if (target) startGloss(gHere, d.gStyle, d.title, target, ai.model)
  }

  /**
   * zen `a`: a running gloss is cancelled; a fresh one on screen shows more or less of itself; a fresh one hidden (esc,
   * an error, a cancel) comes back without a request; otherwise (outdated or missing) the press is the explicit ask.
   */
  const zenGloss = () => {
    const ai = reloadAI()
    const section = derive().gHere
    // cancel first: a request stays cancellable after its `ai` block goes
    if (section && cancelGloss(section.id)) return flash("gloss cancelled")
    const ready = glossReady(ai)
    if (!ready) return
    const { d, gHere } = ready
    const g = d.s.gloss
    if (g?.id === gHere.id && g.fadeAt === null && d.sheet?.state === "result") {
      if (!d.overflow && !g.open) return flash("nothing more · A asks again")
      return set({ gloss: { ...g, open: !g.open } })
    }
    if (freshGloss(d.s, glossKey(gHere.id, d.gStyle), d.gHash)) return showGloss(set, d)
    askGloss(ready)
  }

  /** zen `A`: ask again, replacing the cached gloss; nothing while one runs (its rule says `a cancel`). */
  const zenRegen = () => {
    const ai = reloadAI()
    const section = derive().gHere
    if (section && c.jobs.current.has(jobKey("gloss", section.id))) return
    const ready = glossReady(ai)
    if (ready) askGloss(ready)
  }

  return { zenGloss, zenRegen }
}

/** `a`: the TL;DR request for the open note. */
function makeSummary(c: AppCtx, { reloadAI, cancelJob, aiGate, failText, startJob }: Jobs) {
  const { ui, set, bump, memo, derive, flash, focusPanel } = c

  /** `path`'s failed request forgotten: a new one starts, or it succeeded. */
  const withoutErr = (path: string) =>
    Object.fromEntries(Object.entries(ui.current.summaryErr).filter(([p]) => p !== path))

  /** A summary landed out of sight: Info isn't on screen, or it is for another note. */
  const readyToast = (path: string) => {
    const d = derive()
    const here = d.s.openPath === path
    if (here && d.L.shown && d.s.view === "info") return
    flash(here ? "TL;DR ready · 3 to read" : `TL;DR ready · ${stem(basename(path))}`)
  }

  /** Send `text` for `path`; the result is cached for that path whatever note is current by then. */
  const startSummary = (path: string, text: string, target: AITarget, model: string) => {
    const hash = textHash(text) // taken now: a note edited meanwhile shows the result as outdated
    startJob("tldr", path, target, summaryRequest(text, target.maxChars), {
      stream: true,
      begin: () => set({ summaryErr: withoutErr(path), tldrOpen: false }),
      done: (r) => {
        if (r.ok) {
          const entry = { hash, v: PROMPT_V, summary: r.text, model, at: Date.now() }
          set({ summaries: { ...ui.current.summaries, [path]: entry } })
          if (path !== STDIN) saveSummaries({ [path]: entry }) // a piped document lives for this run only
          readyToast(path)
        } else if ("failure" in r) {
          // the error stays in the block (memory only) as well as in the toast
          const msg = aiMessage(r.failure, { host: target.host, keyEnv: target.keyEnv, key: target.key })
          set({ summaryErr: { ...ui.current.summaryErr, [path]: { msg, hash } } })
          const note = ui.current.openPath === path ? undefined : stem(basename(path))
          flash(failText(target, r.failure, undefined, note), "error")
        }
      },
    })
  }

  /** `a`: summarize the open note into Info's TL;DR; a running summary is cancelled instead. */
  const summarizeNote = () => {
    const ai = reloadAI()
    focusPanel("info")
    const s = ui.current
    const path = s.openPath
    if (path && cancelJob(jobKey("tldr", path))) {
      // a running request is cancelled first, whatever the config or the note now say
      bump((x) => x + 1)
      return flash("summary cancelled")
    }
    if (!ai) return flash(AI_OFF)
    const file = path ? memo.read(path, s.reload) : null
    const text = file && !file.error ? noteText(file.src) : ""
    if (!path || !text) return flash("nothing to summarize")
    const target = aiGate(ai)
    if (target) startSummary(path, text, target, ai.model) // a fresh summary is regenerated too: `a` is the explicit ask
  }

  return { summarizeNote }
}

/** `D`: send the changed hunks of a note and keep the reply. */
function makeDeltaStart(c: AppCtx, { failText, startJob }: Jobs) {
  const { ui, set, bump, flash } = c

  /**
   * Send the changed hunks of `path` (listed since `since`); the explanation before it moves to Earlier. On success the
   * baseline moves to the sent text, so later edits list anew; a failure stays in the block while the note is the sent
   * text, the baseline where it was.
   */
  const startDelta = (o: {
    path: string
    changes: Change[]
    text: string
    props: string
    since: number
    title: string
    target: AITarget
  }) => {
    const { path, changes, text, props, since, target } = o
    startJob("delta", path, target, deltaRequest(o.title, changes, target.maxChars), {
      stream: true,
      begin: () => {
        const prev = ui.current.delta?.path === path ? ui.current.delta : null
        const earlier = prev?.result ?? prev?.earlier ?? null
        set({ delta: { path, changes, text, props, since, result: null, error: null, earlier } })
      },
      done: (r, job) => {
        const s = ui.current
        const dl = s.delta
        if (dl?.path !== path) return bump((x) => x + 1)
        const out = deltaOutcome(r, job.raw, changes)
        if (!out) return set({ delta: dl.earlier ? dl : null })
        if ("failure" in out) {
          const error = aiMessage(out.failure, {
            host: target.host,
            keyEnv: target.keyEnv,
            key: target.key,
            noun: "explanation",
          })
          set({ delta: { ...dl, error } })
          return flash(failText(target, out.failure, "explanation"), "error")
        }
        // edits made during the request now differ from the moved baseline and list as a new idle change set, the
        // reply under Earlier
        const baseline = s.baseline?.path === path ? { ...s.baseline, text, props, at: Date.now() } : s.baseline
        const result = { ...out.parsed, model: shortModel(job.model), since, changes }
        set({ baseline, delta: { ...dl, result } })
      },
    })
  }

  return { startDelta }
}

/** `D`: the reload-explain request for the open note's changes. */
function makeReloadExplain(c: AppCtx, jobs: Jobs, { jumpChange }: Pick<Links, "jumpChange">) {
  const { reloadAI, cancelJob, aiGate } = jobs
  const { ui, set, derive, flash, focusPanel } = c
  const { startDelta } = makeDeltaStart(c, jobs)

  /** Forget the open note's baseline and explanation; a `D` still running for it is cancelled. */
  const dropDelta = () => {
    const s = ui.current
    if (s.delta) cancelJob(jobKey("delta", s.delta.path))
    if (s.baseline || s.delta || s.landing || s.proof)
      set({ baseline: null, delta: null, changesOpen: false, landing: null, proof: null })
  }

  /** Where `D` shows its explanation: Info; below 100 columns, where Info is a drawer over the note, the first change's footnote. */
  const showDelta = (d: Derived) => {
    const first = d.changes && stepChange(d.changes, 0, 1)
    if (d.L.mode === "drawer" && first) jumpChange(first - 1)
    else focusPanel("info")
  }

  /** A `D` running for `path` cancelled (back to the list, Earlier kept); false when none runs. */
  const cancelDelta = (path: string | null) => {
    if (!path || !cancelJob(jobKey("delta", path))) return false
    const dl = ui.current.delta
    set({ delta: dl?.earlier ? dl : null })
    flash("explanation cancelled")
    return true
  }

  /**
   * `D`: explain the open note's changes since its baseline; a running explanation is cancelled instead. `show`: take the
   * reader to where it appears (Info, or the first change's footnote); the Proof sheet shows it in place.
   */
  const explainChange = (show: boolean) => {
    const ai = reloadAI()
    const d = derive()
    const path = d.s.openPath
    // cancel first: a request stays cancellable after its `ai` block goes or the note is reverted
    if (cancelDelta(path)) return
    if (!ai) return flash(AI_OFF)
    if (d.changes === null) return flash("too large to compare")
    const base = d.s.baseline?.path === path ? d.s.baseline : null
    if (!path || !base || !d.changes.length) return flash(`no changes since ${hhmm(base?.at ?? Date.now())}`)
    const target = aiGate(ai)
    if (!target) return
    if (show) showDelta(d)
    startDelta({ path, changes: d.changes, text: d.after, props: d.propsKey, since: base.at, title: d.title, target })
  }

  return { dropDelta, explainChange: () => explainChange(true), explainInSheet: () => explainChange(false) }
}

/** The TL;DR, zen gloss and reload-explain requests: start, stream, cache, cancel. */
export function makeAIJobs(c: AppCtx, links: Pick<Links, "jumpChange">) {
  const jobs = makeJobs(c)
  const { ensureGlosses, glossEntered } = makeGlossSheet(c)
  return {
    ensureGlosses,
    glossEntered,
    ...makeReloadExplain(c, jobs, links),
    ...makeSummary(c, jobs),
    ...makeZenGloss(c, jobs, { ensureGlosses }),
  }
}

/** Whether the cache holds a gloss under `key` that is fresh for section text hashed `hash`. */
function freshGloss(s: UI, key: string, hash: string) {
  const e = s.glosses?.[key]
  return !!e && isFresh(e, hash, PROMPTS.gloss)
}

/** What a finished `D` request leaves: the explanation, a failure to toast, or null when it was cancelled. */
export function deltaOutcome(
  r: ChatResult,
  raw: string,
  changes: Change[],
): { parsed: DeltaParse } | { failure: Failure } | null {
  // a reply past MAX_DELTA keeps what had arrived: the summary and every finished § line
  const cut = !r.ok && "failure" in r && r.failure.kind === "tooLong" ? parseDelta(raw, changes, true) : null
  if (!r.ok && !cut) return "failure" in r ? { failure: r.failure } : null
  const parsed = cut ?? (r.ok ? parseDelta(r.text, changes) : null)
  return parsed ? { parsed } : { failure: { kind: "invalid" } }
}

/** What `makeAIJobs` gives App and the other factories. */
export type AIJobs = ReturnType<typeof makeAIJobs>
