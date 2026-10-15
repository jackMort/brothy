import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { MouseButton, type KeyEvent, type MouseEvent } from "@opentui/core"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, relative, resolve, sep } from "node:path"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { SCAN_LIMIT, ancestorsOf, findVault, firstFile, folderCounts, rankNotes, scanTree, stem, visibleRows, type FileNode, type TreeRow } from "./files"
import { ensureHighlights } from "./highlight"
import { drop, go, keep, startHistory, stepTo, visit, type History } from "./history"
import { A, parseFrontMatter, parseProperties, pendingHighlights, render, renderSource, stats, width as sw, wrap, type Line, type LinkTarget, type Property, type Rendered, type Span, type Stats } from "./markdown"
import { safe, safeLine } from "./spans"
import { contrastOn, mix, surface, themes, type Theme } from "./theme"
import { OpenPicker, Overlay, PickerInput, PickerList, Switcher, ZenSettings, fitHits, hitSpans as markHits, type PickerItem } from "./overlay"
import { fsDirIO, loadProjects, openRows, projectName, remember as rememberProject, saveProjects, tildify, type OpenRow, type ProjectEntry } from "./projects"
import { emptyIndex, firstHit, fsIO, hitOrdinal, refreshIndex, nextSection, recentSection, remember, searchVault, stepRow, switchRows, type SwitchRow, type VaultIndex } from "./vault"
import { VIEWS, loadConfig, saveConfig, type Config, type SidebarConfig, type View } from "./config"
import { cached, findLines, keepVisible, linkLabels, markMatches, matchRanges, matchIndex, matchKey, narrowLabels, overlayAt, relocate, remapTop, stepMatch, stripLayout, thumb, visibleLinks, type Geometry, type LinkSpot } from "./nav"
import { watchPath } from "./watch"
import { LOGO, LOGO_HOLD, tooSmall, WORDMARK, WORDMARK_W, fitWordmark, TOAST_HOLD, fillWidth, fitHints, headerLayout, logoState, mainHeadingVisible, nextToast, noteTitle, progressLabel, toastIcon, toastStep, truncate, truncateLeft, type HintItem, type Toast, type ToastKind } from "./status"
import { extractLinks, findHeading, fmtNum, fmtSize, infoItems, linkDest, outlineRows, plural, resolveLink, type FileMeta, type InfoItem, type LinkRef, type OutlineRow } from "./panel"
import { GHOST_HOLD, GHOST_STEP, GHOST_STEPS, HINT_HOLD, SPOT_DIM, ZEN_ROWS, ZEN_WPM, dimSpans, fadeStep, headingPath, minutesLeft, normalizeZen, pageSlice, prompterRate, sectionAt, stepMeasure, sectionRanges, typewriterTop, wordSuffix, zenAdjust, zenRows, type ZenConfig } from "./zen"

export const VERSION = "0.1.0"

/** Where keys go: the panel (when shown) or the document. */
type Focus = "doc" | "panel"
/** Find popup: `hl` is the highlighted row; -1 means "not moved yet". */
type Prompt = { value: string; hl: number; top: number } | null
/** A Files list row; filter results carry the matched code points of the note's name. */
type FileRow = TreeRow & { hits?: number[] }

export interface AppProps {
  root: string
  initialFile?: string
  themeName?: string
  /** `--transparent`: wins over the config for this run (a live toggle still saves). */
  transparent?: boolean
}

/** Files above this are refused rather than rendered. */
const MAX_BYTES = 5 * 1024 * 1024
/** Sidebar j/k opens the file under the cursor once it rests this long. */
const OPEN_DELAY = 100
/** Reading measure: the document never wraps wider than this. */
const MEASURE = 80
/** Below this width the panel is a drawer over the text instead of a column beside it. */
const DRAWER_BELOW = 100

/** Zen chrome without Ghost: the top line stays, mixed this far toward the background. */
const ZEN_DIM = 0.5
/** Scrim: the document under an open drawer is mixed this far toward the background. */
const SCRIM_DIM = 0.62

// ------------------------------------------------------------- helpers

const clampIdx = (i: number, len: number) => Math.max(0, Math.min(i, len - 1))
const lineText = (l: Line | undefined) => (l?.spans ?? []).map((s) => s.text).join("")
const spansWidth = (spans: Span[]) => spans.reduce((a, sp) => a + sw(sp.text), 0)

interface DocFile {
  src: string
  info: { size: number; mtime: Date } | null
  error: string | null
}

/** `_nonce` only busts the cache: live reload and `r` bump it to force a re-read. */
function readDoc(path: string, _nonce: number): DocFile {
  try {
    const st = statSync(path)
    const info = { size: st.size, mtime: st.mtime }
    if (!st.isFile()) return { src: "", info: null, error: "not a regular file" }
    if (st.size > MAX_BYTES) return { src: "", info, error: `file too large (${fmtSize(st.size)}, limit 5 MB)` }
    return { src: readFileSync(path, "utf8"), info, error: null }
  } catch (e) {
    return { src: "", info: null, error: (e as Error).message }
  }
}

function Row({ spans, bg }: { spans: Span[]; bg?: string }) {
  return (
    <text bg={bg} wrapMode="none" style={{ height: 1, flexShrink: 0 }}>
      {spans.map((s, i) => (
        <span key={i} fg={s.fg} bg={s.bg} attributes={s.attr ?? 0}>
          {safe(s.text)}
        </span>
      ))}
    </text>
  )
}

// ------------------------------------------------------------- keymap
//
// One table drives key dispatch, the `?` help popup and the footer hints, so they
// cannot drift apart. Specs are matched by `matchKey` (`S-g` is G, `C-d` is ^d).

type Mode = "global" | "files" | "doc" | "outline" | "info" | "filter" | "help" | "prompt" | "theme" | "zen" | "zenSettings" | "label" | "switch" | "open"
/** Context id: one id for keys, hints and help (`panel:<view>` while the panel has focus). */
type Ctx = "doc" | `panel:${View}` | "filter" | "zen" | "help" | "prompt" | "theme" | "zenSettings" | "label" | "switch" | "open"
interface KeyDef {
  modes: readonly Mode[]
  keys: readonly string[]
  /** keys as shown in the help popup */
  label: string
  /** help popup description; bindings without one stay out of the popup */
  desc?: string
  /** compact keys for the footer (defaults to `label`) */
  short?: string
  /** footer word */
  hint?: string
}

/** Tree indent stops growing here; deeper rows keep this indent and cut the name. */
const MAX_DEPTH = 6

const KEYMAP = {
  views: { modes: ["global"], keys: ["1", "2", "3"], label: "1 2 3", short: "1 2 3", desc: "show Files · Outline · Info", hint: "files/outline/info" },
  source: { modes: ["global"], keys: ["s"], label: "s", desc: "toggle Source / Preview", hint: "source" },
  width: { modes: ["global"], keys: ["w"], label: "w", desc: "full width / measure", hint: "width" },
  transparent: { modes: ["global"], keys: ["S-t"], label: "T", desc: "transparent background (saved)" },
  zen: { modes: ["global"], keys: ["z"], label: "z", desc: "zen mode: only the text (esc leaves)", hint: "zen" },
  zenSettings: { modes: ["global"], keys: ["S-z"], label: "Z", desc: "zen settings (live preview)", hint: "settings" },
  sidebar: { modes: ["global"], keys: ["C-b"], label: "^b", desc: "hide / show the panel (drawer below 100 columns)", hint: "panel" },
  slash: { modes: ["global"], keys: ["/"], label: "/", desc: "find in document · filter the panel list (panel focused)", hint: "find" },
  switcher: { modes: ["global"], keys: ["C-p"], label: "^p", desc: "go to a note, heading or text (the whole vault)", hint: "go to" },
  open: { modes: ["global"], keys: ["o"], label: "o", desc: "open a recent project or any path (folder or note)", hint: "open" },
  focus: { modes: ["global"], keys: ["tab"], label: "tab", desc: "panel ⇄ document", hint: "focus" },
  theme: { modes: ["global"], keys: ["t"], label: "t", desc: "pick theme", hint: "theme" },
  reload: { modes: ["global"], keys: ["r"], label: "r", desc: "reload files" },
  clear: { modes: ["global"], keys: ["escape"], label: "esc", desc: "clear find · leave zen · panel: clear filter, else back to the document" },
  help: { modes: ["global"], keys: ["?"], label: "?", desc: "key hints · twice: all keys", hint: "keys" },
  quit: { modes: ["global"], keys: ["q", "C-c"], label: "q", desc: "quit", hint: "quit" },
  histBack: { modes: ["global"], keys: ["S-h"], label: "H", short: "H L", desc: "back to the previous note", hint: "history" },
  histForward: { modes: ["global"], keys: ["S-l"], label: "L", desc: "forward to the next note" },

  docLine: { modes: ["doc"], keys: ["j", "down", "k", "up"], label: "j k ↑ ↓", short: "j k", desc: "scroll a line", hint: "scroll" },
  docHalf: { modes: ["doc"], keys: ["d", "C-d", "u", "C-u"], label: "d u", short: "d/u", desc: "half page down / up", hint: "half page" },
  docPage: { modes: ["doc"], keys: ["space", "pagedown", "C-f", "b", "pageup"], label: "space b", short: "␣ b", desc: "page down / up", hint: "page" },
  docEnds: { modes: ["doc"], keys: ["g", "home", "S-g", "end"], label: "g G", desc: "top / bottom" },
  docHeading: { modes: ["doc"], keys: ["]", "}", "[", "{"], label: "[ ]", desc: "previous / next heading", hint: "section" },
  docMatch: { modes: ["doc"], keys: ["n", "S-n"], label: "n N", short: "n N", desc: "next / previous match", hint: "match" },
  back: { modes: ["doc"], keys: ["h", "left"], label: "h", desc: "focus the panel" },
  links: { modes: ["doc"], keys: ["f"], label: "f", desc: "label the links on screen to follow one", hint: "links" },

  zenLine: { modes: ["zen"], keys: ["j", "down", "k", "up"], label: "j k ↑ ↓", short: "j k", desc: "scroll a line", hint: "scroll" },
  zenHalf: { modes: ["zen"], keys: ["d", "C-d", "u", "C-u"], label: "d u", desc: "half page down / up" },
  zenPage: { modes: ["zen"], keys: ["space", "pagedown", "C-f", "b", "pageup"], label: "space b", desc: "page down / up" },
  zenEnds: { modes: ["zen"], keys: ["g", "home", "S-g", "end"], label: "g G", desc: "top / bottom" },
  zenSection: { modes: ["zen"], keys: ["]", "}", "[", "{"], label: "[ ]", desc: "previous / next section", hint: "section" },
  zenMeasure: { modes: ["zen"], keys: ["<", ">"], label: "< >", desc: "narrower / wider text (saved)" },
  zenSpeed: { modes: ["zen"], keys: ["+", "-"], label: "+ -", desc: "teleprompter faster / slower (saved)" },

  outlineMove: { modes: ["outline"], keys: ["j", "down", "k", "up", "g", "S-g"], label: "j k g G", short: "↑↓", desc: "Outline: move", hint: "move" },
  outlineJump: { modes: ["outline"], keys: ["return", "enter"], label: "⏎", desc: "Outline: jump to heading and read", hint: "jump" },
  outlinePeek: { modes: ["outline"], keys: ["l", "right"], label: "l", desc: "Outline: jump, keep the panel focused", hint: "peek" },

  infoMove: { modes: ["info"], keys: ["j", "down", "k", "up", "g", "S-g"], label: "j k g G", short: "↑↓", desc: "Info: move between links (scroll without links)", hint: "links" },
  infoOpen: { modes: ["info"], keys: ["return", "enter"], label: "⏎", desc: "Info: open the link", hint: "open" },

  filesMove: {
    modes: ["files"],
    keys: ["j", "down", "k", "up", "g", "S-g", "pagedown", "C-d", "pageup", "C-u"],
    label: "j k g G",
    short: "↑↓",
    desc: "Files: move",
    hint: "move",
  },
  filesOpen: { modes: ["files"], keys: ["return", "enter"], label: "⏎", short: "⏎", desc: "Files: read note · toggle folder", hint: "open" },
  filesPeek: { modes: ["files"], keys: ["l", "right"], label: "l", desc: "Files: open note, keep focus · expand folder" },
  filesUp: { modes: ["files"], keys: ["h", "left"], label: "h", short: "h l", desc: "Files: collapse folder · go to parent", hint: "fold" },
  filesTidy: { modes: ["files"], keys: ["-"], label: "-", desc: "Files: fold all but the open note's path", hint: "tidy" },

  filterType: { modes: ["filter"], keys: [], label: "type", desc: "Filter: type to narrow the list (⌫ erases)", hint: "" },
  filterMove: { modes: ["filter"], keys: ["down", "up", "C-n", "C-p"], label: "↑↓", desc: "Filter: move", hint: "" },
  filterOpen: { modes: ["filter"], keys: ["return", "enter"], label: "⏎", desc: "Filter: open the result", hint: "open" },
  filterClear: { modes: ["filter"], keys: ["escape"], label: "esc", desc: "Filter: clear and stop typing", hint: "clear" },
  filterLeave: { modes: ["filter"], keys: ["tab"], label: "tab", desc: "Filter: keep it, back to the document" },
  filterErase: { modes: ["filter"], keys: ["backspace"], label: "⌫" },

  helpScroll: {
    modes: ["help"],
    keys: ["j", "down", "k", "up", "space", "pagedown", "C-d", "b", "pageup", "C-u", "g", "home", "S-g", "end"],
    label: "j/k",
    hint: "scroll",
  },
  helpClose: { modes: ["help"], keys: ["escape"], label: "esc", hint: "close" },

  promptMove: { modes: ["prompt"], keys: ["down", "up"], label: "↑↓", hint: "select" },
  promptApply: { modes: ["prompt"], keys: ["return", "enter"], label: "⏎", hint: "apply" },
  promptClear: { modes: ["prompt"], keys: ["escape"], label: "esc", hint: "clear" },
  promptErase: { modes: ["prompt"], keys: ["backspace"], label: "⌫" },
  swType: { modes: ["switch"], keys: [], label: "type", hint: "search" },
  swMove: { modes: ["switch"], keys: ["down", "up", "C-n", "C-p"], label: "↑↓", hint: "select" },
  swSection: { modes: ["switch"], keys: ["tab"], label: "tab", hint: "section" },
  swOpen: { modes: ["switch"], keys: ["return", "enter"], label: "⏎", hint: "open" },
  swClose: { modes: ["switch"], keys: ["escape"], label: "esc", hint: "close" },
  swErase: { modes: ["switch"], keys: ["backspace"], label: "⌫" },
  opType: { modes: ["open"], keys: [], label: "type", hint: "filter · path" },
  opMove: { modes: ["open"], keys: ["down", "up", "C-n", "C-p"], label: "↑↓", hint: "select" },
  opComplete: { modes: ["open"], keys: ["tab"], label: "tab", hint: "complete" },
  opOpen: { modes: ["open"], keys: ["return", "enter"], label: "⏎", hint: "open" },
  opClose: { modes: ["open"], keys: ["escape"], label: "esc", hint: "close" },
  opErase: { modes: ["open"], keys: ["backspace"], label: "⌫" },
  labelType: { modes: ["label"], keys: [], label: "a–z", desc: "Links: type a label", hint: "follow" },
  labelErase: { modes: ["label"], keys: ["backspace"], label: "⌫", hint: "erase" },
  labelCancel: { modes: ["label"], keys: ["escape"], label: "esc", hint: "cancel" },

  themeMove: { modes: ["theme"], keys: ["down", "j", "up", "k", "g", "S-g"], label: "↑↓", hint: "preview" },
  themeApply: { modes: ["theme"], keys: ["return", "enter"], label: "⏎", hint: "apply" },
  themeRevert: { modes: ["theme"], keys: ["escape"], label: "esc", hint: "revert" },

  zsMove: { modes: ["zenSettings"], keys: ["down", "j", "up", "k"], label: "↑↓", hint: "move" },
  zsToggle: { modes: ["zenSettings"], keys: ["space"], label: "space", hint: "toggle" },
  zsAdjust: { modes: ["zenSettings"], keys: ["left", "h", "right", "l"], label: "←→", hint: "adjust" },
  zsSave: { modes: ["zenSettings"], keys: ["return", "enter"], label: "⏎", hint: "save" },
  zsRevert: { modes: ["zenSettings"], keys: ["escape"], label: "esc", hint: "revert" },
} as const satisfies Record<string, KeyDef>
type KeyId = keyof typeof KEYMAP
const KEY_IDS = Object.keys(KEYMAP) as KeyId[]
const keyDef = (id: KeyId): KeyDef => KEYMAP[id]

/** Footer hints per context: a binding, optionally with a context-specific word. */
type Hint = KeyId | [KeyId, string]
const FOOTERS: Record<Ctx, Hint[]> = {
  doc: ["docLine", "docPage", "docHeading", ["slash", "find"], "docMatch", "links", "histBack", ["focus", "panel"], "help"],
  "panel:files": ["filesMove", "filesOpen", "filesUp", ["slash", "filter"], ["views", "view"], ["focus", "document"], "help"],
  "panel:outline": ["outlineMove", "outlineJump", "outlinePeek", ["slash", "filter"], ["focus", "document"], "help"],
  "panel:info": ["infoMove", "infoOpen", ["focus", "document"], "help"],
  filter: ["filterType", "filterMove", "filterOpen", "filterClear"],
  zen: ["zenLine", "zenSection", "zenSettings", ["zen", "leave"], "help"],
  help: ["helpScroll", "helpClose"],
  prompt: ["promptMove", "promptApply", "promptClear"],
  theme: ["themeMove", "themeApply", "themeRevert"],
  zenSettings: ["zsMove", "zsToggle", "zsAdjust", "zsSave", "zsRevert"],
  label: ["labelType", "labelErase", "labelCancel"],
  switch: ["swType", "swMove", "swSection", "swOpen", "swClose"],
  open: ["opType", "opMove", "opComplete", "opOpen", "opClose"],
}

const HELP_SECTIONS: [readonly Mode[], string][] = [
  [["global"], "Global"],
  [["doc"], "Document"],
  [["zen"], "Zen"],
  [["files", "outline", "info", "filter"], "Panel"],
]
const HELP_ROWS: [string, string][] = HELP_SECTIONS.flatMap(([modes, title], i) => [
  ...(i ? ([["", ""]] as [string, string][]) : []),
  [title, ""] as [string, string],
  ...KEY_IDS.map(keyDef)
    .filter((d) => d.desc && modes.includes(d.modes[0]!))
    .map((d) => [d.label, d.desc!] as [string, string]),
])
// popup chrome: panel padding 1 + title row + gap 1
/** The wordmark atop the popup (+1 gap row): only when the popup's inner width and the height (3 list rows still left) allow. */
const helpMark = (W: number, H: number) => fitWordmark(Math.min(70, W - 2) - 10, H - 2 - 4 - 3 - 1)
const HELP_VIS = (W: number, H: number) => Math.max(3, Math.min(HELP_ROWS.length, H - 2 - 4 - (helpMark(W, H) ? WORDMARK.length + 1 : 0)))

/** Direction of a paired binding (j/k, d/u, space/b, …): true for the "forward" key. */
const isDown = (k: KeyEvent) => ["j", "down", "d", "space", "pagedown"].includes(k.name) || (k.ctrl && k.name === "f")

/** Bindings that only make sense with the panel; zen skips them. */
const ZEN_OFF: readonly KeyId[] = ["views", "sidebar", "focus", "back", "links"]

// ------------------------------------------------------------- store

/** Where a note was left: its scroll entry (Preview or Source key) at that moment. */
type Spot = { key: string; top: number; geo: Geometry }

/**
 * All UI state lives in one mutable store read at call time, so key handlers never act
 * on a stale render (keys arriving faster than frames used to be dropped).
 */
interface UI {
  themeIdx: number
  themeOrig: number | null
  /** the workspace folder (Files lists it; `o` replaces it) */
  root: string
  tree: FileNode
  /** where wikilinks resolve: the enclosing vault when a single note was opened inside one, else `tree` */
  linkTree: FileNode
  /** that vault's root when it differs from `root` (rescanned on reload) */
  linkRoot: string | null
  /** open folders (session only; the open note's path is always added) */
  expanded: Set<string>
  filter: string
  /** typing into the panel's filter row */
  filterTyping: boolean
  cursor: number
  /** first visible row of each panel view */
  listTop: Record<View, number>
  /** Info cursor the list was last scrolled to: wheel and edge scrolling stick until the cursor moves */
  infoSeen: string
  openPath: string | null
  /** bumped to re-read the open file */
  reload: number
  /** bumped to re-arm the file watcher */
  watchGen: number
  /** when the last live reload landed (the logo stays bright for `LOGO_HOLD`) */
  reloadedAt: number | null
  /** Source instead of Preview */
  source: boolean
  focus: Focus
  /** inline panel hidden (saved by ^b) */
  hidden: boolean
  /** full pane width instead of the fixed measure */
  wide: boolean
  /** main surfaces unpainted: the terminal background shows through (saved by T) */
  transparent: boolean
  /** drawer open (below DRAWER_BELOW; never saved) */
  drawerOpen: boolean
  /** panel view shown */
  view: View
  /** bumped when code-block highlighting lands, to re-render the document */
  hl: number
  prompt: Prompt
  /** link labels on screen (`f`); dropped when the view or scroll position changes */
  labels: { spots: LinkSpot[]; labels: string[]; typed: string; view: Rendered; top: number } | null
  query: string
  /** line of the match `n`/`N` last landed on */
  matchLine: number | null
  help: boolean
  helpTop: number
  /** Outline heading filter */
  outlineFilter: string
  outlineCur: number
  /** Info cursor: index into the link rows */
  infoCur: number
  /** zen layout requested (runtime only; never saved) */
  zen: boolean
  /** zen settings in effect */
  zenCfg: ZenConfig
  /** zen settings popup open: what to restore on esc */
  zenOrig: { cfg: ZenConfig; zen: boolean; source: boolean } | null
  /** `C-p` popup: query, highlighted row, first visible row */
  switcher: { q: string; hl: number; top: number } | null
  /** `o` popup: query, highlighted row, first visible row, the recents read when it opened */
  opener: { q: string; hl: number; top: number; list: ProjectEntry[] } | null
  /** notes the document had focus with, newest first (this run only) */
  recent: readonly string[]
  /** back / forward (`H` / `L`) through the notes opened this run, each with where it was left */
  history: History<Spot>
  /** vault index build in progress: [done, total] */
  indexing: [number, number] | null
  /** bumped when the vault index changes, to re-run the search */
  ixVer: number
  /** highlighted popup row (index into ZEN_ROWS) */
  zenRow: number
  /** teleprompter auto-scroll running */
  rolling: boolean
  /** last zen keypress (ms) for Ghost chrome; null = chrome hidden */
  ghostAt: number | null
  toast: Toast | null
  /** when the hints were last shown (context change or ?) */
  hintAt: number | null
  /** the context those hints are for */
  hintCtx: Ctx
}

type Workspace = Pick<UI, "root" | "tree" | "linkTree" | "linkRoot" | "openPath" | "expanded">

/**
 * What a folder (and optionally a note in it) opens as, by the CLI's rules: a `single` note inside a
 * vault resolves links against the vault; without a note, the README or the first note opens.
 */
function workspace(root: string, note?: string | null, single = false): Workspace {
  const tree = scanTree(root)
  const vault = note && single ? findVault(root) : null
  const linkRoot = vault && vault !== root ? vault : null
  let openPath = note ?? null
  if (!openPath) {
    const top = tree.children.filter((c) => !c.dir)
    openPath = (top.find((c) => /^readme\./i.test(c.name)) ?? top[0] ?? firstFile(tree))?.path ?? null
  }
  return { root, tree, linkTree: linkRoot ? scanTree(linkRoot) : tree, linkRoot, openPath, expanded: new Set(openPath ? ancestorsOf(tree, openPath) : []) }
}

/** The folder a workspace is recorded under: the vault a single note was opened in, else the root. */
const projectRoot = (s: Pick<UI, "root" | "linkRoot">) => s.linkRoot ?? s.root

function initUI(root: string, initialFile: string | undefined, themeName: string | undefined, transparent: boolean | undefined): UI {
  const w = workspace(root, initialFile, true)
  const openPath = w.openPath
  const cfg = loadConfig()
  return {
    themeIdx: Math.max(0, themes.findIndex((x) => x.name === themeName)),
    themeOrig: null,
    ...w,
    filter: "",
    filterTyping: false,
    cursor: 0,
    listTop: { files: 0, outline: 0, info: 0 },
    infoSeen: "",
    reload: 0,
    watchGen: 0,
    source: false,
    focus: "doc",
    hidden: cfg.sidebar?.hidden ?? false,
    wide: cfg.wide ?? false,
    transparent: transparent ?? cfg.transparent ?? false,
    drawerOpen: false,
    view: cfg.sidebar?.view ?? "files",
    hl: 0,
    prompt: null,
    labels: null,
    query: "",
    matchLine: null,
    help: false,
    helpTop: 0,
    outlineFilter: "",
    outlineCur: 0,
    infoCur: 0,
    zen: false,
    zenCfg: normalizeZen(cfg.zen),
    zenOrig: null,
    zenRow: 0,
    switcher: null,
    opener: null,
    recent: openPath ? [openPath] : [],
    history: startHistory(openPath),
    indexing: null,
    ixVer: 0,
    rolling: false,
    ghostAt: null,
    reloadedAt: null,
    toast: null,
    hintAt: null,
    hintCtx: "doc",
  }
}

/**
 * Screen rows: top line, gap (H ≥ 28), body (panel + document), ghost line, progress line.
 * At DRAWER_BELOW columns and wider the panel is a column left of the document (unless hidden);
 * below that it is a drawer over the document, and the document lays out as if it were not there.
 * The document wraps at `CW` = min(available, MEASURE), centered (`wide` / zen "full": the
 * area minus a 2-column margin each side). Zen (unless Source is shown) drops the panel.
 */
function layout(W: number, H: number, s: Pick<UI, "hidden" | "drawerOpen" | "zen" | "source" | "zenCfg" | "wide">) {
  const zen = s.zen && !s.source
  const mode: "inline" | "drawer" = W < DRAWER_BELOW ? "drawer" : "inline"
  const shown = !zen && (mode === "drawer" ? s.drawerOpen : !s.hidden)
  const SW = Math.min(40, Math.max(24, Math.round(W * 0.27)))
  /** drawer width; its `▏` edge is one more column */
  const DW = Math.min(W - 8, Math.max(28, Math.min(40, Math.round(W * 0.45))))
  const inline = shown && mode === "inline"
  const gap = H >= 28 ? 1 : 0
  const bodyH = Math.max(4, H - 3 - gap)
  const areaW = W - 2 - (inline ? SW + 1 : 0)
  const want = zen ? s.zenCfg.measure : s.wide ? "full" : MEASURE
  const CW = Math.max(20, want === "full" ? areaW - 4 : Math.min(want, areaW - 4))
  return {
    zen,
    mode,
    shown,
    inline,
    SW,
    DW,
    /** panel width on screen */
    PNW: mode === "drawer" ? DW : SW,
    gap,
    bodyH,
    areaW,
    CW,
    CH: bodyH,
    /** document left margin inside its area */
    padL: Math.max(0, Math.floor((areaW - CW) / 2)),
    /** visible rows of the `/` popup list: panel padding 2, title, input, two gaps */
    PH: Math.max(1, Math.min(16, H - 2 - 6)),
  }
}

// ------------------------------------------------------------- app

export function App({ root: startRoot, initialFile, themeName, transparent }: AppProps) {
  const renderer = useRenderer()
  const { width: W, height: H } = useTerminalDimensions()
  const dims = useRef({ W, H })
  dims.current = { W, H }

  const ui = useRef<UI>(null as unknown as UI)
  if (!ui.current) ui.current = initUI(startRoot, initialFile, themeName, transparent)
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
    read: cached(readDoc),
    fm: cached(parseFrontMatter),
    doc: cached((src: string, w: number, t: Theme, _hl: number, tree: FileNode) => render(src, w, t, { exists: (x) => resolveLink(x, tree) !== null })),
    source: cached((src: string, w: number, t: Theme, tree: FileNode) => renderSource(src, w, t, { exists: (x) => resolveLink(x, tree) !== null })),
    stats: cached(stats),
    props: cached(parseProperties),
    linkTargets: cached(extractLinks),
    links: cached((targets: string[], tree: FileNode, from: string | null): LinkRef[] => targets.map((target) => ({ target, path: resolveLink(target, tree, from) }))),
    info: cached((p: Property[], st: Stats, l: LinkRef[], w: number, f: FileMeta | null) => infoItems(p, st, l, w, f)),
    linkIdx: cached((items: InfoItem[]) => items.flatMap((it, i) => (it.kind === "link" ? [i] : []))),
    rows: cached(visibleRows),
    outline: cached(outlineRows),
    rank: cached((tree: FileNode, q: string) => {
      const r = rankNotes(tree, q)
      return { total: r.total, rows: r.rows.map((x): FileRow => ({ node: x.node, depth: 0, hits: x.hits })) }
    }),
    matches: cached((view: Rendered, q: string) => findLines(view.lines.map(lineText), q)),
    geo: cached((view: Rendered): Geometry => ({ heads: view.headings.map((h) => h.line), total: view.lines.length })),
    words: cached((view: Rendered) => wordSuffix(view.plain)),
    ranges: cached((view: Rendered) => sectionRanges(view.headings.map((h) => h.line), view.lines.length)),
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
  }>({})
  /** the context the hints were last poked for */
  const ctxSeen = useRef<Ctx | null>(null)

  /** Everything computed from the store; cheap to call repeatedly thanks to `memo`. */
  const derive = () => {
    const s = ui.current
    const L = layout(dims.current.W, dims.current.H, s)
    const t = themes[s.themeIdx]!
    const file = s.openPath ? memo.read(s.openPath, s.reload) : null
    const src = file?.src ?? ""
    const fm = memo.fm(src)
    const doc = memo.doc(fm.body, L.CW, t, s.hl, s.linkTree)
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
    const infoRows = memo.info(props, st, links, L.PNW - 2, file?.info ?? null)
    const linkRows = memo.linkIdx(infoRows)
    const swRows: SwitchRow[] = s.switcher ? memo.switch(vault.current.ix, s.linkTree, s.switcher.q, s.ixVer, s.recent, s.openPath) : []
    // the highlight always sits on a hit (results change under it while typing or indexing)
    const swHl = s.switcher && swRows[s.switcher.hl] && swRows[s.switcher.hl]!.kind !== "header" ? s.switcher.hl : firstHit(swRows)
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
      title: noteTitle(props, s.openPath ?? ""),
      currentHeading,
      sideFocus,
      oRows,
      outlineCur: clampIdx(s.outlineCur, oRows.length),
    }
  }

  // ---------------------------------------------------- actions
  /** Re-render through a fade: wait out `hold` after `at()`, then step every GHOST_STEP until hidden, then `done()`. */
  const runFade = (slot: "ghost" | "hints" | "toast", at: () => number | null, hold: number, done: () => void) => {
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
    set({ view: v, filterTyping: false, outlineFilter: "", ...(v === "outline" ? { outlineCur: Math.max(0, derive().oRows.findIndex((r) => r.current)) } : {}) })
    saveSidebar({ view: v })
  }

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
  const openLink = (it: Extract<InfoItem, { kind: "link" }>) => {
    if (!it.path) return flash(`no note named “${it.target}”`)
    set({ history: keep(ui.current.history) }) // a note followed from stays in history
    openFile(it.path)
    focusDoc()
  }

  /** Labels still match what is drawn: same view object and scroll position. */
  const liveLabels = () => {
    const lb = ui.current.labels
    if (!lb) return null
    const d = derive()
    return lb.view === d.view && lb.top === d.top ? lb : null
  }

  const startLabels = () => {
    const d = derive()
    if (d.s.source) return flash("links: preview only (s)")
    const spots = visibleLinks(d.view.lines, d.top, d.L.CH)
    if (!spots.length) return flash("no links on screen")
    const labels = linkLabels(spots.length)
    set({ labels: { spots: spots.slice(0, labels.length), labels, typed: "", view: d.view, top: d.top } })
  }

  /** Open where `l` leads: the note, then its heading; a URL or a missing target only says so. */
  const followLink = (l: LinkTarget) => {
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
      if (!existsSync(e.path)) {
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
      const link = lb.view.links?.[lb.spots[left[0]!]!.link]
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

  const openTheme = () => set({ themeOrig: ui.current.themeIdx })
  const revertTheme = () => set({ themeIdx: ui.current.themeOrig ?? ui.current.themeIdx, themeOrig: null })
  const applyTheme = () => {
    const name = themes[ui.current.themeIdx]!.name
    set({ themeOrig: null })
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
    if (s.themeOrig !== null) return "theme"
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
    set({ zen: on, ghostAt: null, filterTyping: false, ...(on ? { drawerOpen: false, focus: "doc" as Focus, source: false } : {}) })
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

  /** New query: the highlight goes back to the first hit. */
  const swType = (q: string) => {
    set({ switcher: { q, hl: 0, top: 0 } })
    set({ switcher: { q, hl: Math.max(0, firstHit(derive().swRows)), top: 0 } })
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
      .catch(() => {})
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
    set({ labels: null })
    swType("")
    indexVault()
  }
  /** Open what row `row` points at: the note, its heading, or its first match in the hit's section. */
  const switchTo = (row: SwitchRow | undefined) => {
    if (!row || row.kind === "header") return
    const q = ui.current.switcher?.q.trim() ?? ""
    set({ switcher: null })
    openFile(row.path)
    focusDoc()
    if (row.kind === "note") return
    if (row.kind === "heading") {
      const h = derive().view.headings[row.heading]
      return h ? setTop(h.line) : flash(`no heading “${row.text}”`)
    }
    set({ query: q, matchLine: null })
    const { view, matches, s } = derive()
    // Source rows map to source lines; Preview has no such map, so the hit is found by counting
    // matches from the start of its section
    const from = s.source ? (view.srcRow?.[row.line] ?? 0) : row.heading === null ? 0 : (view.headings[row.heading]?.line ?? 0)
    const end = s.source ? Infinity : (view.headings[row.heading === null ? 0 : row.heading + 1]?.line ?? Infinity)
    const inSection = matches.filter((x) => x >= from && x < end)
    const doc = vault.current.ix.docs.get(row.path)
    const k = s.source || !doc ? 0 : hitOrdinal(doc, row, q)
    const m = inSection[Math.min(k, inSection.length - 1)] ?? matches.find((x) => x >= from)
    if (m !== undefined) return showMatch(m)
    setTop(from)
    flash(s.source ? `no match for “${q}”` : `“${q}” is not in the preview · s shows the source`, "error")
  }

  /**
   * Write the workspace to the recents: the open note and its Preview top with the geometry it was
   * taken at, so a reopen at another width remaps it (best effort). Zen not moved in still holds
   * the Preview's own spot in `zenBack`.
   */
  const recordProject = () => {
    const s = ui.current
    const key = `${s.openPath}:preview`
    const spot = !s.openPath ? undefined : zenBack.current?.key === key ? zenBack.current : scrolls.current.get(key)
    const pos = spot ? { top: spot.top, geo: spot.geo } : { top: 0 }
    saveProjects(rememberProject(loadProjects(), { root: projectRoot(s), lastNote: s.openPath, ...pos, at: Date.now() }))
  }
  /** The last record, on the way out: `q`, C-c and the renderer's end (OpenTUI's exit signals) all come here, once. */
  const left = useRef(false)
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
      return flash(`cannot open ${tildify(root)}: ${(e as Error).message}`, "error")
    }
    const keepNote = note && existsSync(note) ? note : null
    recordProject()
    clearTimeout(timers.current.open)
    stopRolling()
    zenBack.current = null
    dropIndex() // a build still running sees it is stale and stops
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

  const helpGo = (n: number) => set({ helpTop: Math.max(0, Math.min(HELP_ROWS.length - HELP_VIS(dims.current.W, dims.current.H), n)) })

  // ---------------------------------------------------- live reload
  const { openPath, watchGen } = ui.current
  useEffect(() => {
    if (!openPath) return
    return watchPath(openPath, {
      change: () => {
        set({ reload: ui.current.reload + 1, reloadedAt: Date.now() })
        clearTimeout(timers.current.logo)
        timers.current.logo = setTimeout(() => bump((x) => x + 1), LOGO_HOLD + 20)
        flash("reloaded from disk")
      },
      error: (msg) => flash(msg, "error"),
    })
  }, [openPath, watchGen])
  // a failed read is a toast too (the document shows the message as well)
  const { reload } = ui.current
  useEffect(() => {
    const f = derive().file
    if (f?.error) flash(f.error, "error")
  }, [openPath, reload])
  // the start is a project opened too
  useEffect(recordProject, [])
  // SIGTERM / SIGHUP (the terminal closing) end the renderer without `quit`
  useEffect(() => {
    renderer.on("destroy", leave)
    return () => void renderer.off("destroy", leave)
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
  }, [])

  // code blocks render plain first; once their parser results land, re-render the document
  const alive = useRef(true)
  const hlSeen = useRef<Rendered | null>(null)
  useEffect(() => () => void (alive.current = false), [])
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
      const v = VIEWS[Number(k.name) - 1]!
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
      const tree = scanTree(s.root)
      // folders that are gone are forgotten; the open note's path stays open
      const folders = folderCounts(tree)
      const expanded = new Set([...s.expanded].filter((p) => folders.has(p)))
      if (s.openPath) for (const a of ancestorsOf(tree, s.openPath)) expanded.add(a)
      const linkTree = s.linkRoot ? scanTree(s.linkRoot) : tree
      set({ tree, linkTree, expanded, reload: s.reload + 1, watchGen: s.watchGen + 1 })
      dropIndex()
      flash("reloaded")
    },
    clear: () => {
      const { s, sideFocus } = derive()
      if (sideFocus) {
        if (sideFocus === "files" && s.filter) return set({ filter: "" })
        if (sideFocus === "outline" && s.outlineFilter) return set({ outlineFilter: "" })
        return focusDoc()
      }
      if (s.toast?.kind === "error") set({ toast: null })
      if (s.query) set({ query: "", matchLine: null })
      else if (derive().L.zen) toggleZen(false)
    },
    help: () => (hintsVisible() ? set({ help: true, helpTop: 0 }) : pokeHints(currentCtx())),
    histBack: () => histMove(-1),
    histForward: () => histMove(1),
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
      filterType(v.slice(0, -1))
    },

    helpScroll: (k) => {
      const vis = HELP_VIS(dims.current.W, dims.current.H)
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
    promptErase: () => promptType(ui.current.prompt!.value.slice(0, -1)),
    swType: () => {},
    swMove: (k) => {
      const { swRows, swHl } = derive()
      swGo(stepRow(swRows, swHl, k.name === "down" || (k.ctrl && k.name === "n") ? 1 : -1))
    },
    swSection: () => {
      const { swRows, swHl } = derive()
      swGo(nextSection(swRows, swHl))
    },
    swOpen: () => {
      const { swRows, swHl } = derive()
      switchTo(swRows[swHl])
    },
    swClose: () => set({ switcher: null }),
    swErase: () => {
      const sw = ui.current.switcher
      if (sw) swType([...sw.q].slice(0, -1).join(""))
    },
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

    themeMove: (k) => {
      const n = themes.length
      const i = ui.current.themeIdx
      set({ themeIdx: k.name === "g" ? (k.shift ? n - 1 : 0) : (i + (isDown(k) ? 1 : -1) + n) % n })
    },
    themeApply: applyTheme,
    themeRevert: revertTheme,

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

  /** Context id outside popups and zen: the focused panel view, else the document. */
  const docMode = (): Ctx => {
    const v = derive().sideFocus
    if (v && ui.current.filterTyping) return "filter"
    return v ? `panel:${v}` : "doc"
  }
  /** KEYMAP mode of a context id (`panel:files` → `files`). */
  const modeOf = (c: Ctx): Mode => (c.startsWith("panel:") ? (c.slice(6) as Mode) : (c as Mode))

  useKeyboard((key: KeyEvent) => {
    // C-c quits the same way from every popup and mode (OpenTUI would only end the renderer)
    if (matchKey("C-c", key)) return actions.quit(key)
    const s = ui.current
    if (s.zen && s.zenCfg.ghost) pokeGhost()
    if (s.themeOrig !== null) return void dispatch(["theme"], key)
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
    // labels the view has moved out from under (reload, resize) are dropped and the key acts normally
    if (s.labels && !liveLabels()) set({ labels: null })
    else if (s.labels) {
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
    dispatch(["global", modeOf(docMode())], key)
  })

  // ---------------------------------------------------- render
  const d = derive()
  const { s, L, t, file, doc, view, rows, filtered, total, filterRow, infoRows, linkRows, swRows, swHl, LH, note, top, maxTop, matches, currentHeading, sideFocus, outlineCur, tw, pg, spot, win } = d
  const { SW, bodyH, CW, CH, padL } = L
  const { filter, cursor, query, prompt, help, themeOrig, themeIdx } = s

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
  const strip = stripLayout(L.SW)
  const stripSpans: Span[] = []
  for (const lb of strip.labels) {
    const at = 1 + spansWidth(stripSpans) // panelRow adds col 0
    if (lb.x0 > at) stripSpans.push({ text: " ".repeat(lb.x0 - at) })
    if (lb.digit) stripSpans.push({ text: lb.digit + " ", fg: t.textMuted })
    const active = lb.view === s.view
    stripSpans.push({ text: lb.text, fg: active ? (sideFocus ? t.primary : t.text) : t.textMuted, attr: active ? 1 : 0 })
  }
  const activeLabel = strip.labels.find((lb) => lb.view === s.view)!
  const rule: Span[] = [
    { text: "─".repeat(activeLabel.lx), fg: t.border },
    { text: "━".repeat(activeLabel.x1 - activeLabel.lx), fg: sideFocus ? t.primary : t.textMuted },
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
              it.kind === "link"
                ? (e) => {
                    if (e.button !== MouseButton.LEFT) return
                    focusPanel()
                    set({ infoCur: linkRows.indexOf(idx) })
                    openLink(it)
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
    const emptyMsg = `No Markdown files found in ${s.root}`
    const emptyMark = fitWordmark(L.CW, L.CH - 2)
    content = (
      <box key="empty" style={{ flexDirection: "column", paddingLeft: L.zen ? 2 : 0 }}>
        {emptyMark ? (
          <>
            {Array.from({ length: Math.floor((L.CH - emptyMark.length - 2) / 2) }, (_, i) => <Row key={"pad" + i} spans={[]} />)}
            {emptyMark.map((l, i) => <Row key={"wm" + i} spans={[{ text: " ".repeat(Math.floor((L.CW - WORDMARK_W) / 2)) + l, fg: t.primary }]} />)}
            <Row spans={[]} />
            <Row spans={[{ text: " ".repeat(Math.max(0, Math.floor((L.CW - sw(emptyMsg)) / 2))) + truncate(emptyMsg, L.CW), fg: t.textMuted }]} />
          </>
        ) : (
          <text fg={t.textMuted}>{emptyMsg}</text>
        )}
      </box>
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
    content = (
      <box key="zen-lines" style={{ flexDirection: "column", width: CW + 2, height: CH, flexShrink: 0 }}>
        {Array.from({ length: CH }, (_, i) => {
          const n = win.first + i
          const l = n >= win.lo && n < win.hi ? view.lines[n] : undefined
          let spans = l?.spans ?? []
          if (l && spot && (n < spot[0] || n >= spot[1])) spans = dimSpans(spans, t, SPOT_DIM)
          return <Row key={n} spans={[{ text: tw && n === top ? "▸ " : "  ", fg: gutter }, ...markMatches(spans, query, t)]} />
        })}
      </box>
    )
  } else {
    content = (
      <box key="lines" style={{ flexDirection: "column", width: CW, height: CH, flexShrink: 0 }}>
        {view.lines.slice(top, top + CH).map((l: Line, i) => {
          let spans = markMatches(l.spans, query, t)
          const lb = s.labels && s.labels.view === view && s.labels.top === top ? s.labels : null
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

  // ghost line (row H-2): key hints on the left, a toast on the right; blank at rest
  const pinned = ["prompt", "theme", "zenSettings", "help", "filter", "label", "switch", "open"].includes(ctxNow)
  let hintK: number | null = null
  if (pinned) hintK = 0
  else if (s.hintAt !== null && s.hintCtx === ctxNow) {
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
      const def = keyDef(id)
      items.push({ key: def.short ?? def.label, word: word ?? def.hint ?? "", spare: id === "links" || id === "histBack" })
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
  const helpVis = HELP_VIS(W, H)
  const mark = helpMark(W, H)
  const helpTopC = Math.max(0, Math.min(s.helpTop, HELP_ROWS.length - helpVis))
  const helpNote = HELP_ROWS.length > helpVis ? `j/k scroll ${helpTopC + helpVis}/${HELP_ROWS.length}` : undefined
  // title row: padding 4 each side, then the note and `esc`; the theme name goes first, then the title is cut
  const titleRoom = popupW - 2 - 8 - 2 - 3 - (helpNote ? helpNote.length + 2 : 0)
  const helpFull = `Keybindings · brothy v${VERSION} · ${t.name}`
  const helpTitle = truncate(helpFull.length <= titleRoom ? helpFull : `Keybindings · brothy v${VERSION}`, Math.max(1, titleRoom))
  const helpOverlay = help ? (
    <Overlay
      t={t}
      W={W}
      H={H}
      width={70}
      title={helpTitle}
      note={helpNote}
      onClose={() => set({ help: false })}
      onScroll={(dir) => helpGo(helpTopC + dir * 3)}
    >
      <box key="help-body" style={{ flexDirection: "column", paddingLeft: 4, paddingRight: 4 }}>
        {mark ? [...mark.map((l, i) => <Row key={"wm" + i} spans={[{ text: l, fg: t.primary }]} />), <Row key="wm-gap" spans={[]} />] : null}
        {HELP_ROWS.slice(helpTopC, helpTopC + helpVis).map(([k, desc], i) => (
          <Row
            key={i}
            spans={
              desc === "" && k
                ? [{ text: k, fg: t.text, attr: 1 }]
                : [{ text: k.padEnd(16), fg: t.text }, { text: truncate(desc, popupW - 2 - 8 - 16), fg: t.textMuted }]
            }
          />
        ))}
      </box>
    </Overlay>
  ) : null

  const switchOverlay = s.switcher ? (
    <Switcher
      t={t}
      W={W}
      H={H}
      q={s.switcher.q}
      rows={swRows}
      hl={swHl}
      top={keepVisible(s.switcher.top, Math.max(0, swHl), L.PH, swRows.length)}
      height={L.PH}
      note={s.indexing ? `indexing ${s.indexing[0]}/${s.indexing[1]}` : plural(folderCounts(s.linkTree).get(s.linkTree.path) ?? 0, "note")}
      onClose={() => set({ switcher: null })}
      onScroll={(dir) => swGo(stepRow(swRows, swHl, dir))}
      onHover={(i) => i !== swHl && ui.current.switcher && set({ switcher: { ...ui.current.switcher, hl: i } })}
      onActivate={(i) => switchTo(swRows[i])}
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

  // `t` picker: live preview while moving, Enter keeps, Esc reverts
  // the picker window: 4 rows of overlay chrome plus a margin; scrolls to keep the highlight centred
  const themeRows = Math.max(3, Math.min(themes.length, H - 6))
  const themeTop = Math.max(0, Math.min(themes.length - themeRows, themeIdx - (themeRows >> 1)))
  const themeOverlay =
    themeOrig !== null ? (
      <Overlay
        t={t}
        W={W}
        H={H}
        width={Math.min(48, W - 2)}
        title="Themes"
        onClose={revertTheme}
        onScroll={(dir) => set({ themeIdx: (ui.current.themeIdx + dir + themes.length) % themes.length })}
      >
        <PickerList
          t={t}
          items={themes.map((th, i) => ({
            spans: [
              { text: th.name.padEnd(18), fg: t.text },
              { text: "  ", bg: th.primary },
              { text: " " },
              { text: "  ", bg: th.secondary },
              { text: " " },
              { text: "  ", bg: th.accent },
            ],
            right: i === themeOrig ? "current" : th.mode,
          }))}
          hl={themeIdx}
          top={themeTop}
          height={themeRows}
          innerW={Math.min(48, W - 2) - 2}
          onHover={(i) => i !== themeIdx && set({ themeIdx: i })}
          onActivate={(i) => {
            set({ themeIdx: i })
            applyTheme()
          }}
        />
      </Overlay>
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
      <box key="zen" style={{ width: W, height: H, flexDirection: "column", backgroundColor: paint.main }}>
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
    <box key="main" style={{ width: W, height: H, flexDirection: "column", backgroundColor: paint.main }}>
      {topRow(0)}
      {gapRow()}
      <box style={{ flexDirection: "row", height: bodyH, paddingLeft: 1, paddingRight: 1, gap: 1 }}>
        {L.inline ? panelBox : null}
        {docEl}
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
