// The `C-p` switcher in the app: its query and highlight, ask (`?` questions, tier 0) and rerank (tier 1), the vault
// index it searches, opening what a row points at, and the peek pane's data. Not pure: `makeSwitcher` closes over the
// app context.
import { relative } from "node:path"
import { shortModel, type Failure } from "../ai/client"
import { ASK_MEMO, ASK_MIN, RERANK_MEMO, askLocate, askRequest, parseQueries, parseRerank, putNewest, questionOf, rerankRequest, type AskState } from "../ai/ask"
import { folderCounts } from "../notes/files"
import { keepHitVisible } from "../ui/nav"
import { peekLines, peekWindow, switchSplit } from "../notes/peek"
import { PEEK_MIN_W } from "../ui/geometry"
import { errText } from "../ui/status"
import { isFresh, textHash } from "../ai/cache"
import { emptyIndex, firstHit, foldSame, fsIO, hitOrdinal, indexNote, refreshIndex, type AnswerRow, type NoteDoc, type SwitchRow, type TextHit } from "../notes/vault"
import { AI_OFF, makeJobs } from "./ai-jobs"
import type { AppCtx } from "./ctx"
import type { Derived } from "./derive"
import type { Links } from "./links"
import { jobKey } from "./store"

/** The switcher over the app context; opening it scans a piped document's folder first (`ensureLinks`). */
export function makeSwitcher(c: AppCtx, { ensureLinks }: Pick<Links, "ensureLinks">) {
  const { ui, set, derive, memo, W, vault, askMemo, rerankMemo, flash, openFile, focusDoc, setTop, showMatch } = c
  const { reloadAI, cancelJob, aiGate, failText, startJob } = makeJobs(c)

  /** Abort a running ask (tier 0 or 1): nobody would see its result. */
  const dropAsk = () => void cancelJob(jobKey("ask"))

  const closeSwitcher = () => {
    dropAsk()
    set({ switcher: null })
  }

  /** New query: the highlight goes back to the first hit; a changed query drops the answers and aborts their request. */
  const swType = (q: string) => {
    if (ui.current.switcher?.q !== q) dropAsk()
    ui.current.switcher = { q, hl: 0, top: 0 } // unbumped: only for `derive` below
    set({ switcher: { q, hl: Math.max(0, firstHit(derive().swRows)), top: 0 } })
  }

  /** New ask state for the open switcher; the highlight goes to its first stop. */
  const setAsk = (ask: AskState | undefined) => {
    const sw = ui.current.switcher
    if (!sw) return
    const next = (ui.current.switcher = { ...sw, ask, hl: 0, top: 0 }) // unbumped: only for `derive` below
    set({ switcher: { ...next, hl: Math.max(0, firstHit(derive().swRows)) } })
  }

  /**
   * `⏎` on the ask row (tier 0): only the question goes out; the model's queries come back and
   * the answers are sections the local index finds for them. Applied only to the same query string.
   */
  const askStart = () => {
    const sw = ui.current.switcher
    const qn = sw ? questionOf(sw.q) : null
    if (!sw || !qn || [...qn.text].length < ASK_MIN) return
    const ai = reloadAI()
    if (!ai) return flash(AI_OFF)
    dropAsk() // at most one ask
    const question = qn.text
    const known = askMemo.current.get(foldSame(question))
    if (known) return setAsk({ question, phase: "result", queries: known.queries, model: known.model })
    const target = aiGate(ai, (busy) => setAsk({ question, phase: "error", error: busy }))
    if (!target) return
    const asked = sw.q
    // an edit, a close or another ask aborts the job, so `done` never runs for it
    startJob("ask", undefined, target, askRequest(question), {
      begin: () => setAsk({ question, phase: "asking" }),
      done: (r) => {
        if (ui.current.switcher?.q !== asked) return
        const queries = r.ok ? parseQueries(r.raw) : null
        if (queries) {
          putNewest(askMemo.current, foldSame(question), { queries, model: ai.model }, ASK_MEMO)
          return setAsk({ question, phase: "result", queries, model: ai.model })
        }
        let f: Failure
        if (r.ok) f = { kind: "invalid" }
        else if ("failure" in r) f = r.failure
        else return
        const msg = failText(target, f, "answer")
        flash(msg, "error")
        setAsk({ question, phase: "error", error: msg })
      },
    })
  }

  /**
   * `⏎` on the rerank row (tier 1): the question and the candidates' excerpts go out; the model
   * only orders ids it was sent. Applied only to the same query and the same candidate list.
   */
  const askRerank = () => {
    const sw = ui.current.switcher
    const st = sw?.ask
    if (!sw || !st || (st.phase !== "result" && st.phase !== "reranked")) return
    const { askCands } = derive()
    const ids = askCands.map((c) => c.id)
    const req = rerankRequest(st.question, askCands, vault.current.ix)
    // keyed on exactly what would be sent, so an edited candidate is asked again
    const memoKey = `${textHash(ids.join("\n"))}\n${textHash(req.user)}`
    const known = rerankMemo.current.get(memoKey)
    if (known) return setAsk({ ...st, phase: "reranked", order: known.order, why: known.why })
    const ai = reloadAI()
    if (!ai) return flash(AI_OFF)
    dropAsk()
    const target = aiGate(ai)
    if (!target) return
    const asked = sw.q
    startJob("ask", undefined, target, req, {
      begin: () => setAsk({ ...st, phase: "reranking" }),
      done: (r) => {
        const now = ui.current.switcher
        if (now?.q !== asked || !now.ask) return
        const back: AskState = { ...now.ask, phase: "result" }
        // the index changed under the request: these ids are no longer the list on screen
        if (derive().askCands.map((c) => c.id).join("\n") !== ids.join("\n")) return setAsk(back)
        if (!r.ok) {
          setAsk(back)
          if ("failure" in r) flash(failText(target, r.failure, "answer"), "error")
          return
        }
        const picked = parseRerank(r.raw, ids.length)
        if (!picked) {
          setAsk(back)
          return flash("AI: no usable ranking")
        }
        const order = picked.map((p) => ids[p.i]!)
        const why = Object.fromEntries(picked.map((p) => [ids[p.i], p.why]))
        putNewest(rerankMemo.current, memoKey, { order, why, model: ai.model }, RERANK_MEMO)
        setAsk({ ...now.ask, phase: "reranked", order, why })
      },
    })
  }

  /** Highlight row `hl`, scrolling so it (and its section title, when it is the first hit) stays in view. */
  const swGo = (hl: number) => {
    const sw = ui.current.switcher
    if (!sw) return
    const { swRows, L } = derive()
    set({ switcher: { ...sw, hl, top: keepHitVisible(sw.top, swRows, hl, L.PH) } })
  }

  /** Bring the vault index up to date (one build at a time); progress re-runs the search. */
  const indexVault = () => {
    const v = vault.current
    if (v.running) return
    v.running = true
    const live = () => vault.current === v
    const tree = ui.current.linkTree
    set({ indexing: [0, folderCounts(tree).get(tree.path) ?? 0] })
    refreshIndex(v.ix, tree, fsIO, (done, total) => live() && set({ indexing: [done, total], ixVer: ui.current.ixVer + 1 }), live)
      .catch((e) => live() && flash(`index failed · ${errText(e)}`, "error")) // a throwing note scan or progress callback; unreadable files never get here
      .finally(() => {
        v.running = false
        if (live()) set({ indexing: null, ixVer: ui.current.ixVer + 1 })
      })
  }

  /** Forget the index: a running build sees it is stale and stops. */
  const dropIndex = () => {
    vault.current = { ix: emptyIndex(), running: false }
    set({ indexing: null, ixVer: ui.current.ixVer + 1 })
  }

  const openSwitcher = () => {
    ensureLinks()
    set({ labels: null })
    swType("")
    indexVault()
  }

  /**
   * Select `q`'s occurrence for text hit `row` in the open note: in Source from its source row; in
   * Preview by counting matches from the start of its section (`hitOrdinal` on `doc`).
   */
  const jumpToText = (row: TextHit, q: string, doc: NoteDoc | undefined) => {
    set({ query: q, matchLine: null })
    const { view, matches, s } = derive()
    const from = s.source ? (view.srcRow?.[row.line] ?? 0) : row.heading === null ? 0 : (view.headings[row.heading]?.line ?? 0)
    const end = s.source ? Infinity : (view.headings[row.heading === null ? 0 : row.heading + 1]?.line ?? Infinity)
    const inSection = matches.filter((x) => x >= from && x < end)
    const k = s.source || !doc ? 0 : hitOrdinal(doc, row, q)
    const m = inSection[Math.min(k, inSection.length - 1)] ?? matches.find((x) => x >= from)
    if (m !== undefined) return showMatch(m)
    setTop(from)
    flash(s.source ? `no match for “${q}”` : `“${q}” is not in the preview · s shows the source`, "error")
  }

  /** Open what row `row` points at: the note, its heading, or its first match in the hit's section. */
  const switchTo = (row: SwitchRow | undefined) => {
    if (!row || (row.kind !== "note" && row.kind !== "heading" && row.kind !== "text")) return
    const q = ui.current.switcher?.q.trim() ?? ""
    closeSwitcher()
    openFile(row.path)
    focusDoc()
    if (row.kind === "note") return
    if (row.kind === "heading") {
      const h = derive().view.headings[row.heading]
      return h ? setTop(h.line) : flash(`no heading “${row.text}”`)
    }
    jumpToText(row, q, vault.current.ix.docs.get(row.path))
  }

  /**
   * Open an Ask answer. The note may have changed since it was indexed: its section is found again
   * by heading key and occurrence, then the first line there holding the answer's query (find
   * highlights it); with no such line, the heading; with the heading gone, the note as it was left.
   */
  const answerTo = (row: AnswerRow) => {
    closeSwitcher()
    openFile(row.path)
    focusDoc()
    const { file } = derive()
    if (!file || file.error) return // the read error is on screen
    const doc = indexNote(file.src, 0, Buffer.byteLength(file.src))
    const at = askLocate(doc, row)
    if (!at) return flash("heading gone")
    const heading = at.heading < 0 ? null : at.heading
    if (at.line !== null)
      return jumpToText({ kind: "text", path: row.path, name: row.name, folder: "", heading, line: at.line, context: "", hits: [] }, row.query, doc)
    if (heading === null) return
    const h = derive().view.headings[heading]
    return h ? setTop(h.line) : flash("heading gone")
  }

  /** `⏎` or a click on row `i`: in ask mode it asks, or opens an answer; otherwise the hit opens. */
  const swActivate = (i: number) => {
    const { swRows, question } = derive()
    const row = swRows[i]
    if (!question) return switchTo(row)
    if (row?.kind === "answer") return answerTo(row)
    if (row?.kind === "askAction") return row.act === "ask" ? askStart() : askRerank()
    if (!ui.current.switcher?.ask) askStart() // AI off or no key: re-read the config and say why
  }

  /** The peek pane (from PEEK_MIN_W): the highlighted row's note, its TL;DR only while fresh; undefined without one. */
  const peekPane = ({ s, swRows, swHl, t, L }: Derived) => {
    if (!s.switcher || W < PEEK_MIN_W) return undefined
    const peekRow = swRows[swHl]
    const peekPath = peekRow && "path" in peekRow ? peekRow.path : null
    const peekDoc = peekPath ? vault.current.ix.docs.get(peekPath) : undefined
    const peekW = switchSplit(W).peekW
    const peekNote = peekPath && peekDoc ? memo.peekFile(peekPath, peekDoc.mtime) : null
    const peekWin = peekNote && peekDoc && peekRow ? peekWindow(peekNote.lines, peekNote.fm, peekDoc, peekRow) : null
    const peekView = peekNote && peekWin ? memo.peek(peekNote.lines, peekWin.from, peekWin.to, peekW, t, s.linkTree, s.headingStyle) : undefined
    const peekSaved = peekPath ? s.summaries[peekPath] : undefined
    return peekLines(
      {
        row: peekRow,
        rel: peekPath ? relative(s.linkTree.path, peekPath) : "",
        doc: peekDoc,
        view: peekView,
        base: peekWin?.base,
        words: peekNote?.words,
        minutes: peekNote?.minutes,
        summary: peekSaved && peekNote && isFresh(peekSaved, peekNote.hash) ? { text: peekSaved.summary, model: shortModel(peekSaved.model) } : undefined,
      },
      t,
      peekW,
      L.PH,
    )
  }

  return { dropAsk, closeSwitcher, swType, swGo, dropIndex, openSwitcher, swActivate, peekPane }
}
/** What `makeSwitcher` gives App and the other factories. */
export type SwitcherControl = ReturnType<typeof makeSwitcher>
