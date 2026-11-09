// The chat pill's derive step and its memo builders: the thread on screen, its running answer, what ⏎ would send, the
// card's rows, the `[[` list and the folded cite's quote. Reads notes only through `readNote` (the piped document from
// the prop, the 5 MB cap) and the memo. Every memo takes primitives or objects that hold across renders, so each holds
// while nothing changed: path lists are `\0`-joined, the card's view is one memoized object.
import { basename } from "node:path"
import { cleanReply, noteText, shortModel } from "../../ai/client"
import { type AIConfig, maxCharsOf } from "../../ai/config"
import { quoteNeedle } from "../../ai/delta"
import { bodyParts, type Cite, chatContext, citeSection, citeWhere, splitReply, type Thread } from "../../ai/thread"
import type { Rendered } from "../../markdown/render"
import { type DocFile, readNote } from "../../notes/doc"
import { type FileNode, rankNotes, stem } from "../../notes/files"
import type { VaultIndex } from "../../notes/vault"
import type { Theme } from "../../theme/theme"
import { waitSecs } from "../../ui/footnote"
import type { layout } from "../../ui/layout"
import { cached } from "../../ui/nav"
import {
  type Arrival,
  cardRows,
  chatStage,
  citeSpot,
  PICK_ROWS,
  type PickItem,
  type PillView,
  pillGeo,
  type Running,
} from "../../ui/pill"
import type { Memo } from "../derive"
import { type Job, jobKey, type UI } from "../store"

/** `\0` joins a path list into one memo key. */
const SEP = "\0"
const paths = (key: string) => (key ? key.split(SEP) : [])
/** One empty arrival log for every thread without one, so the running memo holds. */
const NO_ARRIVALS: readonly Arrival[] = []

/** The chat's memo builders (spread into `makeMemo`); `stdin` is the piped document. */
export function chatMemo(stdin: string | undefined) {
  const read = (path: string, nonce: number) => readNote(path, nonce, stdin)
  return {
    /** a fresh read, for a send: notes edited between turns are picked up */
    readNow: (path: string) => read(path, 0),
    /** the chips' notes (`\0`-joined paths), read once per chip list and reload */
    chatRead: cached((chips: string, reload: number) => paths(chips).map((p) => read(p, reload))),
    chatMax: cached((ai: AIConfig | null) => (ai ? maxCharsOf(ai) : 0)),
    chatSize: cached((thread: Thread, files: readonly DocFile[], input: string, max: number) => {
      const ctx = chatContext(
        files.map((f) => noteText(f.src)),
        thread.chips,
        thread.turns,
        input,
        max,
      )
      return { size: ctx.size, clipped: ctx.notes.filter((n) => n.clipped).map((n) => n.chip.path) }
    }),
    chatRunning: cached(
      (raw: string, at: number, live: boolean, model: string, secs: number, n: number, log: readonly Arrival[]) =>
        ({
          parts: bodyParts(splitReply(cleanReply(raw), true).body),
          arrivals: log.slice(0, n),
          at,
          live,
          model: shortModel(model),
          secs,
        }) satisfies Running,
    ),
    chatWheres: cached((thread: Thread, reload: number) =>
      thread.turns.map((e) => e.cites.map((k) => whereOf(thread, k, read(k.path, reload).src))),
    ),
    /** the card's view, one object per running answer, selection and wheres, so `card` holds */
    cardView: cached(
      (running: Running | null, hl: [number, number] | null, wheres: readonly (readonly string[])[]) => ({
        running,
        hl,
        wheres,
      }),
    ),
    card: cached(cardRows),
    pickItems: cached(pickList),
    /** where cite `cite` is in `view` of its note `src`: its section's first row and its quote (`citeSpot`) */
    citeSpot: cached((view: Rendered, source: boolean, src: string, cite: Cite) =>
      citeSpot(view, source, citeSection(src, cite.line).index, cite.line, quoteNeedle(cite.quote, source)),
    ),
  }
}

const titleOf = (thread: Thread, path: string) =>
  thread.chips.find((c) => c.path === path)?.title ?? stem(basename(path))
const whereOf = (thread: Thread, k: Cite, src: string) => citeWhere(k, thread.path, src, titleOf(thread, k.path))

/**
 * The `[[` list: notes matching `q` (aliases from the index), else the notes linked from here; never a chip already
 * there. `linked` and `chips` are `\0`-joined paths.
 */
function pickList(tree: FileNode, q: string, ix: VaultIndex, linked: string, chips: string): PickItem[] {
  const from = paths(linked)
  const taken = paths(chips)
  const aliases = (n: FileNode) => ix.docs.get(n.path)?.aliases ?? []
  const nodes = q.trim()
    ? rankNotes(tree, q, PICK_ROWS + taken.length, aliases).rows.map((r) => r.node)
    : from.map((p) => ({ path: p, name: basename(p) }))
  return nodes
    .filter((n) => !taken.includes(n.path))
    .slice(0, PICK_ROWS)
    .map((n) => ({ path: n.path, name: stem(n.name), linked: from.includes(n.path) }))
}

type PillLayout = Pick<ReturnType<typeof layout>, "CW" | "CH" | "zen" | "mode" | "shown">
/** The open note as `noteView` read and rendered it. */
interface Opened {
  file: DocFile | null
  view: Rendered
  fm: { body: string }
}
interface PillRefs {
  jobs: Map<string, Job>
  chatInk: Map<string, Arrival[]>
  ix: VaultIndex
}

/**
 * Whether the pill shows: it is open with its thread, on a note that reads (an unreadable one draws its error, not the
 * lines the pill sits on), outside zen, and not behind the open drawer. `scrollState` asks it before the view is built.
 */
export function pillShown(s: UI, L: PillLayout, file: DocFile | null): boolean {
  const p = s.pill
  if (!p || !s.threads[p.path] || !s.openPath || file?.error) return false
  return !L.zen && !(L.mode === "drawer" && L.shown)
}

/** The running exchange's answer so far, or null. */
function runningOf(memo: Memo, job: Job | undefined, log: readonly Arrival[], now: number): Running | null {
  return job ? memo.chatRunning(job.raw, job.at, job.live, job.model, waitSecs(now, job.at), log.length, log) : null
}

/** What `⏎` would send, its size and clipped chips, and where each cite is. */
function sentOf(s: UI, memo: Memo, thread: Thread, input: string) {
  const files = memo.chatRead(thread.chips.map((c) => c.path).join(SEP), s.reload)
  return { ...memo.chatSize(thread, files, input, memo.chatMax(s.ai)), wheres: memo.chatWheres(thread, s.reload) }
}

/**
 * The pill on screen: null while hidden, in zen, on the welcome page, on a note that can't be read, with the drawer
 * open, or without its thread. `now` keys the card's ink only with motion on.
 */
export function pillView(
  s: UI,
  L: PillLayout,
  opened: Opened,
  memo: Memo,
  refs: PillRefs,
  t: Theme,
  now: number,
): PillView | null {
  const p = s.pill
  const thread = p && s.threads[p.path]
  if (!p || !thread || !pillShown(s, L, opened.file)) return null
  const running = runningOf(memo, refs.jobs.get(jobKey("chat", p.path)), refs.chatInk.get(p.path) ?? NO_ARRIVALS, now)
  const sent = sentOf(s, memo, thread, p.input)
  const base = { ...p, thread, running, geo: pillGeo(L), ...sent }
  const pick = p.pick && { ...p.pick, items: pickFor(s, memo, opened, refs.ix, thread, p.pick.q) }
  const stage = chatStage({ pick, running, card: p.card, thread })
  const view = memo.cardView(running, p.hl, sent.wheres)
  const cardOut = p.card ? memo.card(t, thread, view, base.geo.w - 4, s.motion ? now : 0, s.motion) : null
  return { ...base, pick, stage, cardOut, quote: quoteFor(s, memo, opened.view, thread) }
}

/** The `[[` list's notes for `q`: what the open note links to marks them. */
function pickFor(s: UI, memo: Memo, opened: Opened, ix: VaultIndex, thread: Thread, q: string) {
  const refs = memo.links(memo.linkTargets(opened.fm.body), s.linkTree, s.openPath)
  const linked = [...new Set(refs.flatMap((l) => (l.path ? [l.path] : [])))]
  return memo.pickItems(s.linkTree, q, ix, linked.join(SEP), thread.chips.map((c) => c.path).join(SEP))
}

/**
 * The folded cite's quote in the view on screen; null when it isn't folded here. Only for a cite in the open note:
 * `memo.read` holds one entry, the open note's (`citeGo` opens the cite's note before it folds).
 */
function quoteFor(s: UI, memo: Memo, view: Rendered, thread: Thread) {
  const land = s.pill?.land
  const cite = land ? thread.turns[land.exchange]?.cites.find((k) => k.n === land.n) : null
  if (!cite || cite.path !== s.openPath) return null
  return memo.citeSpot(view, s.source, memo.read(cite.path, s.reload).src, cite).quote
}
