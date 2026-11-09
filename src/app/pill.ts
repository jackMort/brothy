// The chat pill: `c`, its input and `[[` chips, sending a question about the open note, cancelling, the card's marks,
// folding onto a cite and stepping through the cites, and the one animation timer. Not pure: closes over the app context.
import { basename } from "node:path"
import { noteText } from "../ai/client"
import type { Chip, Thread } from "../ai/thread"
import { stem } from "../notes/files"
import { STDIN } from "../notes/workspace"
import { AI_OFF, type Jobs, makeJobs } from "./ai-jobs"
import type { AppCtx } from "./ctx"
import { erase } from "./input"
import type { Links } from "./links"
import type { PillState } from "./store"

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

  /** The pill on `path`'s thread (made with the open note's chip when new): the card up when it has exchanges. */
  const show = (path: string) => {
    const d = derive()
    if (d.L.mode === "drawer" && d.L.shown) focusDoc()
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
    if (path) show(path)
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

/** `esc` without a request: the `[[` list, then the card, then the pill; hiding keeps the thread. */
function makePillEsc(c: AppCtx, setInput: (input: string) => void) {
  const { ui, set } = c
  const { patch } = pillState(c)
  const pillHide = () => {
    if (ui.current.pill) set({ pill: null })
  }
  const pillEsc = () => {
    const p = ui.current.pill
    if (!p) return
    if (p.pick) return setInput(dropPick(p.input))
    if (p.card) return patch({ card: false })
    pillHide()
  }
  return { pillEsc, pillHide }
}

/** The pill: every action behind `c` and the `chat` mode. */
export function makePill(c: AppCtx, links: Pick<Links, "ensureLinks">) {
  const jobs = makeJobs(c)
  const animate = () => {} // the pill's animation timer comes later
  const input = makePillInput(c, links)
  const none = () => {}
  return {
    ...makePillOpen(c, jobs, animate),
    ...input,
    ...makePillEsc(c, input.setInput),
    /** `↑↓`: recall for now; the card's marks come later */
    pillMove: (dir: 1 | -1) => {
      if (dir < 0) input.pillRecall()
    },
    pillSend: none,
    pillScroll: none as (dir: 1 | -1) => void,
    pickAdd: none,
    citeGo: none as (at?: [number, number] | null) => void,
    citeStep: (_dir: 1 | -1) => false,
    pillHover: none as (at: [number, number]) => void,
  }
}
export type Pill = ReturnType<typeof makePill>
