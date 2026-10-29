// The app's derived data: the memoized builders (`makeMemo`) and `derive()`, everything computed from the store.
// Not pure: `derive()` writes back the Files cursor, the scroll entry it remaps and the match line it re-finds.
import { existsSync } from "node:fs"
import { rankNotes, SCAN_LIMIT, visibleRows, type FileNode } from "../notes/files"
import { render, type Geometry, type Rendered } from "../markdown/render"
import { normalize } from "../markdown/lexer"
import { parseFrontMatter, parseProperties, type FrontMatter, type Property } from "../markdown/frontmatter"
import { stats, wordStats, type Stats } from "../markdown/stats"
import type { HeadingStyle } from "../markdown/heading-style"
import { renderSource } from "../markdown/source"
import { lineText } from "../lib/spans"
import { clamp, wrap } from "../lib/text"
import { readDoc, type DocFile } from "../notes/doc"
import { STDIN, projectRoot } from "../notes/workspace"
import { layout } from "../ui/layout"
import { themes, type Theme } from "../theme/theme"
import { MAX_BYTES } from "../notes/stdin"
import { fsDirIO, loadProjects, openRows, type OpenRow, type ProjectEntry } from "../notes/projects"
import { firstHit, isStop, recentSection, searchVault, switchRows, type SwitchRow, type VaultIndex } from "../notes/vault"
import { miniInk } from "../ui/minimap"
import { filterFamilies, paneLines, sampleView } from "../theme/themepick"
import { cached, findLines, matchIndex, relocate, remapTop } from "../ui/nav"
import { cleanSummary, noteText, shortModel } from "../ai/client"
import { PROMPTS, resolveAI, type AIConfig, type GlossStyle } from "../ai/config"
import { askCandidates, askRows, questionOf, rerankCost, type AskState, type Candidate } from "../ai/ask"
import { isFresh, textHash } from "../ai/cache"
import { glossTarget, parseGlossStyle, type GlossState, type GlossTarget } from "../ai/gloss"
import { noteTitle } from "../ui/status"
import { extractLinks, fmtSize, infoItems, outlineRows, resolveLink, type ChangeState, type ChangeView, type FileMeta, type InfoItem, type LinkRef, type SummaryState, type SummaryView } from "../ui/panel"
import { diffSections, hhmm, parseDelta, type Change, type DeltaNote } from "../ai/delta"
import { pageSlice, sectionAt, sectionRanges, typewriterTop, wordSuffix } from "../ui/zen"
import { WELCOME_RECENTS } from "../ui/welcome"
import type { View } from "../system/config"
import { NO_CANDS, NO_CHANGES, NO_NOTES, jobKey, type FileRow, type Job, type UI } from "./store"

/** The memoized builders behind `derive()` and render (`cached`: one entry each, so one call site with primitive args); `stdin` is the piped document. */
export function makeMemo(stdin: string | undefined) {
  return {
    switch: cached((ix: VaultIndex, tree: FileNode, q: string, _ver: number, recent: readonly string[], open: string | null) =>
      switchRows(q.trim() ? searchVault(ix, tree, q, open) : recentSection(tree, recent, open)),
    ),
    // relative paths resolve against the workspace folder; the current project is not listed
    open: cached((list: ProjectEntry[], q: string, cwd: string, current: string) => openRows(list, q, { cwd, io: fsDirIO, exists: existsSync, current })),
    // the welcome page's recent projects: the `o` picker's rows with an empty query, header first; read again
    // after every workspace switch (`watchGen`) and a dropped missing one (`gen`)
    recents: cached((root: string, _gen: number, _watchGen: number) =>
      openRows(loadProjects(), "", { cwd: root, io: fsDirIO, exists: existsSync, current: root }).slice(0, 1 + WELCOME_RECENTS)),
    read: cached((path: string, nonce: number): DocFile =>
      path !== STDIN || stdin === undefined
        ? readDoc(path, nonce)
        : Buffer.byteLength(stdin) > MAX_BYTES
          ? { src: "", info: null, error: `input too large (${fmtSize(Buffer.byteLength(stdin))}, limit 5 MB)` }
          : { src: stdin, info: null, error: null },
    ),
    fm: cached(parseFrontMatter),
    doc: cached((src: string, w: number, t: Theme, _hl: number, tree: FileNode, headings: HeadingStyle) => render(src, w, t, { exists: (x) => resolveLink(x, tree) !== null, headings })),
    source: cached((src: string, w: number, t: Theme, tree: FileNode) => renderSource(src, w, t, { exists: (x) => resolveLink(x, tree) !== null })),
    stats: cached(stats),
    props: cached(parseProperties),
    linkTargets: cached(extractLinks),
    links: cached((targets: string[], tree: FileNode, from: string | null): LinkRef[] => targets.map((target) => ({ target, path: resolveLink(target, tree, from) }))),
    info: cached(
      (p: Property[], st: Stats, l: LinkRef[], w: number, f: FileMeta | null, sText: string, sState: SummaryState | "", sModel: string,
        cState: ChangeState | "", cLabel: string, cChanges: readonly Change[], cSummary: string, cNotes: readonly (DeltaNote | undefined)[], title: string) =>
        infoItems(p, st, l, w, f, undefined, sState ? { text: sText, state: sState, model: sModel } : undefined,
          cState ? { view: { state: cState, label: cLabel, changes: cChanges, summary: cSummary, notes: cNotes }, title } : undefined),
    ),
    note: cached(noteText),
    diff: cached(diffSections),
    propsKey: cached((fm: FrontMatter) => JSON.stringify(fm.entries)),
    partial: cached((raw: string, changes: Change[]) => parseDelta(raw, changes, true)),
    hash: cached((src: string) => textHash(noteText(src))),
    clean: cached(cleanSummary),
    gloss: cached(glossTarget),
    glossHash: cached(textHash),
    glossClean: cached(cleanSummary),
    // Info cursor stops: links and change rows (removed sections are not stops)
    linkIdx: cached((items: InfoItem[]) => items.flatMap((it, i) => (it.kind === "link" || (it.kind === "change" && it.stop) ? [i] : []))),
    rows: cached(visibleRows),
    outline: cached(outlineRows),
    rank: cached((tree: FileNode, q: string) => {
      const r = rankNotes(tree, q)
      return { total: r.total, rows: r.rows.map((x): FileRow => ({ node: x.node, depth: 0, hits: x.hits })) }
    }),
    matches: cached((view: Rendered, q: string) => findLines(view.lines.map(lineText), q)),
    geo: cached((view: Rendered): Geometry => ({ heads: view.headings.map((h) => h.line), total: view.lines.length })),
    /** the `t` picker's rows, its sample in the candidate theme (`_hl`: re-render once code is highlighted) and the pane rows */
    themeRows: cached((q: string) => filterFamilies(q)),
    themeSample: cached((t: Theme, w: number, _hl: number, headings: HeadingStyle) => sampleView(t, w, headings)),
    themePane: cached(paneLines),
    /** the switcher's peek: the highlighted note read (one note at a time), then only its `peekWindow` rendered at the pane width */
    peekFile: cached((path: string, mtime: number) => {
      const f = readDoc(path, mtime)
      if (f.error) return null
      const fm = parseFrontMatter(f.src)
      const st = wordStats(fm.body) // stats() would lex the whole note
      return { lines: normalize(f.src).split("\n"), fm: fm.offset, hash: textHash(noteText(f.src)), words: st.words, minutes: st.minutes }
    }),
    peek: cached((lines: readonly string[], from: number, to: number, w: number, t: Theme, tree: FileNode, headings: HeadingStyle) =>
      render(lines.slice(from, to).join("\n"), w, t, { exists: (x) => resolveLink(x, tree) !== null, headings }),
    ),
    // Source rows open with the line-number gutter (`gutter` columns), which draws no dots
    mini: cached((view: Rendered, w: number, rows: number, gutter: number) =>
      miniInk(gutter ? view.plain.map((p) => p.slice(gutter)) : view.plain, view.lines.map((l) => l.fill !== undefined), w - gutter, rows),
    ),
    words: cached((view: Rendered) => wordSuffix(view.plain)),
    ranges: cached((view: Rendered) => sectionRanges(view.headings.map((h) => h.line), view.lines.length)),
    /** where an ask would go: null without an `ai` block, else the host or why not */
    host: cached((ai: AIConfig | null) => {
      if (!ai) return null
      const r = resolveAI(ai, process.env)
      return "error" in r ? { error: r.error } : { host: r.host }
    }),
    cands: cached((ix: VaultIndex, tree: FileNode, _ver: number, queries: readonly string[]) => askCandidates(ix, tree, queries)),
    cost: cached((question: string, cands: readonly Candidate[], ix: VaultIndex, _ver: number) => rerankCost(question, cands, ix)),
    ask: cached(
      (question: string, cut: boolean, target: { host: string } | { error: string } | null, state: AskState | undefined, cands: readonly Candidate[], cost: string, indexing: boolean) =>
        askRows({ question, cut, target, state, cands, cost, indexing }),
    ),
  }
}
/** The memo table: one `cached` builder per derived value. */
type Memo = ReturnType<typeof makeMemo>

/** A scroll entry: the top line and the geometry it was taken at, so a re-layout can remap it. */
interface ScrollEntry {
  top: number
  geo: Geometry
}

/** What `derive()` reads and writes besides the store. */
export interface DeriveRefs {
  ui: { current: UI }
  dims: { current: { W: number; H: number } }
  memo: Memo
  /** the switcher's index of `linkTree`; replaced (never mutated) when dropped, so a stale build sees it and stops */
  vault: { current: { ix: VaultIndex; running: boolean } }
  /** AI requests in flight by `jobKey`: the raw streamed text and how to cancel it */
  jobs: { current: Map<string, Job> }
  sidebarSeen: { current: { rows: FileRow[] | null; cursorPath: string | null } }
  scrolls: { current: Map<string, ScrollEntry> }
  /** the match list last derived, to remap `matchLine` when the lines are re-wrapped */
  matchSeen: { current: { matches: number[]; query: string } }
}

/** `derive()` over these refs. */
export function makeDerive({ ui, dims, memo, vault, jobs, sidebarSeen, scrolls, matchSeen }: DeriveRefs) {
  /** Everything computed from the store; cheap to call repeatedly thanks to `memo`. */
  return () => {
    const s = ui.current
    const L = layout(dims.current.W, dims.current.H, s)
    const t = themes[s.themeIdx]!
    const file = s.openPath ? memo.read(s.openPath, s.reload) : null
    const src = file?.src ?? ""
    const fm = memo.fm(src)
    const doc = memo.doc(fm.body, L.CW, t, s.hl, s.linkTree, s.headingStyle)
    const view = s.source ? memo.source(src, L.CW, t, s.linkTree) : doc
    const st = memo.stats(fm.body)
    const filtered = s.filter.trim() !== ""
    const ranked = filtered ? memo.rank(s.tree, s.filter) : null
    const rows: FileRow[] = ranked ? ranked.rows : memo.rows(s.tree, s.expanded)
    const total = ranked?.total ?? 0

    // panel: strip and rule rows, then the view's list; Files pins the truncation note under it
    const note =
      s.view === "files" && s.tree.truncated
        ? wrap([{ text: `scan stopped at ${SCAN_LIMIT / 1000}k entries — some notes missing` }], L.PNW - 2).map((r) => r.map((x) => x.text).join(""))
        : []
    const props = memo.props(src)
    const links = memo.links(memo.linkTargets(fm.body), s.linkTree, s.openPath)
    const saved = s.openPath ? s.summaries[s.openPath] : undefined
    const job = s.openPath ? jobs.current.get(jobKey("tldr", s.openPath)) : undefined
    // primitives into memo.info, never a fresh object, so the single-entry memo holds
    const sv: SummaryView | null =
      !s.ai || !s.openPath || !file || file.error
        ? null
        : job
          ? { text: memo.clean(job.raw), state: "streaming", model: "" }
          : saved
            ? { text: saved.summary, state: isFresh(saved, memo.hash(src)) ? "fresh" : "outdated", model: shortModel(saved.model) }
            : { text: "", state: "none", model: "" }
    const title = noteTitle(props, s.openPath ?? "")
    // a live reload's changes: the open note against the text it had when it opened (memory only)
    const base = s.baseline && s.baseline.path === s.openPath && file && !file.error ? s.baseline : null
    const after = memo.note(src)
    const propsKey = memo.propsKey(fm)
    const changes = base ? memo.diff(base.text, after) : NO_CHANGES
    const propsChanged = !!base && propsKey !== base.props
    const dl = s.delta && s.delta.path === s.openPath ? s.delta : null
    const dJob = dl ? jobs.current.get(jobKey("delta", dl.path)) : undefined
    const live = dl && dJob ? memo.partial(dJob.raw, dl.changes) : null
    // loading, else the reply while nothing changed since the explained text, else the idle list
    const cv: ChangeView | null =
      dl && dJob
        ? { state: "loading", label: "", changes: dl.changes, summary: live?.summary ?? "", notes: live?.notes ?? NO_NOTES }
        : dl?.result && changes !== null && !changes.length // null: too large to compare, not unchanged
          ? { state: "result", label: dl.result.model, changes: dl.changes, summary: dl.result.summary, notes: dl.result.notes }
          : base && changes?.length
            ? { state: "idle", label: hhmm(base.at), changes, summary: "", notes: NO_NOTES }
            : null
    const infoRows = memo.info(props, st, links, L.PNW - 2, file?.info ?? null, sv?.text ?? "", sv?.state ?? "", sv?.model ?? "",
      cv?.state ?? "", cv?.label ?? "", cv?.changes ?? NO_CHANGES, cv?.summary ?? "", cv?.notes ?? NO_NOTES, title)
    const linkRows = memo.linkIdx(infoRows)
    const question = s.switcher ? questionOf(s.switcher.q) : null
    const askState = s.switcher?.ask
    // ranking waits for a complete index, then re-runs whenever it changes (ixVer)
    const askCands = question && askState?.queries && !s.indexing ? memo.cands(vault.current.ix, s.linkTree, s.ixVer, askState.queries) : NO_CANDS
    const askCost = question && askCands.length ? memo.cost(question.text, askCands, vault.current.ix, s.ixVer) : ""
    const swRows: SwitchRow[] = !s.switcher
      ? []
      : question
        ? memo.ask(question.text, question.cut, memo.host(s.ai), askState, askCands, askCost, s.indexing !== null)
        : memo.switch(vault.current.ix, s.linkTree, s.switcher.q, s.ixVer, s.recent, s.openPath)
    // the highlight always sits on a stop (results change under it while typing or indexing)
    const swAt = s.switcher ? swRows[s.switcher.hl] : undefined
    const swHl = s.switcher && swAt && isStop(swAt) ? s.switcher.hl : firstHit(swRows)
    const opRows: OpenRow[] = s.opener ? memo.open(s.opener.list, s.opener.q, s.root, projectRoot(s)) : []
    const opAt = s.opener ? opRows[s.opener.hl] : undefined
    const opHl = s.opener && opAt && opAt.kind !== "header" ? s.opener.hl : firstHit(opRows)
    const filterRow = (s.view === "files" && (s.filterTyping || s.filter !== "")) || (s.view === "outline" && (s.filterTyping || s.outlineFilter !== ""))
    const LH = Math.max(1, L.bodyH - 2 - (filterRow ? 1 : 0) - note.length)

    // when the Files list changes, put the cursor back on the same note
    const seen = sidebarSeen.current
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

    const scrollKey = `${s.openPath}:${s.source ? "source" : "preview"}`
    const geo = memo.geo(view)
    // typewriter: the scroll top *is* the reading line, so it may go down to the last line
    const tw = L.zen && s.zenCfg.flow === "scroll" && s.zenCfg.typewriter
    // pages: the scroll top is the page anchor (its section is the page), so it may be any line too
    const pages = L.zen && s.zenCfg.flow === "pages"
    const maxTop = tw || pages ? Math.max(0, view.lines.length - 1) : Math.max(0, view.lines.length - L.CH)
    const entry = scrolls.current.get(scrollKey)
    if (entry && entry.geo !== geo) {
      // re-laid out (resize, reload): keep the reading position
      entry.top = remapTop(entry.top, entry.geo, geo)
      entry.geo = geo
    }
    const top = Math.max(0, Math.min(entry?.top ?? 0, maxTop))
    const matches = memo.matches(view, s.query)
    // a re-wrap (w, resize, live reload) moves every match line: keep the same match index
    const prev = matchSeen.current
    if (prev.query === s.query && prev.matches !== matches && s.matchLine !== null) {
      const i = prev.matches.indexOf(s.matchLine)
      s.matchLine = matches[i] ?? null
    }
    matchSeen.current = { matches, query: s.query }
    // the heading the reader is in: last one at (or just above) the top line
    const currentHeading = view.headings.findLastIndex((h) => h.line <= top + 1)
    const oRows = memo.outline(view.headings, currentHeading, s.outlineFilter)
    // zen gloss: the section under the reading line (currentHeading is sectionOf(view.headings, top)) and the sheet on screen
    // only with an ai block, or a gloss still running (`a` cancels it after the block goes)
    const glossing = !!s.ai || [...jobs.current.keys()].some((k) => k.startsWith("gloss:"))
    const gHere: GlossTarget | null = L.zen && glossing && s.openPath && file && !file.error ? memo.gloss(src, currentHeading, s.openPath, title) : null
    const gHash = memo.glossHash(gHere?.text ?? "")
    const gStyle: GlossStyle = parseGlossStyle(s.ai?.gloss)
    let sheet: { state: GlossState; heading: string; text: string; fadeAt: number | null } | null = null
    const g = L.zen && s.ai ? s.gloss : null
    if (g) {
      const job = jobs.current.get(jobKey("gloss", g.id))
      const e = s.glosses?.[g.key]
      // the sheet's own section: the live hash while it is the reading section, else the one taken when it was shown
      const hash = gHere?.id === g.id ? gHash : g.hash
      if (job) sheet = { state: "loading", heading: g.heading, text: memo.glossClean(job.raw), fadeAt: g.fadeAt }
      else if (e) sheet = { state: isFresh(e, hash, PROMPTS.gloss) ? "result" : "outdated", heading: g.heading, text: e.gloss, fadeAt: g.fadeAt }
    }
    const sideFocus: View | null = L.shown && s.focus === "panel" ? s.view : null
    const ranges = memo.ranges(view)
    /** Spotlight: the section kept bright (the one holding the reading / top line) */
    const spot = L.zen && s.zenCfg.flow === "scroll" && s.zenCfg.spotlight ? (ranges[sectionAt(ranges, top)] ?? null) : null
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
    return {
      s,
      L,
      prompter,
      t,
      file,
      fm,
      doc,
      view,
      st,
      rows,
      filtered,
      total,
      filterRow,
      props,
      infoRows,
      linkRows,
      swRows,
      swHl,
      question,
      askCands,
      opRows,
      opHl,
      infoCur: clamp(s.infoCur, 0, linkRows.length - 1),
      LH,
      note,
      scrollKey,
      geo,
      maxTop,
      top,
      tw,
      pg,
      ranges,
      spot,
      win,
      matches,
      matchIdx: matchIndex(matches, s.matchLine),
      title,
      changes,
      propsChanged,
      after,
      propsKey,
      cv,
      currentHeading,
      gHere,
      gHash,
      gStyle,
      sheet,
      sideFocus,
      oRows,
      outlineCur: clamp(s.outlineCur, 0, oRows.length - 1),
    }
  }
}
/** What `derive()` returns. */
export type Derived = ReturnType<ReturnType<typeof makeDerive>>
