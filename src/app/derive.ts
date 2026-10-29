// The app's derived data: the memoized builders (`makeMemo`) and `derive()`, everything computed from the store.
// Not pure: `derive()` writes back the Files cursor, the scroll entry it remaps and the match line it re-finds.
// Its steps, one per area, live in derive/steps.ts.
import { existsSync } from "node:fs"
import { rankNotes, visibleRows, type FileNode } from "../notes/files"
import { render, type Geometry, type Rendered } from "../markdown/render"
import { normalize } from "../markdown/lexer"
import { parseFrontMatter, parseProperties, type FrontMatter, type Property } from "../markdown/frontmatter"
import { stats, wordStats, type Stats } from "../markdown/stats"
import type { HeadingStyle } from "../markdown/heading-style"
import { renderSource } from "../markdown/source"
import { lineText } from "../lib/spans"
import { clamp } from "../lib/text"
import { readDoc, type DocFile } from "../notes/doc"
import { STDIN } from "../notes/workspace"
import { layout } from "../ui/layout"
import { themes, type Theme } from "../theme/theme"
import { MAX_BYTES } from "../notes/stdin"
import { fsDirIO, loadProjects, openRows, type ProjectEntry } from "../notes/projects"
import { recentSection, searchVault, switchRows, type VaultIndex } from "../notes/vault"
import { miniInk } from "../ui/minimap"
import { filterFamilies, paneLines, sampleView } from "../theme/themepick"
import { cached, findLines, matchIndex } from "../ui/nav"
import { cleanSummary, noteText } from "../ai/client"
import { resolveAI, type AIConfig } from "../ai/config"
import { askCandidates, askRows, rerankCost, type AskState, type Candidate } from "../ai/ask"
import { textHash } from "../ai/cache"
import { glossTarget } from "../ai/gloss"
import {
  extractLinks,
  fmtSize,
  infoItems,
  outlineRows,
  resolveLink,
  type ChangeState,
  type FileMeta,
  type InfoItem,
  type LinkRef,
  type SummaryState,
} from "../ui/panel"
import { diffSections, parseDelta, type Change, type DeltaNote } from "../ai/delta"
import { sectionRanges, wordSuffix } from "../ui/zen"
import { WELCOME_RECENTS } from "../ui/welcome"
import type { View } from "../system/config"
import type { FileRow, Job, UI } from "./store"
import {
  filesCursor,
  filesList,
  glossSheet,
  infoPanel,
  matchState,
  noteView,
  openerList,
  readingWindow,
  scrollState,
  switcherList,
  truncationNote,
} from "./derive/steps"

/** Memo builders for the open note: read, lexed and rendered, its properties, stats and AI hashes. */
function documentMemo(stdin: string | undefined) {
  return {
    read: cached(
      (path: string, nonce: number): DocFile =>
        path !== STDIN || stdin === undefined
          ? readDoc(path, nonce)
          : Buffer.byteLength(stdin) > MAX_BYTES
            ? { src: "", info: null, error: `input too large (${fmtSize(Buffer.byteLength(stdin))}, limit 5 MB)` }
            : { src: stdin, info: null, error: null },
    ),
    fm: cached(parseFrontMatter),
    doc: cached((src: string, w: number, t: Theme, _hl: number, tree: FileNode, headings: HeadingStyle) =>
      render(src, w, t, { exists: (x) => resolveLink(x, tree) !== null, headings }),
    ),
    source: cached((src: string, w: number, t: Theme, tree: FileNode) => renderSource(src, w, t, { exists: (x) => resolveLink(x, tree) !== null })),
    stats: cached(stats),
    props: cached(parseProperties),
    propsKey: cached((fm: FrontMatter) => JSON.stringify(fm.entries)),
    note: cached(noteText),
    hash: cached((src: string) => textHash(noteText(src))),
    clean: cached(cleanSummary),
    gloss: cached(glossTarget),
    glossHash: cached(textHash),
    glossClean: cached(cleanSummary),
  }
}

/** Memo builders for the panel's rows: links, Info, Files and Outline. */
function panelMemo() {
  return {
    linkTargets: cached(extractLinks),
    links: cached((targets: string[], tree: FileNode, from: string | null): LinkRef[] =>
      targets.map((target) => ({ target, path: resolveLink(target, tree, from) })),
    ),
    info: cached(
      (
        p: Property[],
        st: Stats,
        l: LinkRef[],
        w: number,
        f: FileMeta | null,
        sText: string,
        sState: SummaryState | "",
        sModel: string,
        cState: ChangeState | "",
        cLabel: string,
        cChanges: readonly Change[],
        cSummary: string,
        cNotes: readonly (DeltaNote | undefined)[],
        title: string,
      ) =>
        infoItems(
          p,
          st,
          l,
          w,
          f,
          undefined,
          sState ? { text: sText, state: sState, model: sModel } : undefined,
          cState ? { view: { state: cState, label: cLabel, changes: cChanges, summary: cSummary, notes: cNotes }, title } : undefined,
        ),
    ),
    // Info cursor stops: links and change rows (removed sections are not stops)
    linkIdx: cached((items: InfoItem[]) => items.flatMap((it, i) => (it.kind === "link" || (it.kind === "change" && it.stop) ? [i] : []))),
    rows: cached(visibleRows),
    outline: cached(outlineRows),
    rank: cached((tree: FileNode, q: string) => {
      const r = rankNotes(tree, q)
      return { total: r.total, rows: r.rows.map((x): FileRow => ({ node: x.node, depth: 0, hits: x.hits })) }
    }),
    diff: cached(diffSections),
    partial: cached((raw: string, changes: Change[]) => parseDelta(raw, changes, true)),
  }
}

/** Memo builders for what is drawn from the rendered view: matches, geometry, minimap, zen. */
function viewMemo() {
  return {
    matches: cached((view: Rendered, q: string) => findLines(view.lines.map(lineText), q)),
    geo: cached((view: Rendered): Geometry => ({ heads: view.headings.map((h) => h.line), total: view.lines.length })),
    // Source rows open with the line-number gutter (`gutter` columns), which draws no dots
    mini: cached((view: Rendered, w: number, rows: number, gutter: number) =>
      miniInk(
        gutter ? view.plain.map((p) => p.slice(gutter)) : view.plain,
        view.lines.map((l) => l.fill !== undefined),
        w - gutter,
        rows,
      ),
    ),
    words: cached((view: Rendered) => wordSuffix(view.plain)),
    ranges: cached((view: Rendered) =>
      sectionRanges(
        view.headings.map((h) => h.line),
        view.lines.length,
      ),
    ),
  }
}

/** Memo builders for the popups: switcher, Open, welcome recents, theme picker and the switcher's peek. */
function pickerMemo() {
  return {
    switch: cached((ix: VaultIndex, tree: FileNode, q: string, _ver: number, recent: readonly string[], open: string | null) =>
      switchRows(q.trim() ? searchVault(ix, tree, q, open) : recentSection(tree, recent, open)),
    ),
    // relative paths resolve against the workspace folder; the current project is not listed
    open: cached((list: ProjectEntry[], q: string, cwd: string, current: string) => openRows(list, q, { cwd, io: fsDirIO, exists: existsSync, current })),
    // the welcome page's recent projects: the `o` picker's rows with an empty query, header first; read again
    // after every workspace switch (`watchGen`) and a dropped missing one (`gen`)
    recents: cached((root: string, _gen: number, _watchGen: number) =>
      openRows(loadProjects(), "", { cwd: root, io: fsDirIO, exists: existsSync, current: root }).slice(0, 1 + WELCOME_RECENTS),
    ),
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
  }
}

/** Memo builders for the switcher's ask mode: target, candidates, rerank cost and rows. */
function askRowsMemo() {
  return {
    /** where an ask would go: null without an `ai` block, else the host or why not */
    host: cached((ai: AIConfig | null) => {
      if (!ai) return null
      const r = resolveAI(ai, process.env)
      return "error" in r ? { error: r.error } : { host: r.host }
    }),
    cands: cached((ix: VaultIndex, tree: FileNode, _ver: number, queries: readonly string[]) => askCandidates(ix, tree, queries)),
    cost: cached((question: string, cands: readonly Candidate[], ix: VaultIndex, _ver: number) => rerankCost(question, cands, ix)),
    ask: cached(
      (
        question: string,
        cut: boolean,
        target: { host: string } | { error: string } | null,
        state: AskState | undefined,
        cands: readonly Candidate[],
        cost: string,
        indexing: boolean,
      ) => askRows({ question, cut, target, state, cands, cost, indexing }),
    ),
  }
}

/** The memoized builders behind `derive()` and render (`cached`: one entry each, so one call site with primitive args); `stdin` is the piped document. */
export function makeMemo(stdin: string | undefined) {
  return { ...documentMemo(stdin), ...panelMemo(), ...viewMemo(), ...pickerMemo(), ...askRowsMemo() }
}
/** The memo table: one `cached` builder per derived value. */
export type Memo = ReturnType<typeof makeMemo>

/** A scroll entry: the top line and the geometry it was taken at, so a re-layout can remap it. */
export interface ScrollEntry {
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
  /** Everything computed from the store; cheap to call repeatedly thanks to `memo`. The steps run in this order. */
  return () => {
    const s = ui.current
    const L = layout(dims.current.W, dims.current.H, s)
    const t = themes[s.themeIdx]!
    const opened = noteView(s, L, t, memo)
    const { file, fm, doc, view, st } = opened
    const files = filesList(s, memo)
    const note = truncationNote(s, L)
    const info = infoPanel(s, L, opened, memo, jobs.current)
    const switcher = switcherList(s, memo, vault.current.ix)
    const scroll = scrollState(s, L, view, memo, scrolls.current)
    const { scrollKey, geo, maxTop, top, tw } = scroll
    const matches = matchState(s, view, memo, matchSeen)
    // the heading the reader is in: last one at (or just above) the top line
    const currentHeading = view.headings.findLastIndex((h) => h.line <= top + 1)
    const oRows = memo.outline(view.headings, currentHeading, s.outlineFilter)
    return {
      s,
      L,
      t,
      file,
      fm,
      doc,
      view,
      st,
      ...files,
      ...info,
      ...switcher,
      ...openerList(s, memo),
      ...filesCursor(s, L, files, note.length, sidebarSeen.current),
      ...glossSheet(s, L, opened, currentHeading, info.title, memo, jobs.current),
      ...readingWindow(s, L, view, scroll, memo),
      infoCur: clamp(s.infoCur, 0, info.linkRows.length - 1),
      note,
      scrollKey,
      geo,
      maxTop,
      top,
      tw,
      matches,
      matchIdx: matchIndex(matches, s.matchLine),
      currentHeading,
      sideFocus: (L.shown && s.focus === "panel" ? s.view : null) as View | null,
      oRows,
      outlineCur: clamp(s.outlineCur, 0, oRows.length - 1),
    }
  }
}
/** What `derive()` returns. */
export type Derived = ReturnType<ReturnType<typeof makeDerive>>
