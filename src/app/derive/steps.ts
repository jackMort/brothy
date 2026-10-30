// The steps of `derive()`, one per area, in the order it runs them: each reads the store and the memo and returns its slice.
// Not pure: `filesCursor`, `scrollState` and `matchState` write back the Files cursor, the scroll entry and the match line.

import { type AskView, askStage, questionOf } from "../../ai/ask"
import type { Summary } from "../../ai/cache"
import { shortModel } from "../../ai/client"
import { type GlossStyle, PROMPT_V, PROMPTS } from "../../ai/config"
import { type Change, hhmm } from "../../ai/delta"
import { GLOSS_ROWS, type GlossTarget, type GlossView, overflows, parseGlossStyle } from "../../ai/gloss"
import { plural, wrap } from "../../lib/text"
import type { Rendered } from "../../markdown/render"
import { folderCounts, SCAN_LIMIT } from "../../notes/files"
import { switchSplit } from "../../notes/peek"
import type { OpenRow } from "../../notes/projects"
import { firstHit, isStop, type SwitchRow, type VaultIndex } from "../../notes/vault"
import { projectRoot } from "../../notes/workspace"
import type { Theme } from "../../theme/theme"
import { SIDENOTE_ROWS, SIDENOTE_W, sidenoteAt, staleKind, waitSecs } from "../../ui/footnote"
import { ROW_PAD } from "../../ui/geometry"
import type { layout } from "../../ui/layout"
import { relocate, remapTop } from "../../ui/nav"
import type { ChangeView, SummaryView } from "../../ui/panel"
import { noteTitle } from "../../ui/status"
import { pageSlice, sectionAt, typewriterTop } from "../../ui/zen"
import type { DeriveRefs, Memo, ScrollEntry } from "../derive"
import { type FileRow, type Job, jobKey, NO_CANDS, NO_CHANGES, NO_NOTES, type UI } from "../store"

/** The screen layout `derive()` works at. */
type Layout = ReturnType<typeof layout>

// ------------------------------------------------------------- document

/** The open note: its file, front matter, Preview, the view on screen (Preview or Source) and its stats. */
export function noteView(s: UI, L: Layout, t: Theme, memo: Memo) {
  const file = s.openPath ? memo.read(s.openPath, s.reload) : null
  const src = file?.src ?? ""
  const fm = memo.fm(src)
  const doc = memo.doc(fm.body, L.CW, t, s.hl, s.linkTree, s.headingStyle)
  const view = s.source ? memo.source(src, L.CW, t, s.linkTree) : doc
  const st = memo.stats(fm.body)
  return { file, src, fm, doc, view, st }
}
/** What `noteView` returns. */
type NoteView = ReturnType<typeof noteView>

// ------------------------------------------------------------- panel

/** The Files list: ranked hits while filtering (`total` of them), else the tree's visible rows. */
export function filesList(s: UI, memo: Memo) {
  const filtered = s.filter.trim() !== ""
  const ranked = filtered ? memo.rank(s.tree, s.filter) : null
  const rows: FileRow[] = ranked ? ranked.rows : memo.rows(s.tree, s.expanded)
  const total = ranked?.total ?? 0
  return { filtered, rows, total }
}

/** The truncation note Files pins under its list, wrapped to the panel. */
export function truncationNote(s: UI, L: Layout) {
  // panel: strip and rule rows, then the view's list; Files pins the truncation note under it
  return s.view === "files" && s.tree.truncated
    ? wrap([{ text: `scan stopped at ${SCAN_LIMIT / 1000}k entries — some notes missing` }], L.PNW - 2).map((r) =>
        r.map((x) => x.text).join(""),
      )
    : []
}

/** The TL;DR block: waiting or streaming, the cached summary (fresh or outdated), a failure, or none; null without an `ai` block or a readable note. */
function summaryView(s: UI, { file, src }: NoteView, memo: Memo, jobs: Map<string, Job>): SummaryView | null {
  if (!s.ai || !s.openPath || !file || file.error) return null
  const job = jobs.get(jobKey("tldr", s.openPath))
  const saved = s.summaries[s.openPath]
  return job ? runningSummary(job, saved, memo) : cachedSummary(s, s.openPath, saved, memo.hash(src), memo)
}

/** A request running for the open note: waiting (an older summary kept under the caret) or streaming. */
function runningSummary(job: Job, saved: Summary | undefined, memo: Memo): SummaryView {
  const text = memo.clean(job.raw)
  const model = shortModel(job.model)
  if (text) return memo.summary(text, "streaming", model, 0, null, "", null, false)
  return memo.summary("", "waiting", model, waitSecs(Date.now(), job.at), null, saved?.summary ?? "", null, false)
}

/** No request running: the cached summary for `path`, fresh or outdated, or none; and the last failure while the text is the one it failed on. */
function cachedSummary(s: UI, path: string, saved: Summary | undefined, hash: string, memo: Memo): SummaryView {
  const err = s.summaryErr[path]
  const error = err?.hash === hash ? err.msg : null
  if (!saved) return memo.summary("", "none", "", 0, null, "", error, false)
  const stale = staleKind(saved, hash, PROMPT_V)
  const model = shortModel(saved.model)
  return memo.summary(saved.summary, stale ? "outdated" : "fresh", model, 0, stale, "", error, s.tldrOpen)
}

/** The Changed block in Info, null while there is nothing to list or explain. */
function changeBlock(
  s: UI,
  base: UI["baseline"],
  changes: readonly Change[] | null,
  memo: Memo,
  jobs: Map<string, Job>,
): ChangeView | null {
  const dl = s.delta && s.delta.path === s.openPath ? s.delta : null
  // loading, else the reply while nothing changed since the explained text, else the idle list
  const explained = dl ? explanationBlock(dl, changes, memo, jobs) : null
  if (explained) return explained
  if (base && changes?.length) return { state: "idle", label: hhmm(base.at), changes, summary: "", notes: NO_NOTES }
  return null
}

/** `D`'s part of the Changed block: the reply streaming in, or the finished one while nothing changed since the explained text; else null. */
function explanationBlock(
  dl: NonNullable<UI["delta"]>,
  changes: readonly Change[] | null,
  memo: Memo,
  jobs: Map<string, Job>,
): ChangeView | null {
  const dJob = jobs.get(jobKey("delta", dl.path))
  if (dJob) {
    const live = memo.partial(dJob.raw, dl.changes)
    return {
      state: "loading",
      label: "",
      changes: dl.changes,
      summary: live?.summary ?? "",
      notes: live?.notes ?? NO_NOTES,
    }
  }
  // null: too large to compare, not unchanged
  if (dl.result && changes !== null && !changes.length)
    return {
      state: "result",
      label: dl.result.model,
      changes: dl.changes,
      summary: dl.result.summary,
      notes: dl.result.notes,
    }
  return null
}

/** A live reload's changes: the open note against the text it had when it opened (memory only), and the Changed block. */
function changeView(s: UI, { file, src, fm }: NoteView, memo: Memo, jobs: Map<string, Job>) {
  const base = s.baseline && s.baseline.path === s.openPath && file && !file.error ? s.baseline : null
  const after = memo.note(src)
  const propsKey = memo.propsKey(fm)
  const changes = base ? memo.diff(base.text, after) : NO_CHANGES
  const propsChanged = !!base && propsKey !== base.props
  const cv = changeBlock(s, base, changes, memo, jobs)
  return { changes, propsChanged, after, propsKey, cv }
}

/** The Info view: properties, title, the TL;DR and Changed blocks, its rows and the rows the cursor stops on. */
export function infoPanel(s: UI, L: Layout, opened: NoteView, memo: Memo, jobs: Map<string, Job>) {
  const { file, src, fm, st } = opened
  const props = memo.props(src)
  const links = memo.links(memo.linkTargets(fm.body), s.linkTree, s.openPath)
  // primitives into memo.info, never a fresh object, so the single-entry memo holds
  const sv = summaryView(s, opened, memo, jobs)
  const title = noteTitle(props, s.openPath ?? "")
  const delta = changeView(s, opened, memo, jobs)
  const { cv } = delta
  const infoRows = memo.info(
    props,
    st,
    links,
    L.PNW - 2,
    file?.info ?? null,
    sv,
    cv?.state ?? "",
    cv?.label ?? "",
    cv?.changes ?? NO_CHANGES,
    cv?.summary ?? "",
    cv?.notes ?? NO_NOTES,
    title,
  )
  const linkRows = memo.linkIdx(infoRows)
  return { props, title, ...delta, sv, infoRows, linkRows }
}

/** The panel list's height and its filter row; puts the Files cursor back on the same note when the list changes. */
export function filesCursor(
  s: UI,
  L: Layout,
  { rows, filtered }: ReturnType<typeof filesList>,
  noteRows: number,
  seen: DeriveRefs["sidebarSeen"]["current"],
) {
  const filterRow =
    (s.view === "files" && (s.filterTyping || s.filter !== "")) ||
    (s.view === "outline" && (s.filterTyping || s.outlineFilter !== ""))
  const LH = Math.max(1, L.bodyH - 2 - (filterRow ? 1 : 0) - noteRows)

  // when the Files list changes, put the cursor back on the same note
  if (rows !== seen.rows) {
    const paths = rows.map((r) => r.node.path)
    // filter results keep the cursor's note when it is still listed, else start on the top result
    const r = filtered
      ? relocate(paths, [seen.cursorPath], 0, 0, LH)
      : relocate(paths, [seen.cursorPath, s.openPath], s.cursor, s.listTop.files, LH)
    s.cursor = r.cursor
    s.listTop.files = r.sideTop
    seen.rows = rows
    seen.cursorPath = paths[s.cursor] ?? null
  }
  return { filterRow, LH }
}

// ------------------------------------------------------------- popups

/** The `C-p` switcher's rows (the ask's while the query is a question) and its highlight, always on a stop. */
export function switcherList(s: UI, memo: Memo, ix: VaultIndex, W: number, jobs: Map<string, Job>) {
  const question = s.switcher ? questionOf(s.switcher.q) : null
  const askState = s.switcher?.ask
  // ranking waits for a complete index, then re-runs whenever it changes (ixVer)
  const askCands =
    question && askState?.queries && !s.indexing ? memo.cands(ix, s.linkTree, s.ixVer, askState.queries) : NO_CANDS
  const askCost = question && askCands.length ? memo.cost(question.text, askCands, ix, s.ixVer) : ""
  let swRows: SwitchRow[] = []
  let askView: AskView | null = null
  if (s.switcher && question) {
    const job = jobs.get(jobKey("ask"))
    const split = switchSplit(W)
    const target = memo.host(s.ai)
    const indexing = s.indexing !== null
    const at = {
      secs: job ? waitSecs(Date.now(), job.at) : 0,
      notes: plural(folderCounts(s.linkTree).get(s.linkTree.path) ?? 0, "note"),
      width: split.listW - ROW_PAD,
      pane: split.split,
    }
    askView = {
      question: question.text,
      cut: question.cut,
      target,
      state: askState,
      cands: askCands,
      cost: askCost,
      indexing,
      ...at,
    }
    swRows = memo.ask(question.text, question.cut, target, askState, askCands, askCost, indexing, at)
  } else if (s.switcher) swRows = memo.switch(ix, s.linkTree, s.switcher.q, s.ixVer, s.recent, s.openPath)
  // the highlight always sits on a stop (results change under it while typing or indexing)
  const swAt = s.switcher ? swRows[s.switcher.hl] : undefined
  const swHl = s.switcher && swAt && isStop(swAt) ? s.switcher.hl : firstHit(swRows)
  return { question, askCands, swRows, swHl, askView, askStage: askView && askStage(askView) }
}

/** The `o` picker's rows and its highlight, never on a header. */
export function openerList(s: UI, memo: Memo) {
  const opRows: OpenRow[] = s.opener ? memo.open(s.opener.list, s.opener.q, s.root, projectRoot(s)) : []
  const opAt = s.opener ? opRows[s.opener.hl] : undefined
  const opHl = s.opener && opAt && opAt.kind !== "header" ? s.opener.hl : firstHit(opRows)
  return { opRows, opHl }
}

// ------------------------------------------------------------- reading position

/** The scroll entry for this note and view, remapped after a re-layout, and the top line clamped to `maxTop`. */
export function scrollState(s: UI, L: Layout, view: Rendered, memo: Memo, scrolls: Map<string, ScrollEntry>) {
  const scrollKey = `${s.openPath}:${s.source ? "source" : "preview"}`
  const geo = memo.geo(view)
  // typewriter: the scroll top *is* the reading line, so it may go down to the last line
  const tw = L.zen && s.zenCfg.flow === "scroll" && s.zenCfg.typewriter
  // pages: the scroll top is the page anchor (its section is the page), so it may be any line too
  const pages = L.zen && s.zenCfg.flow === "pages"
  const maxTop = tw || pages ? Math.max(0, view.lines.length - 1) : Math.max(0, view.lines.length - L.CH)
  const entry = scrolls.get(scrollKey)
  if (entry && entry.geo !== geo) {
    // re-laid out (resize, reload): keep the reading position
    entry.top = remapTop(entry.top, entry.geo, geo)
    entry.geo = geo
  }
  const top = Math.max(0, Math.min(entry?.top ?? 0, maxTop))
  return { scrollKey, geo, tw, pages, maxTop, top }
}

/** The find matches; keeps the same match index when a re-wrap moves every match line. */
export function matchState(s: UI, view: Rendered, memo: Memo, matchSeen: DeriveRefs["matchSeen"]) {
  const matches = memo.matches(view, s.query)
  // a re-wrap (w, resize, live reload) moves every match line: keep the same match index
  const prev = matchSeen.current
  if (prev.query === s.query && prev.matches !== matches && s.matchLine !== null) {
    const i = prev.matches.indexOf(s.matchLine)
    s.matchLine = matches[i] ?? null
  }
  matchSeen.current = { matches, query: s.query }
  return matches
}

// ------------------------------------------------------------- zen

/** No fresh glosses: a shared empty list, so the margin's memo holds. */
const NO_FRESH: { index: number; text: string }[] = []

/**
 * Zen gloss: the section under the reading line (`gHere`), its note (`sheet`, null when none), whether that note
 * overflows its collapsed rows, the margin's column from 140 columns (`margin`, null: the bottom sheet) and the other
 * sections with a fresh gloss (`others`, only for the margin).
 */
export function glossSheet(
  s: UI,
  L: Layout,
  { file, src }: NoteView,
  currentHeading: number,
  title: string,
  memo: Memo,
  jobs: Map<string, Job>,
) {
  // zen gloss: the section under the reading line (currentHeading is sectionOf(view.headings, top)) and the sheet on screen
  // only with an ai block, or a gloss still running (`a` cancels it after the block goes)
  const glossing = !!s.ai || [...jobs.keys()].some((k) => k.startsWith("gloss:"))
  const gHere: GlossTarget | null =
    L.zen && glossing && s.openPath && file && !file.error ? memo.gloss(src, currentHeading, s.openPath, title) : null
  const gHash = memo.glossHash(gHere?.text ?? "")
  const gStyle: GlossStyle = parseGlossStyle(s.ai?.gloss)
  const g = L.zen && s.ai ? s.gloss : null
  // the note's own section: the live hash while it is the reading section, else the one taken when it was shown
  const sheet = g ? glossView(s, g, gHere?.id === g.id ? gHash : g.hash, memo, jobs) : null
  return { gHere, gHash, gStyle, sheet, ...glossPlace(s, L, src, sheet, memo) }
}

/** Where the note goes: the margin's column from 140 columns (null: the sheet), the other sections' fresh glosses there, and whether the note overflows its collapsed rows. */
function glossPlace(s: UI, L: Layout, src: string, sheet: GlossView | null, memo: Memo) {
  // zen has no panel: the area is the terminal less a column each side
  const margin = L.zen && s.ai ? sidenoteAt(L.areaW + 2, 1 + L.padL, L.CW, L.areaW + 1) : null
  const others =
    margin === null || !s.glosses
      ? NO_FRESH
      : memo.glossFresh(src, s.openPath ?? "", s.glosses, parseGlossStyle(s.ai?.gloss))
  const [w, rows] = margin === null ? [L.CW, GLOSS_ROWS] : [SIDENOTE_W, SIDENOTE_ROWS]
  const overflow = !!sheet && overflows(sheet.text, w, rows)
  return { margin, others, overflow }
}

/** The note `g` as drawn: waiting or streaming while its job runs, else its cache entry, fresh or outdated against `hash`. */
function glossView(
  s: UI,
  g: NonNullable<UI["gloss"]>,
  hash: string,
  memo: Memo,
  jobs: Map<string, Job>,
): GlossView | null {
  const job = jobs.get(jobKey("gloss", g.id))
  const e = s.glosses?.[g.key]
  const base = { index: g.index, open: g.open, fadeAt: g.fadeAt }
  if (job) {
    const text = memo.glossClean(job.raw)
    const state = text ? "streaming" : "waiting"
    // regenerating: the old text stays, dimmed, under the caret row until the first token
    const old = e?.gloss ?? ""
    return { ...base, state, text, old, model: shortModel(job.model), secs: waitSecs(Date.now(), job.at), stale: null }
  }
  if (!e) return null
  const stale = staleKind(e, hash, PROMPTS.gloss)
  const state = stale ? "outdated" : "result"
  return { ...base, state, text: e.gloss, old: "", model: shortModel(e.model), secs: 0, stale }
}

/** The rows on screen: the section ranges, Spotlight's bright section, the window, the page and the Teleprompter flag. */
export function readingWindow(
  s: UI,
  L: Layout,
  view: Rendered,
  { top, tw, pages }: ReturnType<typeof scrollState>,
  memo: Memo,
) {
  const ranges = memo.ranges(view)
  /** Spotlight: the section kept bright (the one holding the reading / top line) */
  const spot =
    L.zen && s.zenCfg.flow === "scroll" && s.zenCfg.spotlight ? (ranges[sectionAt(ranges, top)] ?? null) : null
  /** Rows on screen: row `i` shows line `first + i` when it lies in `lo..hi` (blank otherwise). */
  let win = { first: tw ? typewriterTop(top, L.CH) : top, lo: 0, hi: view.lines.length }
  let pg: { index: number; count: number; start: number; end: number; top: number; maxTop: number } | null = null
  if (pages) {
    const index = sectionAt(ranges, top)
    const [start, end] = ranges[index]!
    const slice = pageSlice([start, end], L.CH, top - start)
    pg = { index, count: ranges.length, start, end, top: slice.top, maxTop: start + Math.max(0, end - start - L.CH) }
    win = { first: slice.top - slice.pad, lo: slice.top, hi: end }
  }
  /** Teleprompter option in effect (scroll flow only) */
  const prompter = L.zen && s.zenCfg.flow === "scroll" && s.zenCfg.prompter
  return { ranges, spot, win, pg, prompter }
}
