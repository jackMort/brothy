import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { MouseButton, type KeyEvent, type MouseEvent } from "@opentui/core"
import { closeSync, existsSync, openSync, statSync } from "node:fs"
import { basename, dirname, relative, resolve, sep } from "node:path"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { SCAN_LIMIT, ancestorsOf, folderCounts, rankNotes, scanTree, stem, visibleRows, type FileNode } from "./files"
import { ensureHighlights } from "./highlight"
import { drop, go, keep, startHistory, stepTo, visit } from "./history"
import { A, HEADING_STYLES, normalize, parseFrontMatter, sourceScan, parseProperties, pendingHighlights, render, renderSource, stats, wordStats, width as sw, wrap, type HeadingStyle, type Line, type LinkTarget, type Property, type Rendered, type Span, type Stats, type FrontMatter } from "./markdown"
import { safeLine } from "./spans"
import { Row } from "./app/Row"
import { AI_FRAME, MAX_JOBS, jobKey, type JobKind } from "./app/ai-jobs"
import { MAX_DEPTH, NO_CANDS, NO_CHANGES, NO_NOTES, OPEN_DELAY, SCRIM_DIM, ZEN_DIM, initUI, type FileRow, type Focus, type Spot, type UI } from "./app/store"
import { FOOTERS, HELP_GROUPS, KEY_IDS, WELCOME_KEYS, WELCOME_OFF, ZEN_OFF, isDown, keyDef, modeOf, type Ctx, type KeyId, type Mode } from "./app/keymap"
import { MAX_BYTES } from "./stdin"
import { readDoc, type DocFile } from "./doc"
import { STDIN, projectRoot, workspace } from "./workspace"
import { DRAWER_BELOW, layout } from "./layout"
import { contrastOn, mix, surface, themes, type Theme } from "./theme"
import { HelpSheet, OpenPicker, Overlay, PickerInput, PickerList, Switcher, ThemePicker, Welcome, ZenSettings, fitHits, hitSpans as markHits, usePointer, type PickerItem } from "./overlay"
import { helpLayout } from "./help"
import { STEAM_MS, STILL_TICK, WELCOME_RECENTS, welcomeFit } from "./welcome"
import { INK_MS, INK_STEPS } from "./chrome"
import { fsDirIO, loadProjects, openRows, projectName, remember as rememberProject, saveProjects, tildify, type OpenRow, type ProjectEntry } from "./projects"
import { emptyIndex, firstHit, foldSame, fsIO, hitOrdinal, indexNote, isStop, refreshIndex, nextSection, recentSection, remember, searchVault, stepRow, switchRows, type AnswerRow, type NoteDoc, type SwitchRow, type TextHit, type VaultIndex } from "./vault"
import { MINI_MIN_W, MINI_W, miniCells, miniColors, miniInk, miniJump } from "./minimap"
import { PEEK_MIN_W, peekLines, peekWindow, switchSplit } from "./peek"
import { filterFamilies, onlyMode, paneLines, pickIndex, pickMode, pickMove, pickQuery, pickShown, pickStart, pickTheme, pickTop, resolveTheme, sampleView, themeSplit, type ThemePick } from "./themepick"
import { VIEWS, loadConfig, saveConfig, type Config, type SidebarConfig, type View } from "./config"
import { cached, copiedCount, findLines, findQuote, keepVisible, linkLabels, markMatches, matchRanges, matchIndex, matchKey, narrowLabels, overlayAt, relocate, remapTop, selectedText, stepMatch, stripLayout, thumb, visibleLinks, type Geometry } from "./nav"
import { watchPath } from "./watch"
import { editorCommand, runEditor, sourceLineAt, type EditResult } from "./editor"
import { PROMPTS, PROMPT_V, aiError, chat, cleanSummary, noteText, resolveAI, shortModel, stripThink, summarize, type AIConfig, type AITarget, type Failure } from "./ai"
import { ASK_MEMO, ASK_MIN, ASK_PROMPT, RERANK_MEMO, RERANK_PROMPT, askCandidates, askLocate, askRows, askSection, askTitleNote, parseQueries, parseRerank, putNewest, questionOf, rerankCost, rerankMessage, type AskState, type Candidate } from "./ask"
import { isFresh, loadGlosses, saveGlosses, saveSummaries, textHash, type Gloss } from "./summaries"
import { GLOSS_MAX, GLOSS_ROWS, glossKey, glossRequest, glossRows, glossRule, glossTarget, parseGlossStyle, type GlossState, type GlossStyle, type GlossTarget } from "./gloss"
import { LOGO, LOGO_HOLD, errText, tooSmall, TOAST_HOLD, fillWidth, fitHints, headerLayout, logoState, mainHeadingVisible, nextToast, noteTitle, progressLabel, toastIcon, toastStep, truncate, truncateLeft, type HintItem, type ToastKind } from "./status"
import { extractLinks, findHeading, fmtNum, headingKey, fmtSize, infoItems, linkDest, outlineRows, plural, resolveLink, type ChangeState, type ChangeView, type FileMeta, type InfoItem, type LinkRef, type SummaryState, type SummaryView } from "./panel"
import { DELTA_MAX, DELTA_PROMPT, MAX_DELTA, deltaMessage, diffSections, hhmm, parseDelta, quoteNeedle, reloadToast, type Change, type DeltaNote } from "./delta"
import { GHOST_HOLD, GHOST_STEP, GHOST_STEPS, HINT_HOLD, SPOT_DIM, ZEN_ROWS, ZEN_WPM, dimSpans, fadeStep, headingPath, minutesLeft, normalizeZen, pageSlice, prompterRate, sectionAt, stepMeasure, sectionRanges, typewriterTop, wordSuffix, zenAdjust, zenRows, type ZenConfig } from "./zen"

export const VERSION = "0.2.0"

export interface AppProps {
  root: string
  initialFile?: string
  themeName?: string
  /** `--transparent`: wins over the config for this run (a live toggle still saves). */
  transparent?: boolean
  /** injected by tests; the CLI uses the global fetch */
  fetch?: typeof fetch
  /** runs the editor and waits (tests stub it; the default is `runEditor`); `piped`: keys come from /dev/tty */
  edit?: (argv: string[], piped: boolean) => EditResult | void
  /** Markdown piped on stdin: the only document, with no Files tree, watcher or project record */
  stdin?: string
  /** ms after mount before a piped document's links start scanning in the background (tests delay it) */
  linkScanDelay?: number
  /** animations; tests and snapshots run without them unless this says true (default: config `motion`, on) */
  motion?: boolean
}

// ------------------------------------------------------------- helpers

const clampIdx = (i: number, len: number) => Math.max(0, Math.min(i, len - 1))
/** What the label spots depend on: a highlight re-render keeps it, a reload, the mode, the width or the scroll changes it. */
const labelGeo = (s: Pick<UI, "openPath" | "source" | "reload">, CW: number, rows: number, top: number) =>
  [s.openPath, s.source, s.reload, CW, rows, top].join("\0")
const lineText = (l: Line | undefined) => (l?.spans ?? []).map((s) => s.text).join("")
const spansWidth = (spans: Span[]) => spans.reduce((a, sp) => a + sw(sp.text), 0)

// ------------------------------------------------------------- app

export function App({ root: startRoot, initialFile, themeName, transparent, fetch: fetchImpl = globalThis.fetch, edit: editImpl, stdin, linkScanDelay = 0, motion }: AppProps) {
  const renderer = useRenderer()
  const pointer = usePointer()
  const { width: W, height: H } = useTerminalDimensions()
  const dims = useRef({ W, H })
  dims.current = { W, H }

  // a ref-like box built once, on the first render: handlers read `ui.current` at call time
  const [ui] = useState(() => ({ current: initUI(startRoot, initialFile, themeName, transparent, stdin !== undefined, motion) }))
  const [, bump] = useState(0)
  const set = (patch: Partial<UI>) => {
    Object.assign(ui.current, patch)
    bump((x) => x + 1)
  }

  // crossing DRAWER_BELOW: a focused panel becomes an open drawer; widening shows it inline again
  const modeSeen = useRef<"inline" | "drawer" | null>(null)
  const modeNow = W < DRAWER_BELOW ? "drawer" : "inline"
  if (modeSeen.current !== modeNow) {
    const s0 = ui.current
    if (modeSeen.current === "inline") s0.drawerOpen = s0.focus === "panel" && !s0.hidden && !s0.zen
    if (modeSeen.current === "drawer") {
      s0.drawerOpen = false
      if (s0.hidden && s0.focus === "panel") {
        s0.focus = "doc"
        s0.filterTyping = false
      }
    }
    modeSeen.current = modeNow
  }

  // derived data, memoized so handlers and render can both pull it on demand
  /** the switcher's index of `linkTree`; replaced (never mutated) when dropped, so a stale build sees it and stops */
  const vault = useRef<{ ix: VaultIndex; running: boolean }>({ ix: emptyIndex(), running: false })
  const memo = useRef({
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
    // Source rows open with the line-number gutter (`gutter` columns), which draws no dots
    /** the `t` picker's rows, its sample in the candidate theme (`_hl`: re-render once code is highlighted) and the pane rows */
    themeRows: cached((q: string) => filterFamilies(q)),
    themeSample: cached((t: Theme, w: number, _hl: number, headings: HeadingStyle) => sampleView(t, w, headings)),
    themePane: cached(paneLines),
    /** the switcher's peek: the highlighted note read (one note at a time), then only its `peekWindow` rendered at the pane width */
    peekFile: cached((path: string, _mtime: number) => {
      const f = readDoc(path, _mtime)
      if (f.error) return null
      const fm = parseFrontMatter(f.src)
      const st = wordStats(fm.body) // stats() would lex the whole note
      return { lines: normalize(f.src).split("\n"), fm: fm.offset, hash: textHash(noteText(f.src)), words: st.words, minutes: st.minutes }
    }),
    peek: cached((lines: readonly string[], from: number, to: number, w: number, t: Theme, tree: FileNode, headings: HeadingStyle) =>
      render(lines.slice(from, to).join("\n"), w, t, { exists: (x) => resolveLink(x, tree) !== null, headings }),
    ),
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
  }).current
  /** The match list last derived, to remap `matchLine` when the lines are re-wrapped. */
  const matchSeen = useRef<{ matches: number[]; query: string }>({ matches: [], query: "" })
  const scrolls = useRef(new Map<string, { top: number; geo: Geometry }>())
  /** Normal-view position on entering zen; restored verbatim on exit unless the reader moved. */
  const zenBack = useRef<{ key: string; top: number; geo: Geometry } | null>(null)
  const sidebarSeen = useRef<{ rows: FileRow[] | null; cursorPath: string | null }>({ rows: null, cursorPath: null })
  const timers = useRef<{
    toast?: ReturnType<typeof setTimeout>
    open?: ReturnType<typeof setTimeout>
    roll?: ReturnType<typeof setTimeout>
    ghost?: ReturnType<typeof setTimeout>
    hints?: ReturnType<typeof setTimeout>
    logo?: ReturnType<typeof setTimeout>
    ai?: ReturnType<typeof setTimeout>
    gloss?: ReturnType<typeof setTimeout>
    steam?: ReturnType<typeof setTimeout>
  }>({})
  /** AI requests in flight by `jobKey`: the raw streamed text and how to cancel it */
  const jobs = useRef(new Map<string, { kind: JobKind; raw: string; abort: AbortController }>())
  /** tier 0 queries per question (foldSame), this session only: asking again sends nothing */
  const askMemo = useRef(new Map<string, { queries: string[]; model: string }>())
  /** tier 1 orders per question + candidate list, this session only */
  const rerankMemo = useRef(new Map<string, { order: string[]; why: Record<string, string>; model: string }>())
  /** the context the hints were last poked for */
  const ctxSeen = useRef<Ctx | null>(null)
  /** the note and section the gloss auto-show last ran for (null: outside zen) */
  const glossSeen = useRef<string | null>(null)
  /** false once unmounted: late timers and AI or highlight results drop their update */
  const alive = useRef(true)
  /** the document and the theme sample whose code highlighting was last asked for */
  const hlSeen = useRef<Rendered | null>(null)
  const hlSample = useRef<Rendered | null>(null)
  /** `leave` has run: the last project record is written once */
  const left = useRef(false)
  /** the welcome page: highlighted row, recents generation, steam tick, ink frame, animation state, its start and size */
  const welcome = useRef({ hl: 1, gen: 0, tick: STILL_TICK, ink: INK_STEPS - 1, run: "idle" as "idle" | "live" | "done", at: 0, W, H })

  /** Everything computed from the store; cheap to call repeatedly thanks to `memo`. */
  const derive = () => {
    const s = ui.current
    const L = layout(dims.current.W, dims.current.H, s)
    const t = themes[s.themeIdx]!
    const file = s.openPath ? memo.read(s.openPath, s.reload) : null
    const src = file?.src ?? ""
    const fm = memo.fm(src)
    const doc = memo.doc(fm.body, L.CW, t, s.hl, s.linkTree, s.headings)
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
    const swHl = s.switcher && swRows[s.switcher.hl] && isStop(swRows[s.switcher.hl]!) ? s.switcher.hl : firstHit(swRows)
    const opRows: OpenRow[] = s.opener ? memo.open(s.opener.list, s.opener.q, s.root, projectRoot(s)) : []
    const opHl = s.opener && opRows[s.opener.hl] && opRows[s.opener.hl]!.kind !== "header" ? s.opener.hl : firstHit(opRows)
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
      s.matchLine = i >= 0 && i < matches.length ? matches[i]! : null
    }
    matchSeen.current = { matches, query: s.query }
    // the heading the reader is in: last one at (or just above) the top line
    const hs = view.headings
    let currentHeading = -1
    for (let i = 0; i < hs.length; i++) if (hs[i]!.line <= top + 1) currentHeading = i
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
    const spot = L.zen && s.zenCfg.flow === "scroll" && s.zenCfg.spotlight ? ranges[sectionAt(ranges, top)]! : null
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
      infoCur: clampIdx(s.infoCur, linkRows.length),
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
      outlineCur: clampIdx(s.outlineCur, oRows.length),
    }
  }
  /** Context id outside popups and zen: the focused panel view, else the document. */
  const docMode = (): Ctx => {
    const v = derive().sideFocus
    if (v && ui.current.filterTyping) return "filter"
    return v ? `panel:${v}` : "doc"
  }

  // ---------------------------------------------------- actions
  /** Re-render through a fade: wait out `hold` after `at()`, then step every GHOST_STEP until hidden, then `done()`. */
  const runFade = (slot: "ghost" | "hints" | "toast" | "gloss", at: () => number | null, hold: number, done: () => void) => {
    clearTimeout(timers.current[slot])
    const tick = () => {
      const a = at()
      if (a === null) return
      const e = Date.now() - a
      if (fadeStep(e, hold) === null) return done()
      bump((x) => x + 1)
      timers.current[slot] = setTimeout(tick, e < hold ? hold - e : GHOST_STEP)
    }
    timers.current[slot] = setTimeout(tick, hold)
  }

  /** Toast on the ghost line's right; an error still holding is not replaced by ok / info. */
  const flash = (msg: string, kind: ToastKind = "info") => {
    const now = Date.now()
    // toasts carry names, paths and OS messages: never let one reach the terminal raw
    const next = nextToast(ui.current.toast, { msg: safeLine(msg), kind, at: now }, now)
    if (next === ui.current.toast) return
    set({ toast: next })
    runFade("toast", () => ui.current.toast?.at ?? null, TOAST_HOLD[kind], () => set({ toast: null }))
  }

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
    const req = glossRequest(style, title, g.trail, g.text, target.maxChars)
    void chat(target, { ...req, maxOut: GLOSS_MAX, clean: cleanSummary }, {
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
    const user = deltaMessage(title, changes, Math.min(target.maxChars, DELTA_MAX))
    void chat(target, { system: DELTA_PROMPT, user, maxOut: MAX_DELTA, clean: (r) => stripThink(r).trim() }, {
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

  const setTop = (n: number) => {
    zenBack.current = null // an explicit move (keys, find, jump, teleprompter tick) drops the exact restore
    const d = derive()
    scrolls.current.set(d.scrollKey, { top: Math.max(0, Math.min(n, d.maxTop)), geo: d.geo })
    bump((x) => x + 1)
  }
  const scrollBy = (n: number) => setTop(derive().top + n)

  // teleprompter: one line per tick at the configured wpm; any manual scroll pauses it
  const stopRolling = () => {
    clearTimeout(timers.current.roll)
    if (ui.current.rolling) set({ rolling: false })
  }
  // the rate is read afresh every line, so wpm changes, resizes and reloads apply at once
  const startRolling = () => {
    clearTimeout(timers.current.roll)
    const d0 = derive()
    if (!d0.prompter || d0.top >= d0.maxTop) return stopRolling()
    set({ rolling: true })
    const tick = () => {
      const d = derive()
      if (!d.prompter || d.top >= d.maxTop) return stopRolling()
      setTop(d.top + 1)
      const next = derive()
      if (next.top >= next.maxTop) return stopRolling()
      timers.current.roll = setTimeout(tick, 1000 / prompterRate(next.view.plain, next.s.zenCfg.wpm))
    }
    timers.current.roll = setTimeout(tick, 1000 / prompterRate(d0.view.plain, d0.s.zenCfg.wpm))
  }

  /** The open note's scroll entry, as history keeps it. */
  const here = (): Spot | null => {
    if (!ui.current.openPath) return null
    const d = derive()
    return { key: d.scrollKey, top: d.top, geo: d.geo }
  }

  /** Open `path`; it goes into history (`peek`: a Files preview, replaced by the next open unless it gets focus). */
  const openFile = (path: string, how: "open" | "peek" | "history" = "open") => {
    clearTimeout(timers.current.open)
    const s = ui.current
    if (path === s.openPath) return
    const history = how === "history" ? s.history : visit(s.history, path, here(), how === "peek")
    // reveal it: every folder above the note opens (they are never closed automatically)
    const expanded = new Set(s.expanded)
    for (const a of ancestorsOf(s.tree, path)) expanded.add(a)
    set({ openPath: path, history, outlineCur: 0, infoCur: 0, matchLine: null, expanded, listTop: { ...s.listTop, outline: 0, info: 0 } })
    // the Files cursor jumps to the ● row and scrolls it into view
    const { rows, LH } = derive()
    const i = rows.findIndex((r) => r.node.path === path)
    if (i >= 0) {
      sidebarSeen.current.cursorPath = path
      set({ cursor: i, listTop: { ...ui.current.listTop, files: keepVisible(ui.current.listTop.files, i, LH, rows.length) } })
    }
  }

  /** Move the Files cursor; notes open once the cursor rests (`now` opens at once). */
  const selectRow = (i: number, open: "later" | "now" | "no" = "later") => {
    const { rows, LH } = derive()
    const s = ui.current
    const n = clampIdx(i, rows.length)
    const node = rows[n]?.node
    sidebarSeen.current.cursorPath = node?.path ?? null
    set({ cursor: n, listTop: { ...s.listTop, files: keepVisible(s.listTop.files, n, LH, rows.length) } })
    clearTimeout(timers.current.open)
    if (!node || node.dir || open === "no") return
    if (open === "now") openFile(node.path, "peek")
    else timers.current.open = setTimeout(() => openFile(node.path, "peek"), OPEN_DELAY)
  }

  const toggleDir = (node: FileNode, open?: boolean) => {
    const next = new Set(ui.current.expanded)
    if (open ?? !next.has(node.path)) next.add(node.path)
    else next.delete(node.path)
    set({ expanded: next })
  }

  /** `saveConfig`, or an error toast when it refuses (a file that doesn't parse, a failed write). */
  const persist = (patch: Config) => {
    const ok = saveConfig(patch)
    if (!ok) flash("config.json not saved · it doesn't parse or can't be written", "error")
    return ok
  }
  /** Save the panel layout field that changed (`view` on change, `hidden` only by ^b inline); saveConfig merges it per field. */
  const saveSidebar = (patch: Partial<SidebarConfig>) => persist({ sidebar: patch, folds: undefined })

  /** Switch the panel view (saved). The Outline cursor starts on the heading being read. */
  const selectView = (v: View) => {
    if (v === ui.current.view) return
    if (v === "files" && ui.current.piped) v = "outline" // a piped session has no Files tab
    set({ view: v, filterTyping: false, outlineFilter: "", ...(v === "outline" ? { outlineCur: Math.max(0, derive().oRows.findIndex((r) => r.current)) } : {}) })
    if (!ui.current.piped) saveSidebar({ view: v })
  }

  /** The tabs, in `1 2 3` order: a piped session has no Files, also on a note followed from it. */
  const panelViews = (): readonly View[] => (ui.current.piped ? VIEWS.filter((v) => v !== "files") : VIEWS)

  /** Show the panel (unhide it inline, open the drawer) and focus it; Files lands on the open note. */
  const focusPanel = (v?: View) => {
    const was = derive().sideFocus
    if (v) selectView(v)
    const { L, rows, s, oRows } = derive()
    set({
      focus: "panel",
      ...(L.mode === "drawer" ? { drawerOpen: true } : { hidden: false }),
      ...(!was && s.view === "outline" ? { outlineCur: Math.max(0, oRows.findIndex((r) => r.current)) } : {}),
    })
    if (!was && s.view === "files") {
      const i = rows.findIndex((r) => r.node.path === s.openPath)
      if (i >= 0) selectRow(i, "no")
    }
  }

  /** Focus the document; the drawer closes with it. */
  const focusDoc = () => {
    clearTimeout(timers.current.open)
    const s = ui.current
    set({ focus: "doc", drawerOpen: false, filterTyping: false, recent: remember(s.recent, s.openPath), history: keep(s.history) })
  }
  /** Open a resolved Info link and read it; an unresolved one only says so, and Info keeps focus. */
  /** A piped document scans the working folder for links the first time one is used. */
  const ensureLinks = () => {
    const s = ui.current
    if (s.linkLazy) set({ linkTree: scanTree(s.root), linkLazy: false })
  }

  const openLink = (it: Extract<InfoItem, { kind: "link" }>) => {
    ensureLinks()
    const path = it.path ?? resolveLink(it.target, ui.current.linkTree, ui.current.openPath)
    if (!path) return flash(`no note named “${it.target}”`)
    set({ history: keep(ui.current.history) }) // a note followed from stays in history
    openFile(path)
    focusDoc()
  }

  /** Labels still match what is drawn: same note, mode, width, length and scroll position. */
  const liveLabels = () => {
    const lb = ui.current.labels
    if (!lb) return null
    const d = derive()
    return lb.geo === labelGeo(ui.current, d.L.CW, d.view.lines.length, d.top) ? lb : null
  }

  const startLabels = () => {
    ensureLinks()
    const d = derive()
    if (d.s.source) return flash("links: preview only (s)")
    const spots = visibleLinks(d.view.lines, d.top, d.L.CH)
    if (!spots.length) return flash("no links on screen")
    const labels = linkLabels(spots.length)
    set({ labels: { spots: spots.slice(0, labels.length), labels, typed: "", geo: labelGeo(ui.current, d.L.CW, d.view.lines.length, d.top) } })
  }

  /** Open where `l` leads: the note, then its heading; a URL or a missing target only says so. */
  const followLink = (l: LinkTarget) => {
    ensureLinks()
    const s = ui.current
    const dest = linkDest(l, s.openPath, s.linkTree)
    if (dest.url) return flash(dest.url)
    if (!dest.path) return flash(`no note named “${dest.label}”`)
    set({ history: keep(s.history) }) // a note followed from stays in history
    openFile(dest.path)
    focusDoc()
    if (!dest.heading) return
    const d = derive()
    const i = findHeading(d.view.headings, dest.heading)
    // a missing heading leaves the note at its remembered position
    if (i === null) flash(`no heading “${dest.heading}”`)
    else setTop(d.view.headings[i]!.line)
  }

  /** `H` / `L`: the note one step back / forward, where it was left; notes gone from disk are dropped. */
  const histMove = (dir: -1 | 1) => {
    let h = ui.current.history
    const gone: string[] = []
    const name = (p: string) => stem(basename(p))
    for (let i = stepTo(h, dir); i !== null; i = stepTo(h, dir)) {
      const e = h.entries[i]!
      if (e.path !== STDIN && !existsSync(e.path)) { // the piped document is relative, never on disk
        gone.push(`“${name(e.path)}” is gone`)
        h = drop(h, i)
        continue
      }
      const history = go(h, i, here())
      if (e.pos) scrolls.current.set(e.pos.key, { top: e.pos.top, geo: e.pos.geo })
      openFile(e.path, "history")
      set({ history: derive().sideFocus ? history : keep(history) }) // reached with document focus: read, not previewed
      return flash([...gone, `${dir < 0 ? "back" : "forward"} · ${name(e.path)}`].join(" · "))
    }
    set({ history: h })
    flash(gone.length ? gone.join(" · ") : dir < 0 ? "no earlier note" : "no later note")
  }

  const labelType = (ch: string) => {
    const lb = liveLabels()
    if (!lb) return set({ labels: null })
    const typed = lb.typed + ch
    const left = narrowLabels(lb.labels, typed)
    if (!left.length) return set({ labels: null })
    if (left.length === 1 && lb.labels[left[0]!] === typed) {
      const link = derive().view.links?.[lb.spots[left[0]!]!.link]
      set({ labels: null })
      if (link) followLink(link)
      return
    }
    set({ labels: { ...lb, typed } })
  }

  const startFilter = () => set({ filterTyping: true })
  /** The filter text of the shown view (Files or Outline). */
  const filterText = () => (ui.current.view === "outline" ? ui.current.outlineFilter : ui.current.filter)
  const filterType = (v: string) => {
    clearTimeout(timers.current.open) // a preview armed for the old results must not fire
    set(ui.current.view === "outline" ? { outlineFilter: v, outlineCur: 0 } : { filter: v })
  }
  /** Leave typing; `clear` also empties the shown view's filter. */
  const filterStop = (clear: boolean) => {
    clearTimeout(timers.current.open)
    set({ filterTyping: false, ...(clear ? (ui.current.view === "outline" ? { outlineFilter: "" } : { filter: "" }) : {}) })
  }

  /** Scroll so match line `m` sits a third of the way down (on the reading line in typewriter), and make it current. */
  const showMatch = (m: number) => {
    stopRolling()
    ui.current.matchLine = m
    const d = derive()
    setTop(d.tw || d.pg ? m : m - Math.floor(d.L.CH / 3))
  }

  const jumpMatch = (dir: 1 | -1) => {
    const { matches, win, L, s, pg } = derive()
    // pages: only the current page's own lines count as on screen (not the blank pad above it)
    const m = pg
      ? stepMatch(matches, s.matchLine, pg.top, Math.min(L.CH, pg.end - pg.top), dir)
      : stepMatch(matches, s.matchLine, win.first, L.CH, dir)
    if (m === undefined) return s.query ? flash(`no match for “${s.query}”`, "error") : flash("nothing to find · / to search", "error")
    showMatch(m)
  }

  const jumpHeading = (dir: 1 | -1) => {
    const { view, top } = derive()
    const hs = view.headings
    const target = dir === 1 ? hs.find((h) => h.line > top) : hs.findLast((h) => h.line < top)
    if (target) setTop(target.line)
  }

  /** Scroll the document to heading `i` of the shown view; `peek` keeps the panel focused. */
  const outlineGo = (i: number, peek = false) => {
    const d = derive()
    const h = d.view.headings[i]
    if (!h) return
    setTop(h.line)
    if (!peek) {
      set({ outlineFilter: "", filterTyping: false })
      focusDoc()
    }
  }

  /** Scroll to change `at` of the Changed block: the reply's quote when it is in that section, else its heading. */
  const jumpChange = (at: number) => {
    const { cv, view, s } = derive()
    const c = cv?.changes[at]
    if (!c || c.status === "removed") return
    const hs = view.headings
    // rows listed while a request runs come from the sent text: a heading that moved is found again by key
    const i = c.index < 0 || headingKey(hs[c.index]?.text ?? "") === c.key ? c.index : (findHeading(hs, c.path.at(-1) ?? "") ?? c.index)
    const from = i < 0 ? 0 : (hs[i]?.line ?? 0)
    const to = hs[i + 1]?.line ?? view.lines.length
    const quote = cv!.notes[at]?.quote
    const line = quote ? findQuote(view.plain, from, to, quoteNeedle(quote, s.source)) : null
    setTop(line === null ? from : Math.max(from, line - 1))
    focusDoc()
  }

  // `t` picker: the app stays in its theme while you move (only the pane shows the candidate); ⏎ applies and saves, esc changes nothing
  const openTheme = () => set({ themePick: pickStart(themes[ui.current.themeIdx]!) })
  const closeTheme = () => set({ themePick: null })
  const themeSet = (p: ThemePick) => set({ themePick: p })
  /** ⏎ or a click: the candidate becomes the theme; with no row listed nothing happens */
  const applyTheme = () => {
    const p = ui.current.themePick
    if (!p || pickIndex(p, filterFamilies(p.q)) < 0) return
    const name = pickTheme(p).name
    set({ themeIdx: themes.findIndex((x) => x.name === name), themePick: null })
    if (persist({ theme: name })) flash(`theme · ${name}`, "ok")
  }

  /** Ghost chrome: show the zen top line now; it holds, fades in steps, then hides. */
  const pokeGhost = () => {
    set({ ghostAt: Date.now() })
    runFade("ghost", () => ui.current.ghostAt, GHOST_HOLD, () => set({ ghostAt: null }))
  }

  /** Show the key hints for context `c` now; they hold HINT_HOLD, then fade. */
  const pokeHints = (c: Ctx) => {
    set({ hintAt: Date.now(), hintCtx: c })
    runFade("hints", () => ui.current.hintAt, HINT_HOLD, () => set({ hintAt: null }))
  }

  /** Context id now: an open popup, else zen, else the panel view or the document. */
  const currentCtx = (): Ctx => {
    const s = ui.current
    if (s.themePick) return "theme"
    if (s.zenOrig !== null) return "zenSettings"
    if (s.opener) return "open"
    if (s.switcher) return "switch"
    if (s.prompt) return "prompt"
    if (liveLabels()) return "label"
    if (s.help) return "help"
    return derive().L.zen ? "zen" : docMode()
  }
  const hintsVisible = () => {
    const s = ui.current
    return s.hintAt !== null && s.hintCtx === currentCtx() && fadeStep(Date.now() - s.hintAt, HINT_HOLD) !== null
  }

  /** Zen on / off. Entering shows the Preview; only the settings persist, never the mode. */
  const toggleZen = (on = !ui.current.zen) => {
    stopRolling()
    clearTimeout(timers.current.ghost)
    const s = ui.current
    if (on && !s.zen && !s.source) { const d = derive(); zenBack.current = { key: d.scrollKey, top: d.top, geo: d.geo } }
    if (!on && zenBack.current) scrolls.current.set(zenBack.current.key, { ...zenBack.current })
    if (!on) zenBack.current = null
    if (on) ensureGlosses()
    else clearTimeout(timers.current.gloss)
    set({ zen: on, ghostAt: null, filterTyping: false, ...(on ? { drawerOpen: false, focus: "doc" as Focus, source: false } : { gloss: null }) })
    if (on && ui.current.zenCfg.ghost) pokeGhost()
  }
  /** Change zen settings (clamped); `save` writes them to the config at once. False when that save failed. */
  const setZen = (patch: Partial<ZenConfig>, save = false) => {
    const zenCfg = normalizeZen({ ...ui.current.zenCfg, ...patch })
    set({ zenCfg })
    // only the keys changed (as clamped): another instance's other settings stay
    const ok = !save || persist({ zen: Object.fromEntries(Object.keys(patch).map((k) => [k, zenCfg[k as keyof ZenConfig]])) })
    if (ui.current.rolling) startRolling() // pick up the new speed now, not after the pending line
    return ok
  }
  /** Pages flow: show page `i` (clamped) from its start. */
  const goPage = (i: number) => {
    const { ranges } = derive()
    setTop(ranges[clampIdx(i, ranges.length)]![0])
  }
  /** Manual scroll inside zen; a page only scrolls within its own section. */
  const zenScroll = (n: number) => {
    stopRolling()
    const { pg } = derive()
    if (pg) return setTop(Math.max(pg.start, Math.min(pg.top + n, pg.maxTop)))
    scrollBy(n)
  }
  // `Z` popup: live preview while editing, ⏎ saves, esc restores what was there before
  const openZenSettings = () => {
    const s = ui.current
    set({ zenOrig: { cfg: s.zenCfg, zen: s.zen, source: s.source }, zenRow: 0 })
    if (!s.zen || s.source) toggleZen(true)
  }
  const revertZen = () => {
    const o = ui.current.zenOrig
    if (!o) return
    set({ zenCfg: o.cfg, source: o.source, zenOrig: null })
    if (!o.zen) toggleZen(false)
  }
  const applyZen = () => {
    const was = ui.current.zenOrig?.cfg
    const cfg = ui.current.zenCfg
    set({ zenOrig: null })
    const changed = Object.fromEntries(Object.entries(cfg).filter(([k, v]) => was?.[k as keyof ZenConfig] !== v))
    if (persist({ zen: changed })) flash("zen settings saved", "ok")
  }
  const zenEdit = (row: number, dir: -1 | 0 | 1) => setZen(zenAdjust(ui.current.zenCfg, ZEN_ROWS[row]!, dir))

  /** The popup row Enter acts on when the highlight hasn't been moved. */
  const promptDefault = () => {
    const { matches, top } = derive()
    return Math.max(0, matches.findIndex((m) => m >= top))
  }
  const promptCount = () => derive().matches.length
  const promptHighlight = (hl: number) => {
    const pr = ui.current.prompt
    if (!pr) return
    const { L } = derive()
    const n = clampIdx(hl, promptCount())
    const top = keepVisible(pr.hl >= 0 ? pr.top : keepVisible(0, promptDefault(), L.PH, promptCount()), n, L.PH, promptCount())
    set({ prompt: { ...pr, hl: n, top } })
  }
  const promptType = (v: string) => set({ prompt: { ...ui.current.prompt!, value: v, hl: -1, top: 0 }, query: v, matchLine: null })
  const promptSubmit = (hl = ui.current.prompt?.hl ?? -1) => {
    if (!ui.current.prompt) return
    set({ prompt: null })
    // results land in the document, which takes focus so n / N work next
    focusDoc()
    const { matches, top, s } = derive()
    const m = hl >= 0 ? matches[hl] : (matches.find((x) => x >= top) ?? matches[0])
    if (m !== undefined) showMatch(m)
    else if (s.query) flash(`no match for “${s.query}”`, "error")
  }
  const promptClose = () => {
    if (ui.current.prompt) set({ prompt: null, query: "", matchLine: null })
  }

  /** Abort a running ask (tier 0 or 1): nobody would see its result. */
  const dropAsk = () => {
    const job = jobs.current.get(jobKey("ask"))
    if (!job) return
    job.abort.abort()
    jobs.current.delete(jobKey("ask"))
  }
  const closeSwitcher = () => {
    dropAsk()
    set({ switcher: null })
  }
  /** New query: the highlight goes back to the first hit; a changed query drops the answers and aborts their request. */
  const swType = (q: string) => {
    if (ui.current.switcher?.q !== q) dropAsk()
    set({ switcher: { q, hl: 0, top: 0 } })
    set({ switcher: { q, hl: Math.max(0, firstHit(derive().swRows)), top: 0 } })
  }
  /** New ask state for the open switcher; the highlight goes to its first stop. */
  const setAsk = (ask: AskState | undefined) => {
    const sw = ui.current.switcher
    if (!sw) return
    set({ switcher: { ...sw, ask, hl: 0, top: 0 } })
    set({ switcher: { ...ui.current.switcher!, hl: Math.max(0, firstHit(derive().swRows)) } })
  }
  /**
   * `⏎` on the ask row (tier 0): only the question goes out; the model's queries come back and
   * the answers are sections the local index finds for them. Applied only to the same query string.
   */
  const askStart = () => {
    const sw = ui.current.switcher
    const qn = sw ? questionOf(sw.q) : null
    if (!sw || !qn || [...qn.text].length < ASK_MIN) return
    const ai = loadConfig().ai ?? null // re-read: editing config.json applies without a restart
    set({ ai })
    if (!ai) return flash(`AI off · set "ai" in config.json`)
    dropAsk() // at most one ask
    const question = qn.text
    const known = askMemo.current.get(foldSame(question))
    if (known) return setAsk({ question, phase: "result", queries: known.queries, model: known.model })
    if (jobs.current.size >= MAX_JOBS) {
      const busy = `AI busy · ${MAX_JOBS} requests running`
      flash(busy)
      return setAsk({ question, phase: "error", error: busy })
    }
    const target = resolveAI(ai, process.env)
    if ("error" in target) return flash(target.error, "error")
    const asked = sw.q
    const job = { kind: "ask" as const, raw: "", abort: new AbortController() }
    jobs.current.set(jobKey("ask"), job)
    setAsk({ question, phase: "asking" })
    void chat(target, { system: ASK_PROMPT, user: question, maxOut: 1000, clean: (r) => stripThink(r).trim() }, { fetch: fetchImpl, signal: job.abort.signal }).then((r) => {
      if (jobs.current.get(jobKey("ask")) !== job) return // aborted: edited, closed or asked again
      jobs.current.delete(jobKey("ask"))
      if (!alive.current || ui.current.switcher?.q !== asked) return
      const queries = r.ok ? parseQueries(r.raw) : null
      if (queries) {
        putNewest(askMemo.current, foldSame(question), { queries, model: ai.model }, ASK_MEMO)
        return setAsk({ question, phase: "result", queries, model: ai.model })
      }
      let f: Failure
      if (r.ok) f = { kind: "invalid" }
      else if ("failure" in r) f = r.failure
      else return
      const msg = aiError(f, { host: target.host, keyEnv: target.keyEnv, key: target.key, noun: "answer" })
      flash(msg, "error")
      setAsk({ question, phase: "error", error: msg })
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
    const user = rerankMessage(st.question, askCands, vault.current.ix)
    // keyed on exactly what would be sent, so an edited candidate is asked again
    const memoKey = `${textHash(ids.join("\n"))}\n${textHash(user)}`
    const known = rerankMemo.current.get(memoKey)
    if (known) return setAsk({ ...st, phase: "reranked", order: known.order, why: known.why })
    const ai = loadConfig().ai ?? null
    set({ ai })
    if (!ai) return flash(`AI off · set "ai" in config.json`)
    dropAsk()
    if (jobs.current.size >= MAX_JOBS) return flash(`AI busy · ${MAX_JOBS} requests running`)
    const target = resolveAI(ai, process.env)
    if ("error" in target) return flash(target.error, "error")
    const asked = sw.q
    const job = { kind: "ask" as const, raw: "", abort: new AbortController() }
    jobs.current.set(jobKey("ask"), job)
    setAsk({ ...st, phase: "reranking" })
    void chat(target, { system: RERANK_PROMPT, user, maxOut: 2000, clean: (r) => stripThink(r).trim() }, { fetch: fetchImpl, signal: job.abort.signal }).then((r) => {
      if (jobs.current.get(jobKey("ask")) !== job) return
      jobs.current.delete(jobKey("ask"))
      const now = ui.current.switcher
      if (!alive.current || now?.q !== asked || !now.ask) return
      const back: AskState = { ...now.ask, phase: "result" }
      // the index changed under the request: these ids are no longer the list on screen
      if (derive().askCands.map((c) => c.id).join("\n") !== ids.join("\n")) return setAsk(back)
      if (!r.ok) {
        setAsk(back)
        if ("failure" in r) flash(aiError(r.failure, { host: target.host, keyEnv: target.keyEnv, key: target.key, noun: "answer" }), "error")
        return
      }
      const picked = parseRerank(r.raw, ids.length)
      if (!picked) {
        setAsk(back)
        return flash("AI: no usable ranking")
      }
      const order = picked.map((p) => ids[p.i]!)
      const why = Object.fromEntries(picked.map((p) => [ids[p.i]!, p.why]))
      putNewest(rerankMemo.current, memoKey, { order, why, model: ai.model }, RERANK_MEMO)
      setAsk({ ...now.ask, phase: "reranked", order, why })
    })
  }
  /** Highlight row `hl`, scrolling so it (and its section title, when it is the first hit) stays in view. */
  const swGo = (hl: number) => {
    const sw = ui.current.switcher
    if (!sw) return
    const { swRows: rows, L } = derive()
    const head = rows[hl - 1]?.kind === "header" ? hl - 1 : hl
    set({ switcher: { ...sw, hl, top: keepVisible(keepVisible(sw.top, head, L.PH, rows.length), hl, L.PH, rows.length) } })
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
    // Source rows map to source lines; Preview has no such map, so the hit is found by counting
    // matches from the start of its section
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

  /**
   * Write the workspace to the recents: the open note and its Preview top with the geometry it was
   * taken at, so a reopen at another width remaps it (best effort). Zen not moved in still holds
   * the Preview's own spot in `zenBack`.
   */
  const recordProject = () => {
    const s = ui.current
    if (s.piped) return
    const key = `${s.openPath}:preview`
    const spot = !s.openPath ? undefined : zenBack.current?.key === key ? zenBack.current : scrolls.current.get(key)
    const pos = spot ? { top: spot.top, geo: spot.geo } : { top: 0 }
    saveProjects(rememberProject(loadProjects(), { root: projectRoot(s), lastNote: s.openPath, ...pos, at: Date.now() }))
  }
  /** The last record, on the way out: `q`, C-c and the renderer's end (OpenTUI's exit signals) all come here, once. */
  const leave = () => {
    if (left.current) return
    left.current = true
    recordProject()
  }

  /**
   * Make `root` the workspace, opening `note` (when it still exists) at Preview line `top`; a
   * `single` note (opened on its own, as from the CLI) links through its vault. Every workspace
   * rebuild goes through here: tree, link tree, switcher index, watcher, history.
   */
  const switchWorkspace = (root: string, note?: string | null, top = 0, single = false, geo?: Geometry) => {
    try {
      if (!statSync(root).isDirectory()) return flash(`not a folder: ${tildify(root)}`, "error")
    } catch (e) {
      return flash(`cannot open ${tildify(root)}: ${errText(e)}`, "error")
    }
    const keepNote = note && existsSync(note) ? note : null
    dropAsk() // the big set below closes the switcher
    recordProject()
    clearTimeout(timers.current.open)
    stopRolling()
    zenBack.current = null
    dropIndex() // a build still running sees it is stale and stops
    dropDelta() // even when `o` reopens the same note: the effect takes a fresh baseline
    sidebarSeen.current = { rows: null, cursorPath: null }
    const w = workspace(root, keepNote, single && !!keepNote)
    const s = ui.current
    set({
      ...w,
      filter: "",
      filterTyping: false,
      cursor: 0,
      listTop: { files: 0, outline: 0, info: 0 },
      infoSeen: "",
      outlineFilter: "",
      outlineCur: 0,
      infoCur: 0,
      query: "",
      matchLine: null,
      labels: null,
      prompt: null,
      switcher: null,
      opener: null,
      focus: "doc",
      drawerOpen: false,
      reloadedAt: null,
      recent: w.openPath ? [w.openPath] : [],
      history: startHistory(w.openPath),
      reload: s.reload + 1,
      watchGen: s.watchGen + 1,
    })
    if (w.openPath && keepNote && top > 0) {
      // the Preview entry, whatever is shown: derive clamps it and remaps it from the recorded geometry
      scrolls.current.set(`${w.openPath}:preview`, { top, geo: geo ?? memo.geo(derive().doc) })
      bump((x) => x + 1)
    }
    recordProject()
    flash(`opened ${projectName(projectRoot(ui.current))}`)
  }

  /** New query: the highlight goes back to the first row. */
  const opType = (q: string) => {
    const op = ui.current.opener
    if (!op) return
    set({ opener: { ...op, q, hl: 0, top: 0 } })
    set({ opener: { ...ui.current.opener!, hl: Math.max(0, firstHit(derive().opRows)) } })
  }
  const opGo = (hl: number) => {
    const op = ui.current.opener
    if (!op) return
    const { opRows: rows, L } = derive()
    const head = rows[hl - 1]?.kind === "header" ? hl - 1 : hl
    set({ opener: { ...op, hl, top: keepVisible(keepVisible(op.top, head, L.PH, rows.length), hl, L.PH, rows.length) } })
  }
  const openOpener = () => {
    set({ labels: null, opener: { q: "", hl: 0, top: 0, list: loadProjects() } })
    opType("")
  }
  /** `tab`: a path row's completion (a recent's folder) becomes the query. */
  const opComplete = () => {
    const { opRows, opHl } = derive()
    const r = opRows[opHl]
    if (r?.kind === "path") opType(r.completion)
    else if (r?.kind === "recent") opType(tildify(r.entry.root) + "/")
  }
  /** Open a row: a recent at its last note, a folder as the workspace, a note as a single note. */
  const opOpen = (r: OpenRow | undefined) => {
    const op = ui.current.opener
    if (!op || !r || r.kind === "header") return
    if (r.kind === "recent") {
      if (r.missing) {
        const list = op.list.filter((e) => e.root !== r.entry.root)
        saveProjects(loadProjects().filter((e) => e.root !== r.entry.root))
        set({ opener: { ...op, list } })
        opType(op.q)
        return flash(`“${r.name}” is gone`, "error")
      }
      return switchWorkspace(r.entry.root, r.entry.lastNote, r.entry.top, false, r.entry.geo)
    }
    if (r.dir) return switchWorkspace(r.path)
    switchWorkspace(dirname(r.path), r.path, 0, true)
  }

  /** The welcome page's recent rows (header first) and how many of them are on screen. */
  const welcomeRows = () => {
    const rows = memo.recents(ui.current.root, welcome.current.gen, ui.current.watchGen)
    const { L } = derive()
    return { rows, shown: rows.length ? welcomeFit(L.CW, L.CH, rows.length - 1).recents : 0 }
  }
  /** Welcome: open recent row `i` (row 0 is the header); a missing folder is dropped from the list instead. */
  const welcomeOpen = (i: number) => {
    const r = welcomeRows().rows[i]
    if (!r || r.kind !== "recent") return
    if (r.missing) {
      saveProjects(loadProjects().filter((e) => e.root !== r.entry.root))
      welcome.current.gen++
      return flash(`“${r.name}” is gone`, "error")
    }
    switchWorkspace(r.entry.root, r.entry.lastNote, r.entry.top, false, r.entry.geo)
  }
  /** Welcome keys: ↑ ↓ move the selection over the rows on screen, ⏎ opens it. */
  const welcomeKey = (k: KeyEvent) => {
    const { shown } = welcomeRows()
    if (!shown) return false
    const w = welcome.current
    if (k.name === "up" || k.name === "down") w.hl = Math.max(1, Math.min(shown, w.hl + (k.name === "down" ? 1 : -1)))
    else if (k.name === "return" || k.name === "enter") welcomeOpen(w.hl)
    else return false
    bump((x) => x + 1)
    return true
  }

  const helpGo = (n: number) => {
    const l = helpLayout(HELP_GROUPS, dims.current.W, dims.current.H)
    set({ helpTop: Math.max(0, Math.min(l.rows - l.vis, n)) })
  }

  // ---------------------------------------------------- live reload
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

  // welcome: the wordmark and bowl ink in once (INK_MS frames) and the steam rises every STEAM_MS, until a key,
  // a resize or a note opening stops it for good (`stopWelcome`); with motion off it is drawn still and inked
  const stopWelcome = () => {
    const w = welcome.current
    if (w.run !== "live") return
    w.run = "done"
    w.ink = INK_STEPS - 1
    clearTimeout(timers.current.steam)
    timers.current.steam = undefined
    bump((x) => x + 1) // a key that changes nothing else still shows the inked art
  }
  useEffect(() => {
    const w = welcome.current
    if (ui.current.openPath || (w.run === "live" && (w.W !== W || w.H !== H))) return stopWelcome()
    if (w.run !== "idle" || !ui.current.motion) return
    Object.assign(w, { run: "live", tick: 0, ink: 0, at: Date.now(), W, H })
    bump((x) => x + 1) // the first frame, in border
    const step = () => {
      timers.current.steam = undefined
      if (!alive.current || w.run !== "live") return
      const ms = Date.now() - w.at
      w.ink = Math.min(INK_STEPS - 1, Math.floor(ms / INK_MS))
      w.tick = Math.floor(ms / STEAM_MS)
      bump((x) => x + 1)
      timers.current.steam = setTimeout(step, w.ink < INK_STEPS - 1 ? INK_MS : STEAM_MS)
    }
    timers.current.steam = setTimeout(step, INK_MS)
  })
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

  // ---------------------------------------------------- keys
  const actions: Record<KeyId, (k: KeyEvent) => void> = {
    views: (k) => {
      const v = panelViews()[Number(k.name) - 1]
      if (!v) return
      if (derive().sideFocus) selectView(v)
      else focusPanel(v)
    },
    source: () => {
      set({ source: !ui.current.source, matchLine: null })
      pokeHints(currentCtx())
    },
    // the Source shown over zen (`z s`) is not zen on screen: z, w and esc go by the layout
    zen: () => toggleZen(!derive().L.zen),
    zenSettings: openZenSettings,
    sidebar: () => {
      const { L, sideFocus, s } = derive()
      if (L.mode === "drawer") return sideFocus ? focusDoc() : focusPanel()
      const hidden = !s.hidden
      set({ hidden, ...(hidden ? { focus: "doc" as Focus } : {}) })
      saveSidebar({ hidden })
    },
    width: () => {
      if (derive().L.zen) return // zen has its own measure (< >); full width is not shown there
      const wide = !ui.current.wide
      set({ wide })
      if (persist({ wide })) flash(wide ? "full width" : "measure 80")
    },
    minimap: () => {
      if (dims.current.W < MINI_MIN_W) return flash(`minimap needs ${MINI_MIN_W} columns`)
      const minimap = !ui.current.minimap
      set({ minimap })
      if (persist({ minimap })) flash(minimap ? "minimap on" : "minimap off")
    },
    headings: () => {
      const headings = HEADING_STYLES[(HEADING_STYLES.indexOf(ui.current.headings) + 1) % HEADING_STYLES.length]!
      set({ headings })
      if (persist({ headings })) flash(`headings · ${headings}`)
    },
    transparent: () => {
      const transparent = !ui.current.transparent
      set({ transparent })
      if (persist({ transparent })) flash(transparent ? "transparent background" : "opaque background")
    },
    switcher: openSwitcher,
    open: openOpener,
    slash: () => {
      const { sideFocus } = derive()
      if (!sideFocus) return set({ prompt: { value: "", hl: -1, top: 0 } })
      if (sideFocus === "info") selectView("files")
      startFilter()
    },
    focus: () => (derive().sideFocus ? focusDoc() : focusPanel()),
    theme: openTheme,
    reload: () => {
      const s = ui.current
      const piped = s.piped
      const tree = piped ? s.tree : scanTree(s.root)
      // folders that are gone are forgotten; the open note's path stays open
      const folders = folderCounts(tree)
      const expanded = new Set([...s.expanded].filter((p) => folders.has(p)))
      if (s.openPath) for (const a of ancestorsOf(tree, s.openPath)) expanded.add(a)
      const linkTree = piped ? (s.linkLazy ? s.linkTree : scanTree(s.root)) : s.linkRoot ? scanTree(s.linkRoot) : tree
      set({ tree, linkTree, expanded, reload: s.reload + 1, watchGen: s.watchGen + 1, ai: loadConfig().ai ?? null })
      if (ui.current.zen) ensureGlosses()
      dropIndex()
      flash("reloaded")
    },
    clear: () => {
      const { s, sideFocus, sheet } = derive()
      if (sideFocus) {
        if (sideFocus === "files" && s.filter) return set({ filter: "" })
        if (sideFocus === "outline" && s.outlineFilter) return set({ outlineFilter: "" })
        return focusDoc()
      }
      // a gloss on screen goes first; it stays hidden until the reading line leaves its section (a fading one falls through)
      if (sheet && sheet.fadeAt === null) return set({ gloss: null })
      if (s.toast?.kind === "error") set({ toast: null })
      if (s.query) set({ query: "", matchLine: null })
      else if (derive().L.zen) toggleZen(false)
    },
    // the welcome page shows no hints, so ? opens the sheet at once
    help: () => (hintsVisible() || !ui.current.openPath ? set({ help: true, helpTop: 0 }) : pokeHints(currentCtx())),
    histBack: () => histMove(-1),
    histForward: () => histMove(1),
    summarize: () => {
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
    },
    explainChange: () => {
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
    },
    edit: () => {
      const s = ui.current
      if (!s.openPath) return flash("no note to edit", "error")
      if (s.openPath === STDIN) return flash("stdin · nothing to edit")
      const d = derive()
      const src = memo.read(s.openPath, s.reload)?.src ?? ""
      const line = sourceLineAt({ source: s.source, top: d.top, srcRow: d.view.srcRow, headings: d.view.headings, scan: sourceScan(src, themes[s.themeIdx]!).headings, offset: parseFrontMatter(src).offset })
      const argv = editorCommand(process.env, s.openPath, line)
      const run =
        editImpl ??
        ((a: string[], piped: boolean) =>
          runEditor(a, piped, {
            openTTY: () => openSync("/dev/tty", "r"),
            close: closeSync,
            spawn: (argv, stdin) => Bun.spawnSync(argv, { stdio: [stdin, "inherit", "inherit"] }),
            suspend: () => renderer.suspend(),
            resume: () => renderer.resume(),
          }))
      let res: EditResult | void
      try {
        res = run(argv, s.piped)
      } catch (e) {
        return flash(`cannot run ${argv[0]}: ${errText(e)}`, "error")
      }
      if (res && "error" in res) return flash(res.error, "error")
      set({ reload: s.reload + 1 }) // a failed editor may still have saved
      const ed = basename(argv[0]!)
      if (res && res.code !== 0) return flash(res.signal ? `${ed} ended by ${res.signal}` : `${ed} exited with ${res.code}`, "error")
      flash(`edited · ${basename(s.openPath)}`)
    },
    quit: () => {
      leave()
      renderer.destroy()
      process.exit(0)
    },

    docLine: (k) => scrollBy(isDown(k) ? 1 : -1),
    docHalf: (k) => scrollBy((isDown(k) ? 1 : -1) * Math.max(1, Math.floor(derive().L.CH / 2))),
    docPage: (k) => scrollBy((isDown(k) ? 1 : -1) * (derive().L.CH - 2)),
    docEnds: (k) => setTop(k.name === "g" && !k.shift ? 0 : k.name === "home" ? 0 : derive().maxTop),
    docHeading: (k) => jumpHeading(k.sequence === "]" || k.sequence === "}" ? 1 : -1),
    docMatch: (k) => jumpMatch(k.shift ? -1 : 1),
    back: () => focusPanel(),
    links: startLabels,
    labelType: () => {},
    labelErase: () => {
      const lb = ui.current.labels
      if (lb) set({ labels: { ...lb, typed: lb.typed.slice(0, -1) } })
    },
    labelCancel: () => set({ labels: null }),

    zenLine: (k) => zenScroll(isDown(k) ? 1 : -1),
    zenHalf: (k) => zenScroll((isDown(k) ? 1 : -1) * Math.max(1, Math.floor(derive().L.CH / 2))),
    zenPage: (k) => {
      const { pg, L, prompter } = derive()
      if (k.name === "space" && prompter) return ui.current.rolling ? stopRolling() : startRolling()
      const step = L.CH - 2
      if (!pg) return zenScroll((isDown(k) ? 1 : -1) * step)
      // a tall page scrolls to its end first, then the next press flips
      if (isDown(k)) {
        if (pg.top < pg.maxTop) zenScroll(step)
        else goPage(pg.index + 1)
      } else if (pg.top > pg.start) zenScroll(-step)
      else goPage(pg.index - 1)
    },
    zenEnds: (k) => {
      stopRolling()
      const toTop = (k.name === "g" && !k.shift) || k.name === "home"
      if (derive().pg) return goPage(toTop ? 0 : Infinity)
      setTop(toTop ? 0 : derive().maxTop)
    },
    zenGloss: () => {
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
    },
    zenSection: (k) => {
      stopRolling()
      const dir = k.sequence === "]" || k.sequence === "}" ? 1 : -1
      const { pg } = derive()
      if (pg) goPage(pg.index + dir)
      else jumpHeading(dir)
    },
    zenMeasure: (k) => {
      if (setZen({ measure: stepMeasure(ui.current.zenCfg.measure, k.sequence === ">" ? 1 : -1) }, true)) flash(`measure ${ui.current.zenCfg.measure}`)
    },
    zenSpeed: (k) => {
      if (setZen({ wpm: ui.current.zenCfg.wpm + (k.sequence === "+" ? 1 : -1) * ZEN_WPM.step }, true)) flash(`${ui.current.zenCfg.wpm} wpm`)
    },

    outlineMove: (k) => {
      const { outlineCur, oRows } = derive()
      const n = oRows.length
      const next = k.name === "g" ? (k.shift ? n - 1 : 0) : outlineCur + (isDown(k) ? 1 : -1)
      set({ outlineCur: clampIdx(next, n) })
    },
    outlineJump: () => {
      const { oRows, outlineCur } = derive()
      const r = oRows[outlineCur]
      if (r) outlineGo(r.index)
    },
    outlinePeek: () => {
      const { oRows, outlineCur } = derive()
      const r = oRows[outlineCur]
      if (r) outlineGo(r.index, true)
    },

    infoMove: (k) => {
      const { linkRows, infoRows, infoCur, LH, s } = derive()
      const max = Math.max(0, infoRows.length - LH)
      const scroll = (to: number) => set({ listTop: { ...s.listTop, info: Math.max(0, Math.min(max, to)) } })
      const toEdge = k.name === "g" ? (k.shift ? max : 0) : undefined
      const dir = isDown(k) ? 1 : -1
      if (!linkRows.length) return scroll(toEdge ?? s.listTop.info + dir)
      // at the first/last link the keys scroll the rest of the list into view
      const last = linkRows.length - 1
      if (k.name === "g" ? infoCur === (k.shift ? last : 0) : infoCur === (dir > 0 ? last : 0)) return scroll(toEdge ?? s.listTop.info + dir)
      set({ infoCur: clampIdx(k.name === "g" ? (k.shift ? last : 0) : infoCur + dir, linkRows.length) })
    },
    infoOpen: () => {
      const { infoRows, linkRows, infoCur } = derive()
      const it = infoRows[linkRows[infoCur] ?? -1]
      if (it?.kind === "link") openLink(it)
      else if (it?.kind === "change") jumpChange(it.at)
    },

    filesMove: (k) => {
      const { s, rows, LH } = derive()
      const half = Math.max(1, Math.floor(LH / 2))
      if (k.name === "g") return selectRow(k.shift ? rows.length - 1 : 0)
      if (k.name === "pagedown" || k.name === "d") return selectRow(s.cursor + half)
      if (k.name === "pageup" || k.name === "u") return selectRow(s.cursor - half)
      selectRow(s.cursor + (isDown(k) ? 1 : -1))
    },
    filesOpen: () => {
      const { s, rows } = derive()
      const row = rows[s.cursor]
      if (!row) return
      if (row.node.dir) return toggleDir(row.node)
      openFile(row.node.path)
      focusDoc()
    },
    filesPeek: () => {
      const { s, rows } = derive()
      const row = rows[s.cursor]
      if (!row) return
      if (row.node.dir) return toggleDir(row.node, true)
      openFile(row.node.path)
    },
    filesUp: () => {
      const { s, rows } = derive()
      const row = rows[s.cursor]
      if (!row) return
      if (row.node.dir && s.expanded.has(row.node.path)) return toggleDir(row.node, false)
      const pi = rows.findIndex((r) => r.node.path === dirname(row.node.path))
      if (pi >= 0) selectRow(pi, "no")
    },
    filesTidy: () => {
      const s = ui.current
      set({ expanded: new Set(s.openPath ? ancestorsOf(s.tree, s.openPath) : []) })
    },

    filterType: () => {},
    filterMove: (k) => {
      const dn = k.name === "down" || k.name === "n"
      if (ui.current.view === "outline") {
        const { oRows, outlineCur } = derive()
        return set({ outlineCur: clampIdx(outlineCur + (dn ? 1 : -1), oRows.length) })
      }
      selectRow(ui.current.cursor + (dn ? 1 : -1))
    },
    filterOpen: () => {
      if (ui.current.view === "outline") {
        const { oRows, outlineCur } = derive()
        const r = oRows[outlineCur]
        filterStop(true)
        if (r) outlineGo(r.index)
        return
      }
      const { rows, s } = derive()
      const row = rows[s.cursor]
      filterStop(false)
      if (row && !row.node.dir) {
        openFile(row.node.path)
        focusDoc()
      }
    },
    filterClear: () => filterStop(true),
    filterLeave: () => {
      filterStop(false)
      focusDoc()
    },
    filterErase: () => {
      const v = filterText()
      if (!v) return filterStop(true)
      filterType([...v].slice(0, -1).join(""))
    },

    helpScroll: (k) => {
      const vis = helpLayout(HELP_GROUPS, dims.current.W, dims.current.H).vis
      const top = ui.current.helpTop
      if (k.name === "g" || k.name === "home") return helpGo(k.shift ? Infinity : 0)
      if (k.name === "end") return helpGo(Infinity)
      const page = ["space", "pagedown", "b", "pageup"].includes(k.name) || k.ctrl
      helpGo(top + (isDown(k) ? 1 : -1) * (page ? vis - 1 : 1))
    },
    helpClose: () => set({ help: false }),

    promptMove: (k) => {
      const pr = ui.current.prompt!
      if (promptCount() > 0) promptHighlight((pr.hl >= 0 ? pr.hl : promptDefault()) + (k.name === "down" ? 1 : -1))
    },
    promptApply: () => promptSubmit(),
    promptClear: promptClose,
    promptErase: () => promptType([...ui.current.prompt!.value].slice(0, -1).join("")),
    swType: () => {},
    swMove: (k) => {
      const { swRows, swHl } = derive()
      swGo(stepRow(swRows, swHl, k.name === "down" || (k.ctrl && k.name === "n") ? 1 : -1))
    },
    swSection: () => {
      const { swRows, swHl, question } = derive()
      swGo(question ? askSection(swRows, swHl) : nextSection(swRows, swHl))
    },
    swOpen: () => swActivate(derive().swHl),
    swClose: closeSwitcher,
    swErase: () => {
      const sw = ui.current.switcher
      if (sw) swType([...sw.q].slice(0, -1).join(""))
    },
    swAsk: () => {}, // help only: a `?` query is typed like any other
    opType: () => {},
    opMove: (k) => {
      const { opRows, opHl } = derive()
      opGo(stepRow(opRows, opHl, k.name === "down" || (k.ctrl && k.name === "n") ? 1 : -1))
    },
    opComplete,
    opOpen: () => {
      const { opRows, opHl } = derive()
      opOpen(opRows[opHl])
    },
    opClose: () => set({ opener: null }),
    opErase: () => {
      const op = ui.current.opener
      if (op) opType([...op.q].slice(0, -1).join(""))
    },

    themeType: () => {},
    themeMove: (k) => themeSet(pickMove(ui.current.themePick!, k.name === "down" || (k.ctrl && k.name === "n") ? 1 : -1)),
    // ← → move across the board (dark / light), tab and S-tab flip; a single-mode family stays put (pickMode)
    themeMode: (k) => themeSet(pickMode(ui.current.themePick!, k.name === "left" ? "dark" : k.name === "right" ? "light" : undefined)),
    themeApply: applyTheme,
    themeClose: closeTheme,
    themeErase: () => {
      const p = ui.current.themePick!
      themeSet(pickQuery(p, [...p.q].slice(0, -1).join("")))
    },

    zsMove: (k) => set({ zenRow: clampIdx(ui.current.zenRow + (isDown(k) ? 1 : -1), ZEN_ROWS.length) }),
    zsToggle: () => zenEdit(ui.current.zenRow, 0),
    zsAdjust: (k) => zenEdit(ui.current.zenRow, k.name === "right" || k.name === "l" ? 1 : -1),
    zsSave: applyZen,
    zsRevert: revertZen,
  }

  /** Run the first binding of the given modes (in order) that matches `k`; `skip` bindings are ignored. */
  const dispatch = (modes: Mode[], k: KeyEvent, skip: readonly KeyId[] = []) => {
    for (const m of modes)
      for (const id of KEY_IDS) {
        if (skip.includes(id)) continue
        const def = keyDef(id)
        if (def.modes.includes(m) && def.keys.some((spec) => matchKey(spec, k))) {
          actions[id](k)
          return true
        }
      }
    return false
  }

  useKeyboard((key: KeyEvent) => {
    // C-c quits the same way from every popup and mode (OpenTUI would only end the renderer)
    if (matchKey("C-c", key)) return actions.quit(key)
    stopWelcome()
    const s = ui.current
    if (s.zen && s.zenCfg.ghost) pokeGhost()
    if (s.themePick) {
      if (dispatch(["theme"], key)) return
      if (key.sequence && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/.test(key.sequence)) themeSet(pickQuery(s.themePick, s.themePick.q + key.sequence))
      return
    }
    if (s.zenOrig !== null) return void dispatch(["zenSettings"], key)
    if (s.opener) {
      if (dispatch(["open"], key)) return
      if (key.sequence && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/.test(key.sequence)) opType(s.opener.q + key.sequence)
      return
    }
    if (s.switcher) {
      if (dispatch(["switch"], key)) return
      if (key.sequence && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/.test(key.sequence)) swType(s.switcher.q + key.sequence)
      return
    }
    if (s.prompt) {
      if (dispatch(["prompt"], key)) return
      if (key.sequence && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/.test(key.sequence))
        promptType(s.prompt.value + key.sequence)
      return
    }
    // labels the view has moved out from under (reload, resize, scroll) are dropped and the key is swallowed, like any other that cancels
    if (s.labels && !liveLabels()) return void set({ labels: null })
    if (s.labels) {
      if (dispatch(["label"], key)) return
      if (key.sequence && !key.ctrl && !key.meta && /^[a-z]$/.test(key.sequence)) return labelType(key.sequence)
      return void set({ labels: null }) // any other key cancels
    }
    if (s.help) {
      if (!dispatch(["help"], key)) set({ help: false })
      return
    }
    // the panel filter row captures typing, j k 1 2 3 / ? included
    if (s.filterTyping && derive().sideFocus) {
      if (dispatch(["filter"], key)) return
      if (key.sequence && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/.test(key.sequence)) filterType(filterText() + key.sequence)
      return
    }
    // zen bindings shadow the document ones; n / N and the global keys fall through
    if (derive().L.zen) return void dispatch(["zen", "global", "doc"], key, ZEN_OFF)
    if (!s.openPath && docMode() === "doc" && welcomeKey(key)) return
    dispatch(["global", modeOf(docMode())], key, s.openPath ? undefined : WELCOME_OFF)
  })

  // ---------------------------------------------------- render
  const d = derive()
  const { s, L, t, file, view, rows, filtered, total, filterRow, infoRows, linkRows, swRows, swHl, question, LH, note, top, maxTop, matches, currentHeading, sideFocus, outlineCur, tw, pg, spot, win, sheet } = d
  const { SW, bodyH, CW, CH, padL } = L
  const { filter, cursor, query, prompt, help } = s

  // a note reached through a link outside the opened folder is named from its vault's root
  const outside = openPath !== null && s.linkRoot !== null && relative(s.root, openPath).startsWith("..")
  const rel = openPath ? relative(outside ? s.linkRoot! : s.root, openPath) : ""
  const paint = surface(t, s.transparent)
  const selFg = contrastOn(t.primary)

  // panel: tab strip, rule, then the current view's list; one cursor, drawn only while focused
  const PNW = L.PNW
  /** text columns: col 0 is padding, the last column is kept for the scroll thumb */
  const AW = PNW - 2
  const thumbFg = mix(t.borderSubtle, t.textMuted, 0.25)
  /** One panel row, `PNW` wide: col 0 padding (`lead`), text, then the thumb column. `sel` fills the row as the cursor. */
  const panelRow = (
    key: string,
    spans: Span[],
    o: { sel?: boolean; lead?: boolean; thumb?: boolean; onDown?: (e: MouseEvent) => void } = {},
  ) => {
    const body: Span[] = o.lead === false ? [...spans] : [{ text: " " }, ...spans]
    body.push({ text: " ".repeat(Math.max(0, PNW - 1 - spansWidth(body))) })
    const cells = o.sel ? body.map((sp) => ({ ...sp, fg: selFg, bg: t.primary })) : body
    cells.push({ text: o.thumb ? "▐" : " ", fg: thumbFg })
    return (
      <box key={key} style={{ height: 1, flexShrink: 0 }} onMouseDown={o.onDown}>
        <Row spans={cells} />
      </box>
    )
  }
  /** Which visible list rows (0 = first) carry the scroll thumb. */
  const thumbRows = (top: number, n: number) => {
    const th = thumb(top, LH, n)
    return (i: number) => !!th && i >= th.start && i < th.start + th.size
  }

  // the strip's compact/full choice follows the inline panel width (SW), also in the wider drawer
  const strip = stripLayout(L.SW, panelViews())
  const stripSpans: Span[] = []
  for (const lb of strip.labels) {
    const at = 1 + spansWidth(stripSpans) // panelRow adds col 0
    if (lb.x0 > at) stripSpans.push({ text: " ".repeat(lb.x0 - at) })
    stripSpans.push({ text: lb.digit, fg: t.textMuted })
    const active = lb.view === s.view
    stripSpans.push({ text: lb.text, fg: active ? (sideFocus ? t.primary : t.text) : t.textMuted, attr: active ? 1 : 0 })
  }
  const activeLabel = strip.labels.find((lb) => lb.view === s.view) ?? strip.labels[0]!
  const rule: Span[] = [
    { text: "─".repeat(activeLabel.lx), fg: t.border },
    { text: "━".repeat(activeLabel.x1 - activeLabel.lx), fg: sideFocus ? t.accent : t.textMuted },
    { text: "─".repeat(Math.max(0, PNW - 1 - activeLabel.x1)), fg: t.border },
  ]
  const panelX = L.inline ? 1 : 0
  const onStrip = (e: MouseEvent) => {
    if (e.button !== MouseButton.LEFT) return
    const x = e.x - panelX
    const lb = strip.labels.find((l) => x >= l.x0 && x < l.x1)
    if (lb) focusPanel(lb.view)
  }

  /** `text` with the code points at `hits` drawn as matches (primary, bold). */
  const hitSpans = (text: string, hits: number[], fg: string, bold: boolean): Span[] => markHits(text, hits, fg, t.primary, bold)
  /** The filter row: `/ query▏` (caret while typing), with `right` aligned to the text edge. */
  const filterRowEl = (value: string, typing: boolean, right: string) => {
    const left: Span[] = [{ text: "/ ", fg: t.primary, attr: 1 }, { text: truncate(value, Math.max(1, AW - 4 - sw(right))), fg: t.text }]
    if (typing) left.push({ text: "▏", fg: t.primary })
    return panelRow("filter", [...left, { text: " ".repeat(Math.max(1, AW - spansWidth(left) - sw(right))) }, { text: right, fg: t.textMuted }])
  }
  /** Last folder of a note's relative path ("" at the root). */
  const folderOf = (n: FileNode) => (n.rel.includes(sep) ? basename(dirname(n.rel)) : "")

  const topOf = (v: View, n: number) => Math.max(0, Math.min(s.listTop[v], n - LH))
  const listEls: ReactNode[] = []
  if (s.view === "files") {
    const fTop = topOf("files", rows.length)
    if (rows.length === 0)
      listEls.push(panelRow("files-empty", [{ text: filter ? "no matching notes" : "no Markdown files here", fg: t.textMuted }]))
    const counts = folderCounts(s.tree)
    const on = thumbRows(fTop, rows.length)
    rows.slice(fTop, fTop + LH).forEach((r, i) => {
      const idx = fTop + i
      const n = r.node
      const indent = "  ".repeat(Math.min(r.depth, MAX_DEPTH))
      // a symlink that leaves the folder is marked after its name
      const mark: Span[] = n.outside ? [{ text: " ↗", fg: t.textMuted }] : []
      const room = AW - sw(indent) - 2 - spansWidth(mark)
      const spans: Span[] = [{ text: indent }]
      if (n.dir) {
        const open = s.expanded.has(n.path)
        spans.push({ text: open ? "▾ " : "▸ ", fg: t.borderSubtle })
        // a closed folder shows its note count at the right edge; the count goes before the name is cut
        const count = open ? "" : String(counts.get(n.path) ?? 0)
        const name = truncate(n.name, room)
        spans.push({ text: name, fg: t.textMuted }, ...mark)
        if (count && sw(n.name) + 1 + sw(count) <= room)
          spans.push({ text: " ".repeat(room - sw(name) - sw(count)) }, { text: count, fg: t.textMuted })
      } else if (r.hits) {
        const isOpen = n.path === openPath
        const shown = truncate(stem(n.name), AW - 2 - spansWidth(mark))
        const left = AW - 2 - sw(shown) - spansWidth(mark) - 1
        // a note's name is never cut for its folder; the folder shows only with 6+ columns to spare
        const seg = folderOf(n)
        const folder = seg && left >= 6 ? truncateLeft(seg, left) : ""
        spans.length = 0
        spans.push({ text: isOpen ? "● " : "  ", fg: t.primary }, ...hitSpans(shown, r.hits, isOpen ? t.primary : t.text, isOpen), ...mark)
        if (folder) spans.push({ text: " ".repeat(AW - 2 - sw(shown) - spansWidth(mark) - sw(folder)) }, { text: folder, fg: t.textMuted })
      } else {
        const isOpen = n.path === openPath
        spans.push({ text: isOpen ? "● " : "  ", fg: t.primary })
        spans.push({ text: truncate(stem(n.name), room), fg: isOpen ? t.primary : t.text, attr: isOpen ? 1 : 0 }, ...mark)
      }
      listEls.push(
        panelRow(n.path, spans, {
          sel: sideFocus === "files" && idx === cursor,
          thumb: on(i),
          onDown: (e) => {
            if (e.button !== MouseButton.LEFT) return
            focusPanel()
            if (n.dir) toggleDir(n)
            selectRow(idx, "now")
          },
        }),
      )
    })
    note.forEach((text, i) => listEls.push(panelRow(`files-truncated-${i}`, [{ text: truncate(text, AW), fg: t.warning }])))
  } else if (s.view === "outline") {
    const n = d.oRows.length
    if (!openPath) listEls.push(panelRow("outline-empty", [{ text: "no note open", fg: t.textMuted }]))
    else if (!n) listEls.push(panelRow("outline-empty", [{ text: s.outlineFilter ? "no matching headings" : "no headings", fg: t.textMuted }]))
    // unfocused, the list keeps the reading heading in view; focused, the cursor
    const reading = Math.max(0, d.oRows.findIndex((r) => r.current))
    const oTop = keepVisible(s.listTop.outline, sideFocus === "outline" ? outlineCur : reading, LH, n)
    s.listTop.outline = oTop
    const on = thumbRows(oTop, n)
    d.oRows.slice(oTop, oTop + LH).forEach((r, i) => {
      const base = r.current ? t.primary : r.level === 2 ? t.textMuted : t.text
      const fg = r.read ? mix(base, t.background, 0.35) : base
      const text = truncate(r.text, AW - 2 - r.indent)
      listEls.push(
        panelRow(`o-${r.index}`, [{ text: r.current ? "▸ " : "  ", fg: t.primary }, { text: " ".repeat(r.indent) }, ...hitSpans(text, r.hits, fg, r.current || r.level === 0)], {
          sel: sideFocus === "outline" && oTop + i === outlineCur,
          thumb: on(i),
          onDown: (e) => {
            if (e.button === MouseButton.LEFT) outlineGo(r.index)
          },
        }),
      )
    })
  } else {
    const pad = (k: string, w: number) => k + " ".repeat(Math.max(0, w - sw(k)))
    const infoSpans = (it: InfoItem): Span[] => {
      switch (it.kind) {
        case "prop":
          return [{ text: pad(it.key, it.keyW), fg: t.textMuted }, { text: it.text, fg: t.text }]
        case "chips":
          return [
            { text: pad(it.key, it.keyW), fg: t.textMuted },
            ...it.tags.flatMap((tg, i): Span[] => [...(i ? [{ text: " " }] : []), { text: truncate("#" + tg, AW - it.keyW), fg: t.secondary }]),
            ...(it.more ? [{ text: " …", fg: t.textMuted }] : []),
          ]
        case "label":
          return [{ text: it.text, fg: t.textMuted, attr: 1 }]
        case "tldr":
          return [{ text: "TL;DR", fg: t.textMuted, attr: 1 }, { text: it.status, fg: t.textMuted }]
        case "summary":
          return [{ text: it.text, fg: it.muted ? t.textMuted : t.text }]
        case "changes":
          return [{ text: "Changed", fg: t.textMuted, attr: 1 }, { text: it.status, fg: t.textMuted }]
        case "change":
          return [
            { text: it.mark + " ", fg: it.mark === "~" ? t.warning : it.mark === "+" ? t.success : t.textMuted },
            { text: it.text, fg: it.stop ? t.text : t.textMuted },
            { text: it.counts, fg: t.textMuted },
          ]
        case "link":
          return [
            { text: "→ ", fg: t.textMuted },
            { text: truncate(it.target, AW - 3 - (it.path ? 0 : 1)), fg: it.path ? t.info : t.textMuted },
            ...(it.path ? [] : [{ text: "?", fg: t.textMuted }]),
          ]
        case "more":
          return [{ text: `+${it.n} more`, fg: t.textMuted }]
        case "stat":
          return [{ text: truncate(it.text, AW), fg: t.textMuted }]
        case "blank":
          return []
      }
    }
    if (!openPath) listEls.push(panelRow("info-empty", [{ text: "no note open", fg: t.textMuted }]))
    else if (file?.error)
      wrap([{ text: file.error }], AW).forEach((r, i) => listEls.push(panelRow(`info-err-${i}`, [{ text: r.map((x) => x.text).join(""), fg: t.error }])))
    else {
      const items = infoRows
      const curItem = linkRows[d.infoCur] ?? -1
      // follow the cursor only when it moved; wheel and edge scrolling must stick
      const seen = `${sideFocus === "info"}:${openPath}:${d.infoCur}`
      const follow = sideFocus === "info" && curItem >= 0 && s.infoSeen !== seen
      const iTop = follow ? keepVisible(s.listTop.info, curItem, LH, items.length) : topOf("info", items.length)
      s.listTop.info = iTop
      s.infoSeen = seen
      const on = thumbRows(iTop, items.length)
      items.slice(iTop, iTop + LH).forEach((it, i) => {
        const idx = iTop + i
        listEls.push(
          panelRow(`info-${idx}`, infoSpans(it), {
            sel: sideFocus === "info" && idx === curItem,
            thumb: on(i),
            onDown:
              it.kind === "link" || (it.kind === "change" && it.stop)
                ? (e) => {
                    if (e.button !== MouseButton.LEFT) return
                    focusPanel()
                    set({ infoCur: linkRows.indexOf(idx) })
                    if (it.kind === "link") openLink(it)
                    else jumpChange(it.at)
                  }
                : undefined,
          }),
        )
      })
    }
  }

  const scrollList = (e: MouseEvent) => {
    const n = s.view === "files" ? rows.length : s.view === "outline" ? d.oRows.length : infoRows.length
    const dlt = e.scroll?.direction === "up" ? -3 : 3
    set({ listTop: { ...s.listTop, [s.view]: Math.max(0, Math.min(n - LH, topOf(s.view, n) + dlt)) } })
  }
  const cur = rows[cursor]
  // two results with the same name and folder: show the cursor row's full folder instead of the count
  const dup =
    filtered && cur && rows.some((r, i) => i !== cursor && stem(r.node.name) === stem(cur.node.name) && folderOf(r.node) === folderOf(cur.node))
  const filesRight = dup ? truncateLeft(dirname(cur!.node.rel), Math.max(4, AW - 8)) : filtered ? `${fmtNum(total)}${s.tree.truncated ? "+" : ""}` : ""
  const panelRows = [
    panelRow("strip", stripSpans, { onDown: onStrip }),
    panelRow("rule", rule, { lead: false }),
    ...(filterRow ? [filterRowEl(s.view === "outline" ? s.outlineFilter : filter, s.filterTyping && !!sideFocus, s.view === "outline" ? String(d.oRows.length) : filesRight)] : []),
    ...listEls,
  ]
  // distinct keys: the reconciler does not clear style props between the two boxes
  const panelBox = L.inline ? (
    <box key="side-inline" style={{ width: SW, height: bodyH, flexShrink: 0, flexDirection: "column", backgroundColor: paint.side }} onMouseScroll={scrollList}>
      {panelRows}
    </box>
  ) : (
    <box
      key="side-drawer"
      style={{ position: "absolute", left: 0, top: 1 + L.gap, zIndex: 5, width: PNW + 1, height: bodyH, flexDirection: "row" }}
    >
      <box
        style={{ width: PNW, height: bodyH, flexDirection: "column", backgroundColor: t.backgroundElement }}
        onMouseScroll={scrollList}
      >
        {panelRows}
      </box>
      <box style={{ width: 1, height: bodyH, flexDirection: "column", backgroundColor: t.background }}>
        {Array.from({ length: bodyH }, (_, i) => (
          <Row key={i} spans={[{ text: "▏", fg: t.border }]} />
        ))}
      </box>
    </box>
  )

  // document: borderless, wrapped at the reading measure and centered
  const scrim = L.mode === "drawer" && L.shown
  let content: ReactNode
  if (!openPath) {
    const { rows: recents, shown } = welcomeRows()
    const w = welcome.current
    w.hl = Math.max(1, Math.min(shown, w.hl))
    content = (
      <Welcome
        t={t}
        CW={L.CW}
        CH={L.CH}
        root={s.root}
        recents={recents}
        hl={w.hl}
        tick={w.tick}
        ink={w.ink}
        keys={WELCOME_KEYS.map(([id, word]) => [keyDef(id).label, word])}
        onHover={(i) => {
          w.hl = i
          bump((x) => x + 1)
        }}
        onActivate={welcomeOpen}
      />
    )
  } else if (file?.error) {
    content = (
      <box key="error" style={{ flexDirection: "column", paddingLeft: L.zen ? 2 : 0 }}>
        <Row spans={[{ text: "Could not open ", fg: t.error, attr: 1 }, { text: rel, fg: t.text }]} />
        <Row spans={[]} />
        <Row spans={[{ text: truncate(file.error, CW), fg: t.textMuted }]} />
      </box>
    )
  } else if (L.zen) {
    // a 2-column gutter left of the text carries the typewriter marker
    const gutter = mix(t.textMuted, t.background, 0.4)
    // the gloss sheet: a rule and GLOSS_ROWS muted rows over the bottom body rows, faded toward the background
    const sheetK = !sheet || sheet.fadeAt === null ? 0 : (fadeStep(Date.now() - sheet.fadeAt, 0) ?? GHOST_STEPS + 1) / (GHOST_STEPS + 1)
    const ink = (c: typeof t.text) => mix(c, t.background, sheetK)
    const sheetAt = sheet ? CH - 1 - GLOSS_ROWS : CH
    const rule = sheet ? glossRule(sheet.state, sheet.heading, CW) : null
    const glossed = sheet ? glossRows(sheet.text, CW) : []
    content = (
      <box key="zen-lines" style={{ flexDirection: "column", width: CW + 2, height: CH, flexShrink: 0 }}>
        {Array.from({ length: CH }, (_, i) => {
          if (rule && i >= sheetAt) {
            const r = i - sheetAt
            const spans: Span[] = r
              ? [{ text: glossed[r - 1] ?? "", fg: ink(t.textMuted) }]
              : [{ text: rule[0], fg: ink(t.border) }, { text: rule[1], fg: ink(t.textMuted) }, { text: rule[2], fg: ink(t.border) }]
            return <Row key={"gloss" + r} spans={[{ text: "  " }, ...spans]} />
          }
          const n = win.first + i
          const l = n >= win.lo && n < win.hi ? view.lines[n] : undefined
          let spans = l?.spans ?? []
          const dim = !!l && !!spot && (n < spot[0] || n >= spot[1])
          if (dim) spans = dimSpans(spans, t, SPOT_DIM)
          return <Row key={n} spans={[{ text: tw && n === top ? "▸ " : "  ", fg: gutter }, ...markMatches(spans, query, t)]} />
        })}
      </box>
    )
  } else {
    content = (
      <box key="lines" style={{ flexDirection: "column", width: CW, height: CH, flexShrink: 0 }}>
        {view.lines.slice(top, top + CH).map((l: Line, i) => {
          let spans = markMatches(l.spans, query, t)
          const lb = s.labels && s.labels.geo === labelGeo(s, CW, view.lines.length, top) ? s.labels : null
          if (lb)
            lb.spots.forEach((sp, k) => {
              const label = lb.labels[k]!
              if (sp.row === top + i && label.startsWith(lb.typed))
                spans = overlayAt(spans, sp.col, label, { fg: contrastOn(t.warning), bg: t.warning, attr: A.BOLD })
            })
          return <Row key={top + i} spans={scrim ? dimSpans(spans, t, SCRIM_DIM) : spans} />
        })}
      </box>
    )
  }
  const docEl = (
    <box
      key="doc"
      style={{ flexDirection: "column", flexGrow: 1, height: bodyH, paddingLeft: L.zen ? padL - 2 : padL }}
      onMouseDown={() => focusDoc()}
      onMouseScroll={(e: MouseEvent) => (L.zen ? zenScroll : scrollBy)(e.scroll?.direction === "up" ? -3 : 3)}
    >
      {content}
    </box>
  )
  // the minimap: a gap column, two braille cells and the find lane, over the body rows
  const miniInkData = L.mini && openPath && !file?.error ? memo.mini(view, CW, bodyH, view.srcRow ? String(view.srcRow.length).length + 2 : 0) : null
  const mc = miniColors(t)
  const miniEl = L.mini ? (
    <box
      key="mini"
      style={{ width: MINI_W - 1, height: bodyH, flexDirection: "column", flexShrink: 0 }}
      onMouseDown={(e: MouseEvent) => {
        if (e.button !== MouseButton.LEFT || !miniInkData) return
        setTop(miniJump(e.y - 1 - L.gap, miniInkData, CH, maxTop))
      }}
    >
      {miniInkData
        ? miniCells(miniInkData, { top, h: CH, heads: memo.geo(view).heads, hits: matches, total: view.lines.length, lane: !!query }).map((row, i) => (
            <Row key={i} spans={row.map((c) => ({ text: c.ch, fg: mc[c.kind], bg: c.band ? t.backgroundElement : undefined }))} />
          ))
        : null}
    </box>
  ) : null

  // zen chrome: faded toward the background (`k` 0 = full color)
  const fade = (spans: Span[], k: number): Span[] => spans.map((sp) => ({ ...sp, fg: mix(sp.fg ?? t.text, t.background, k) }))

  // top line (row 0): the logo at column 0, the folder over the panel, `Title › section` from the text's left edge, the state cluster at its right edge
  const topLine = (): Span[] => {
    const out: Span[] = []
    let x = 0
    const at = (col: number, spans: Span[]) => {
      if (col > x) out.push({ text: " ".repeat(col - x) })
      out.push(...spans)
      x = Math.max(x, col) + spansWidth(spans)
    }
    const logo = logoState({ gone: !!file?.error, reloadedAt: s.reloadedAt, now: Date.now() })
    at(0, [logo === "gone" ? { text: " " } : { text: LOGO, fg: logo === "live" ? t.primary : t.textMuted, attr: logo === "live" ? 1 : 0 }])
    if (!openPath) {
      at(2, [{ text: "no note open", fg: t.textMuted }])
      return out
    }
    const textLeft = 1 + (L.inline ? SW + 1 : 0) + padL
    const h = headerLayout({
      inline: L.inline,
      SW,
      textLeft,
      textWidth: CW,
      zen: L.zen,
      gap: !!L.gap,
      vault: basename(resolve(s.root)) || s.root,
      folder: dirname(rel),
      title: d.title,
      trail: headingPath(view.headings, currentHeading),
      query: prompt ? "" : query,
      matchIdx: d.matchIdx,
      count: matches.length,
      source: s.source,
      wide: s.wide,
    })
    if (h.panel) {
      const parts = h.panel.text.split(" / ")
      at(h.panel.col, parts.flatMap((p, i) => (i ? [{ text: " / ", fg: t.borderSubtle }] : []).concat({ text: p, fg: t.textMuted })))
    }
    const loc = h.head
    const titleDim = mainHeadingVisible(view.headings, d.title, top, bodyH)
    const left: Span[] = []
    if (loc.folder) left.push({ text: loc.folder, fg: t.textMuted }, { text: " / ", fg: t.borderSubtle })
    left.push(titleDim ? { text: loc.title, fg: t.textMuted } : { text: loc.title, fg: t.text, attr: 1 })
    for (const a of loc.ancestors) left.push({ text: " › ", fg: t.borderSubtle }, { text: a, fg: t.textMuted })
    if (loc.section) left.push({ text: " › ", fg: t.borderSubtle }, { text: loc.section, fg: t.secondary })
    at(loc.col, left)
    const right: Span[] = []
    h.cluster.forEach((it, i) => {
      if (i) right.push({ text: "   " })
      if (it.kind !== "search") return void right.push({ text: it.kind, fg: it.kind === "source" ? t.info : t.textMuted })
      right.push({ text: `/${it.query} `, fg: t.accent })
      if (!it.count) right.push({ text: "no match", fg: t.error, attr: 1 })
      else
        right.push(
          it.idx === null ? { text: "–", fg: t.textMuted } : { text: String(it.idx), fg: t.text, attr: 1 },
          { text: `/${it.count}`, fg: t.text, attr: 1 },
        )
    })
    at(h.clusterCol, right)
    return out
  }
  /** Row 0, faded `k` toward the background (0 = full); null draws nothing (ghosted away). */
  const topRow = (k: number | null) => (
    <box style={{ height: 1, flexDirection: "row" }}>
      <Row spans={fade(k === null ? [] : topLine(), k ?? 0)} />
    </box>
  )
  /** The gap row (H ≥ 28): a faint rule over the text column; blank in zen. */
  const gapRow = () => {
    if (!L.gap) return null
    const textLeft = 1 + (L.inline ? SW + 1 : 0) + padL
    return (
      <box key="gap" style={{ height: 1, flexDirection: "row" }}>
        {L.zen ? null : <Row spans={[{ text: " ".repeat(textLeft) }, { text: "─".repeat(CW), fg: t.border }]} />}
      </box>
    )
  }

  // progress line (row H-1): read part in primary, then `34% · 3 min left`; the one permanent zen row
  const PW = W - 2
  const pl =
    openPath && !file?.error
      ? progressLabel({
          top,
          maxTop,
          minutes: minutesLeft(memo.words(view), top),
          page: pg ? { index: pg.index, count: pg.count } : undefined,
          wpm: s.rolling ? s.zenCfg.wpm : undefined,
        })
      : null
  const label: Span[] = pl
    ? [{ text: pl.pre, fg: t.textMuted }, { text: pl.main, fg: t.text }, { text: pl.rest, fg: t.textMuted }].filter((x) => x.text)
    : []
  const lineW = Math.max(0, PW - (label.length ? spansWidth(label) + 1 : 0))
  const fill = pl ? fillWidth(top, maxTop, lineW) : 0
  const progressLine = (
    <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
      <Row
        spans={[
          { text: "─".repeat(fill), fg: t.primary },
          { text: "─".repeat(lineW - fill), fg: t.border },
          ...(label.length ? [{ text: " " }, ...label] : []),
        ]}
      />
    </box>
  )

  // any context change (focus, view, zen, popup closed, typing ended) shows the new context's hints
  const ctxNow = currentCtx()
  useEffect(() => {
    if (ctxNow === ctxSeen.current) return
    ctxSeen.current = ctxNow
    pokeHints(ctxNow)
  })

  // zen gloss: runs when the reading line changes section (not on every scroll tick)
  const glossAt = L.zen && openPath ? `${openPath}\0${currentHeading}` : null
  useEffect(() => {
    if (glossAt === glossSeen.current) return
    glossSeen.current = glossAt
    glossEntered()
  })

  // ghost line (row H-2): key hints on the left, a toast on the right; blank at rest
  const pinned = ["prompt", "theme", "zenSettings", "help", "filter", "label", "switch", "open"].includes(ctxNow)
  let hintK: number | null = null
  if (pinned) hintK = 0
  // the welcome page has its own keycaps: no hint row under it (popups opened from it keep theirs)
  else if (s.openPath && s.hintAt !== null && s.hintCtx === ctxNow) {
    const st = fadeStep(Date.now() - s.hintAt, HINT_HOLD)
    hintK = st === null ? null : st / (GHOST_STEPS + 1)
  }
  const tStep = s.toast ? toastStep(s.toast, Date.now()) : null
  const toastSpans: Span[] =
    s.toast && tStep !== null
      ? fade(
          [
            {
              text: truncate(`${toastIcon(s.toast)} ${s.toast.msg}`, W - 2),
              fg: s.toast.kind === "ok" ? t.success : s.toast.kind === "error" ? t.error : t.info,
              attr: s.toast.kind === "error" ? 1 : 0,
            },
          ],
          tStep / (GHOST_STEPS + 1),
        )
      : []
  /** Key hints for context `c`, as many as fit in `room` columns. */
  const hintRow = (c: Ctx, room: number): Span[] => {
    const items: HintItem[] = []
    for (const h of FOOTERS[c]) {
      const [id, word] = Array.isArray(h) ? h : [h, undefined]
      if (id === "docMatch" && !query) continue
      if (id === "links" && s.source) continue // labels are Preview only
      if (id === "edit" && s.openPath === STDIN) continue // nothing on disk to edit
      if ((id === "summarize" || id === "zenGloss") && !s.ai) continue // AI is off until an `ai` block is configured
      if (id === "explainChange" && (!s.ai || !d.cv || d.cv.state === "result")) continue // only while there are changes to explain
      const def = keyDef(id)
      items.push({ key: def.short ?? def.label, word: word ?? def.hint ?? "", spare: id === "links" || id === "histBack" || id === "summarize" || id === "zenGloss" || id === "explainChange" || id === "edit" || id === "themeType" })
    }
    return fitHints(items, room).flatMap((h, i): Span[] => [
      ...(i ? [{ text: "   " }] : []),
      { text: h.key, fg: t.text },
      ...(h.word ? [{ text: " " + h.word, fg: t.textMuted }] : []),
    ])
  }
  const hintSpans = hintK === null ? [] : fade(hintRow(ctxNow, W - 2 - (toastSpans.length ? spansWidth(toastSpans) + 3 : 0)), hintK)
  const ghostLine = (
    <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
      <Row spans={hintSpans} />
      <Row spans={toastSpans} />
    </box>
  )

  const popupW = Math.min(70, W - 2)
  const hl = helpLayout(HELP_GROUPS, W, H)
  const helpTopC = Math.max(0, Math.min(s.helpTop, hl.rows - hl.vis))
  const helpNote = hl.rows > hl.vis ? `j/k scroll ${helpTopC + hl.vis}/${hl.rows}` : undefined
  // title row: padding 4 each side, then the note and `esc`; the theme name goes first, then the title is cut
  const titleRoom = Math.min(hl.width, W - 2) - 2 - 8 - 2 - 3 - (helpNote ? helpNote.length + 2 : 0)
  const helpFull = `Keybindings · brothy v${VERSION} · ${t.name}`
  const helpTitle = truncate(helpFull.length <= titleRoom ? helpFull : `Keybindings · brothy v${VERSION}`, Math.max(1, titleRoom))
  const helpOverlay = help ? (
    <HelpSheet t={t} W={W} H={H} layout={hl} top={helpTopC} title={helpTitle} note={helpNote} onClose={() => set({ help: false })} onScroll={(dir) => helpGo(helpTopC + dir * 3)} />
  ) : null

  const notesLabel = s.indexing ? `indexing ${s.indexing[0]}/${s.indexing[1]}` : plural(folderCounts(s.linkTree).get(s.linkTree.path) ?? 0, "note")
  // the peek pane (from PEEK_MIN_W): the highlighted row's note, its TL;DR only while fresh
  const peekRow = s.switcher && W >= PEEK_MIN_W ? swRows[swHl] : undefined
  const peekPath = peekRow && "path" in peekRow ? peekRow.path : null
  const peekDoc = peekPath ? vault.current.ix.docs.get(peekPath) : undefined
  const peekW = switchSplit(W).peekW
  const peekNote = peekPath && peekDoc ? memo.peekFile(peekPath, peekDoc.mtime) : null
  const peekWin = peekNote && peekRow ? peekWindow(peekNote.lines, peekNote.fm, peekDoc!, peekRow) : null
  const peekView = peekNote && peekWin ? memo.peek(peekNote.lines, peekWin.from, peekWin.to, peekW, t, s.linkTree, s.headings) : undefined
  const peekSaved = peekPath ? s.summaries[peekPath] : undefined
  const peek =
    s.switcher && W >= PEEK_MIN_W
      ? peekLines(
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
      : undefined
  const switchOverlay = s.switcher ? (
    <Switcher
      t={t}
      W={W}
      H={H}
      title={question ? "Ask" : "Go to"}
      q={s.switcher.q}
      rows={swRows}
      hl={swHl}
      top={keepVisible(s.switcher.top, Math.max(0, swHl), L.PH, swRows.length)}
      height={L.PH}
      note={question ? askTitleNote({ off: !s.ai, state: s.switcher.ask, indexing: s.indexing ? notesLabel : null, notes: notesLabel }) : notesLabel}
      peek={peek}
      onClose={closeSwitcher}
      onScroll={(dir) => swGo(stepRow(swRows, swHl, dir))}
      onHover={(i) => i !== swHl && ui.current.switcher && set({ switcher: { ...ui.current.switcher, hl: i } })}
      onActivate={swActivate}
    />
  ) : null

  const openOverlay = s.opener ? (
    <OpenPicker
      t={t}
      W={W}
      H={H}
      q={s.opener.q}
      rows={d.opRows}
      hl={d.opHl}
      top={keepVisible(s.opener.top, Math.max(0, d.opHl), L.PH, d.opRows.length)}
      height={L.PH}
      onClose={() => set({ opener: null })}
      onScroll={(dir) => opGo(stepRow(d.opRows, d.opHl, dir))}
      onHover={(i) => i !== d.opHl && ui.current.opener && set({ opener: { ...ui.current.opener, hl: i } })}
      onActivate={(i) => opOpen(d.opRows[i])}
    />
  ) : null

  // `/` picker: find in the document
  let promptOverlay: ReactNode = null
  if (prompt) {
    const height = L.PH
    const items: PickerItem[] = matches.map((m) => {
      const num = s.source ? "" : String(m + 1).padStart(4) + "  "
      const text = lineText(view.lines[m]).trim()
      // code point indexes of the hits, so the cut can keep the first one in view
      const hits: number[] = []
      for (const [a, b] of matchRanges(text, prompt.value)) {
        const from = [...text.slice(0, a)].length
        for (let i = from; i < from + [...text.slice(a, b)].length; i++) hits.push(i)
      }
      const f = fitHits(text, hits, popupW - 2 - 8 - num.length)
      return { spans: [...(num ? [{ text: num, fg: t.textMuted }] : []), ...markHits(f.text, f.hits, t.text, t.primary)] }
    })
    const hl = Math.min(items.length - 1, prompt.hl >= 0 ? prompt.hl : promptDefault())
    const ptop = keepVisible(prompt.hl >= 0 ? prompt.top : 0, Math.max(0, hl), height, items.length)
    const note = prompt.value ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : undefined
    promptOverlay = (
      <Overlay
        t={t}
        W={W}
        H={H}
        width={popupW}
        title="Find in Document"
        onClose={promptClose}
        onScroll={(dir) => items.length && promptHighlight(hl + dir)}
      >
        <PickerInput t={t} value={prompt.value} placeholder="Find in document..." note={note} width={popupW} />
        <PickerList
          t={t}
          items={items}
          hl={hl}
          top={ptop}
          height={height}
          innerW={popupW - 2}
          empty={!prompt.value ? "Type to search" : "No results found"}
          onHover={(i) => i !== hl && ui.current.prompt && set({ prompt: { ...ui.current.prompt, hl: i, top: ptop } })}
          onActivate={(i) => promptSubmit(i)}
        />
      </Overlay>
    )
  }

  // `t` picker: the chrome stays in `t`; from PEEK_MIN_W the pane draws the candidate's sample on its own background
  const pick = s.themePick
  const pickRows = pick ? memo.themeRows(pick.q) : []
  const pickGeo = themeSplit(W, H, L.PH)
  const pickHl = pick ? pickIndex(pick, pickRows) : -1
  // the board's rows under the header; hover holds the window where it is, keys and the wheel centre it again
  const pickTopShown = pick ? pickTop(pick, pickHl, Math.max(1, pickGeo.rows - 1), pickRows.length) : 0
  const pickT = pick ? pickTheme(pick) : null
  const pickView = pickT && pickGeo.split && pickHl >= 0 ? memo.themeSample(pickT, pickGeo.peekW, s.hl, s.headings) : null
  // the sample's code block colours in once the highlighter answers (its cache serves every theme after that)
  useEffect(() => {
    if (!pickView || pickView === hlSample.current) return
    hlSample.current = pickView
    const reqs = pendingHighlights(pickView)
    if (reqs.length)
      ensureHighlights(reqs).then((changed) => {
        if (changed && alive.current) set({ hl: ui.current.hl + 1 })
      })
  })
  /** row `i` becomes the highlight (hover, click); the list stays where it is under the pointer */
  const pickAt = (i: number) => {
    const p = ui.current.themePick
    const r = pickRows[i]
    if (p && r && r.family.name !== p.family) themeSet({ ...p, family: r.family.name, top: pickTopShown })
  }
  const themeOverlay = pick ? (
    <ThemePicker
      t={t}
      W={W}
      H={H}
      q={pick.q}
      rows={pickRows}
      hl={pickHl}
      top={pickTopShown}
      mode={pick.mode}
      shown={pickShown(pick)}
      only={pickHl >= 0 ? onlyMode(pickRows[pickHl]!.family) : undefined}
      orig={pick.orig}
      geo={pickGeo}
      pane={pickT && pickView ? { theme: pickT, lines: memo.themePane(pickT, pickView, pickGeo.peekW, pickGeo.rows) } : undefined}
      onClose={closeTheme}
      onScroll={(dir) => themeSet(pickMove(ui.current.themePick!, dir))}
      onHover={pickAt}
      onActivate={(i) => {
        pickAt(i)
        applyTheme()
      }}
      onPick={(i, m) => {
        pickAt(i)
        themeSet(pickMode(ui.current.themePick!, m))
        applyTheme()
      }}
      onMode={(m) => themeSet(pickMode(ui.current.themePick!, m))}
    />
  ) : null
  const zenOverlay =
    s.zenOrig !== null ? (
      <ZenSettings
        t={t}
        W={W}
        H={H}
        rows={zenRows(s.zenCfg)}
        cursor={s.zenRow}
        onClose={revertZen}
        onHover={(i) => i !== ui.current.zenRow && set({ zenRow: i })}
        onActivate={(i) => {
          set({ zenRow: i })
          zenEdit(i, 0)
        }}
      />
    ) : null

  if (W < 60 || H < 14)
    return (
      <box style={{ width: W, height: H, backgroundColor: paint.main, alignItems: "center", justifyContent: "center" }}>
        {tooSmall(W, H).map((l, i) => (
          <text key={i} wrapMode="none" fg={t.textMuted}>
            {l}
          </text>
        ))}
      </box>
    )

  if (L.zen) {
    // Ghost on: the top line is full after a key, then fades; Ghost off: dimmed. Hints and toasts have their own lifetimes.
    const step = s.zenCfg.ghost ? (s.ghostAt === null ? null : fadeStep(Date.now() - s.ghostAt)) : undefined
    const topK = step === undefined ? ZEN_DIM : step === null ? null : step / (GHOST_STEPS + 1)
    return (
      <box key="zen" onMouse={pointer.note} style={{ width: W, height: H, flexDirection: "column", backgroundColor: paint.main }}>
        {topRow(topK)}
        {gapRow()}
        <box style={{ flexDirection: "row", height: bodyH, paddingLeft: 1, paddingRight: 1 }}>{docEl}</box>
        {ghostLine}
        {progressLine}
        {helpOverlay}
        {promptOverlay}
        {switchOverlay}
        {openOverlay}
        {themeOverlay}
        {zenOverlay}
      </box>
    )
  }

  return (
    <box key="main" onMouse={pointer.note} style={{ width: W, height: H, flexDirection: "column", backgroundColor: paint.main }}>
      {topRow(0)}
      {gapRow()}
      <box style={{ flexDirection: "row", height: bodyH, paddingLeft: 1, paddingRight: L.mini ? 0 : 1, gap: 1 }}>
        {L.inline ? panelBox : null}
        {docEl}
        {miniEl}
      </box>
      {ghostLine}
      {progressLine}
      {L.shown && !L.inline ? panelBox : null}
      {helpOverlay}
      {promptOverlay}
      {switchOverlay}
      {openOverlay}
      {themeOverlay}
      {zenOverlay}
    </box>
  )
}
