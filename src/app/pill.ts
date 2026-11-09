// The chat pill: `c`, its input and `[[` chips, sending a question about the open note, cancelling, the card's marks,
// folding onto a cite and stepping through the cites, and the one animation timer. Not pure: closes over the app context.
import { basename } from "node:path"
import { aiMessage, type ChatResult, cleanReply, type Failure, noteText, shortModel } from "../ai/client"
import type { AITarget } from "../ai/config"
import {
  bodyParts,
  type Chip,
  chatContext,
  chatRequest,
  type Exchange,
  parseSources,
  splitReply,
  type Thread,
  verifyCites,
} from "../ai/thread"
import { stem } from "../notes/files"
import { STDIN } from "../notes/workspace"
import { AI_OFF, type Jobs, makeJobs } from "./ai-jobs"
import type { AppCtx } from "./ctx"
import { erase } from "./input"
import type { Links } from "./links"
import { jobKey, type PillState } from "./store"

/** The `[[` query at the input's end: `[[` and what follows it, up to a `]`. */
const PICK_TAIL = /\[\[([^\]]*)$/
/** The `[[` query being typed, or null. */
const pickQ = (input: string) => PICK_TAIL.exec(input)?.[1] ?? null
/** The input without its `[[` query (esc on the list, a chip added). */
const dropPick = (input: string) => input.replace(PICK_TAIL, "")

/** The chip of the open note: its stem, or the piped document's title. */
const chipOf = (path: string, title: string): Chip => ({ path, title: path === STDIN ? title : stem(basename(path)) })

/** Small helpers every pill factory shares. */
function pillState(c: AppCtx) {
  const { ui, set } = c
  const patch = (p: Partial<PillState>) => {
    const pill = ui.current.pill
    if (pill) set({ pill: { ...pill, ...p } })
  }
  const setThread = (t: Thread) => set({ threads: { ...ui.current.threads, [t.path]: t } })
  return { patch, setThread }
}

/** `c`: back to the card from a cite, else the gates, the drawer closed, and the pill on the open note's thread. */
function makePillOpen(c: AppCtx, jobs: Jobs, animate: () => void) {
  const { ui, set, memo, derive, flash, focusDoc } = c
  const { patch, setThread } = pillState(c)

  /** Folded on a cite: the card comes back with the keys. */
  const unfold = () => {
    patch({ focus: true, card: true, land: null, top: null, openedAt: Date.now() })
    animate()
  }

  /** The open note, when it reads and has text to ask about. */
  const openNote = () => {
    const { openPath, reload } = ui.current
    const file = openPath ? memo.read(openPath, reload) : null
    return file && !file.error && noteText(file.src) ? openPath : null
  }

  /** The open note when chat can be about it; else the toast that says why not, and null. */
  const askable = (): string | null => {
    if (!jobs.reloadAI()) {
      flash(AI_OFF)
      return null
    }
    const path = openNote()
    if (!path) flash("nothing to ask about")
    return path
  }

  /** The drawer closes: the pill never shows with it. */
  const closeDrawer = () => {
    const { L } = derive()
    if (L.mode === "drawer" && L.shown) focusDoc()
  }

  /** The pill on `path`'s thread (made with the open note's chip when new): the card up when it has exchanges. */
  const show = (path: string) => {
    const d = derive()
    closeDrawer()
    const t = ui.current.threads[path] ?? { path, chips: [chipOf(path, d.title)], turns: [] }
    setThread(t)
    const card = t.turns.length > 0
    set({
      pill: { path, focus: true, card, input: "", hl: null, top: null, pick: null, land: null, openedAt: Date.now() },
    })
    animate()
  }

  const pillOpen = () => {
    const p = ui.current.pill
    if (p && !p.focus) return unfold()
    const path = askable()
    if (!path) return
    // still open on this note, only hidden behind the drawer (a resize opened it): it comes back as it was
    if (p?.path === path) return closeDrawer()
    show(path)
  }
  return { pillOpen }
}

/** The input: typing (the `[[` list follows its tail), `⌫`, `^u`, `↑` recall. */
function makePillInput(c: AppCtx, { ensureLinks }: Pick<Links, "ensureLinks">) {
  const { ui, flash } = c
  const { patch, setThread } = pillState(c)

  /** The input changed: the `[[` list follows its tail; the first `[[` scans the links. */
  const setInput = (input: string) => {
    const q = pickQ(input)
    const was = ui.current.pill?.pick
    if (q !== null && !was) ensureLinks()
    patch({ input, pick: q === null ? null : { q, hl: was?.q === q ? was.hl : 0 } })
  }
  const pillType = (text: string) => setInput((ui.current.pill?.input ?? "") + text)

  /** `⌫`: a character, else the last chip (never the only one). */
  const pillErase = () => {
    const p = ui.current.pill
    const t = p && ui.current.threads[p.path]
    if (!p || !t) return
    if (p.input) return setInput(erase(p.input))
    if (t.chips.length <= 1) return flash("chat needs a note")
    setThread({ ...t, chips: t.chips.slice(0, -1) })
  }
  const pillClear = () => patch({ input: "", pick: null })

  /** `↑` on an empty input with no card: the thread's last question. */
  const pillRecall = () => {
    const p = ui.current.pill
    const last = p && ui.current.threads[p.path]?.turns.at(-1)
    if (p && !p.card && !p.input && last) setInput(last.q)
  }

  return { pillType, pillErase, pillClear, pillRecall, setInput }
}

/** `esc`: the `[[` list, then a running answer, then the card, then the pill; hiding keeps the thread. */
function makePillEsc(c: AppCtx, { cancelJob }: Pick<Jobs, "cancelJob">, setInput: (input: string) => void) {
  const { ui, set } = c
  const { patch, setThread } = pillState(c)
  const pillHide = () => {
    if (ui.current.pill) set({ pill: null })
  }

  /** Cancel thread `path`'s running answer: its exchange removed, its question back in the input; false when none runs. */
  const cancel = (path: string) => {
    const t = ui.current.threads[path]
    if (!t || !cancelJob(jobKey("chat", path))) return false
    const gone = t.turns.at(-1)
    const turns = t.turns.slice(0, -1)
    setThread({ ...t, turns })
    patch({ input: gone?.q ?? "", card: turns.length > 0, hl: null, top: null })
    return true
  }

  const pillEsc = () => {
    const p = ui.current.pill
    if (!p) return
    if (p.pick) return setInput(dropPick(p.input))
    if (cancel(p.path)) return
    if (p.card) return patch({ card: false })
    pillHide()
  }
  return { pillEsc, pillHide }
}

/** A new workspace: every thread dropped, each running answer cancelled, the pill hidden. */
export function dropChat(c: AppCtx) {
  const { cancelJob } = makeJobs(c)
  for (const key of [...c.jobs.current.keys()]) if (key.startsWith(jobKey("chat", ""))) cancelJob(key)
  c.chatInk.current.clear()
  c.set({ threads: {}, pill: null })
}

/** A chip's note as a send read it. */
type SentNote = { chip: Chip; src: string }

/** The toast an ended request gets (spec §3): a success only off its note; a failure only with no card on screen. */
export function answerToast(ok: boolean, here: boolean, cardUp: boolean): "ready" | "failed" | null {
  if (ok) return here ? null : "ready"
  return cardUp ? null : "failed"
}

/** A finished reply as the exchange shows it: its marks verified against the notes as sent. */
export function doneExchange(ex: Exchange, text: string, notes: readonly SentNote[], now: number): Exchange {
  const { body, sources } = splitReply(text)
  const v = verifyCites(bodyParts(body), parseSources(sources), notes)
  return { ...ex, raw: text, parts: v.parts, cites: v.cites, doneAt: now }
}

/** Where a request's end lands: its thread, the exchange, the notes as sent and the target. */
type Sent = { path: string; ex: Exchange; notes: SentNote[]; target: AITarget }

/** A request's end: the exchange replaced in its thread (kept whatever is on screen), and the toast when §3 wants one. */
function makePillDone(c: AppCtx, { failText }: Pick<Jobs, "failText">, animate: () => void) {
  const { ui, derive, flash } = c
  const { patch, setThread } = pillState(c)

  /** Exchange `ex` of thread `path` becomes `next`; false when the thread or the exchange is gone. */
  const replace = (path: string, ex: Exchange, next: Exchange) => {
    const t = ui.current.threads[path]
    if (!t?.turns.includes(ex)) return false
    setThread({ ...t, turns: t.turns.map((e) => (e === ex ? next : e)) })
    return true
  }

  /** The toast `ok` gets for thread `path`, and the note's stem when it is not the open one. */
  const toastFor = (path: string, ok: boolean) => {
    const here = ui.current.openPath === path
    const p = ui.current.pill
    const cardUp = p?.path === path && p.card && derive().pill !== null
    return { toast: answerToast(ok, here, cardUp), note: here ? undefined : stem(basename(path)) }
  }

  /** The answer: its marks verified, its first cite selected while its thread is on the pill. */
  const answered = ({ path, ex, notes }: Sent, text: string) => {
    const { toast, note } = toastFor(path, true)
    const done = doneExchange(ex, text, notes, Date.now())
    const i = ui.current.threads[path]?.turns.indexOf(ex) ?? -1
    if (!replace(path, ex, done)) return
    if (ui.current.pill?.path === path) patch({ hl: done.cites.length ? [i, 1] : null })
    if (toast) flash(`answer ready · ${note}`)
  }

  /** The failure: kept on the exchange (the card's `✗` row); a toast only with no card on screen. */
  const failed = ({ path, ex, target }: Sent, f: Failure) => {
    const { toast, note } = toastFor(path, false)
    const error = aiMessage(f, { host: target.host, keyEnv: target.keyEnv, key: target.key, noun: "answer" })
    if (!replace(path, ex, { ...ex, error })) return
    if (toast) flash(failText(target, f, "answer", note), "error")
  }

  /** `done` of a chat job; a cancelled one changes nothing (`esc` already took its exchange). */
  return (sent: Sent, r: ChatResult) => {
    if (r.ok) answered(sent, r.text)
    else if ("failure" in r) failed(sent, r.failure)
    else return
    animate()
  }
}

/** `⏎`: send the question, or retry a failed one; the request's end lands in its thread. */
function makePillSend(c: AppCtx, jobs: Jobs, animate: () => void, citeGo: (at?: [number, number] | null) => void) {
  const { ui, memo, flash, chatInk } = c
  const { reloadAI, aiGate, startJob } = jobs
  const { patch, setThread } = pillState(c)
  const finish = makePillDone(c, jobs, animate)

  /** The target for a send on thread `path`: AI on, no request of its own running, room and a key; else null. */
  const gate = (path: string): AITarget | null => {
    const ai = reloadAI()
    if (!ai) {
      flash(AI_OFF)
      return null
    }
    if (c.jobs.current.has(jobKey("chat", path))) return null
    return aiGate(ai)
  }

  /** The chips' notes read now (an edit between turns is picked up); a gone one is left out with a toast. */
  const readChips = (t: Thread): SentNote[] =>
    t.chips.flatMap((chip) => {
      const f = memo.readNow(chip.path)
      if (!f.error) return [{ chip, src: f.src }]
      flash(`${chip.title} gone · left out`)
      return []
    })

  /** The new exchange in its thread (failed ones dropped: a retry replaces, a follow-up drops), the card up and pinned. */
  const push = (t: Thread, chips: Chip[], ex: Exchange) => {
    setThread({ ...t, chips, turns: [...t.turns.filter((e) => !e.error), ex] })
    patch({ input: "", card: true, top: null, hl: null, pick: null })
    chatInk.current.set(t.path, [])
  }

  /** Send `q` for the pill's thread `path`. */
  const ask = (path: string, q: string) => {
    const t = ui.current.threads[path]
    const target = t && gate(path)
    if (!t || !target) return
    const notes = readChips(t)
    if (!notes.length) return flash("nothing to ask about")
    const chips = notes.map((n) => n.chip)
    const done = t.turns.filter((e) => !e.error)
    const ctx = chatContext(
      notes.map((n) => noteText(n.src)),
      chips,
      done,
      q,
      target.maxChars,
    )
    const model = shortModel(target.model)
    const ex: Exchange = { q, at: Date.now(), model, raw: null, parts: [], cites: [], error: null, doneAt: null }
    push(t, chips, ex)
    startJob("chat", path, target, chatRequest(ctx, q), {
      stream: true,
      delta: (raw) => {
        chatInk.current.get(path)?.push({ len: cleanReply(raw).length, at: Date.now() })
        animate()
      },
      done: (r) => finish({ path, ex, notes, target }, r),
    })
    animate()
  }

  /** `⏎`: the `[[` list adds; text sends; empty, with the card up: retry a failed last exchange, else go to the selected mark. */
  const pillSend = (pickAdd: () => void) => {
    const p = ui.current.pill
    if (!p) return
    if (p.pick) return pickAdd()
    const q = p.input.trim()
    if (q) return ask(p.path, q)
    if (!p.card) return // the input stage: nothing to send, and its footer says send
    const last = ui.current.threads[p.path]?.turns.at(-1)
    if (last?.error) return ask(p.path, last.q)
    if (p.hl) citeGo(p.hl)
  }

  return { pillSend }
}

/** The pill: every action behind `c` and the `chat` mode. */
export function makePill(c: AppCtx, links: Pick<Links, "ensureLinks">) {
  const jobs = makeJobs(c)
  const animate = () => {} // the pill's animation timer comes later
  const input = makePillInput(c, links)
  const none = () => {}
  const citeGo = none as (at?: [number, number] | null) => void // landing on a cite comes later
  const pickAdd = none // the `[[` list's add comes later
  const { pillSend } = makePillSend(c, jobs, animate, citeGo)
  return {
    ...makePillOpen(c, jobs, animate),
    ...input,
    ...makePillEsc(c, jobs, input.setInput),
    /** `↑↓`: recall for now; the card's marks come later */
    pillMove: (dir: 1 | -1) => {
      if (dir < 0) input.pillRecall()
    },
    pillSend: () => pillSend(pickAdd),
    pillScroll: none as (dir: 1 | -1) => void,
    pickAdd,
    citeGo,
    citeStep: (_dir: 1 | -1) => false,
    /** the pointer moved onto a cite row of the card: it is selected */
    pillHover: (at: [number, number]) => pillState(c).patch({ hl: at }),
  }
}

/** The pill has the keys and is on screen: a press outside it, its card and its list does nothing. */
const pillHolds = (c: Pick<AppCtx, "ui" | "derive">) => !!c.ui.current.pill?.focus && c.derive().pill !== null

/** Press handler `f`, ignored while the pill holds the keys (the panel, the document and the minimap, spec §11.14). */
export const pressOutside =
  <E>(c: Pick<AppCtx, "ui" | "derive">, f: (e: E) => void) =>
  (e: E) => {
    if (!pillHolds(c)) f(e)
  }
export type Pill = ReturnType<typeof makePill>
