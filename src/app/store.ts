// The app's store: the one mutable UI object every handler reads at call time, its parts and the app's tunables. No React.
import type { AIConfig } from "../ai"
import type { AskState, Candidate } from "../ask"
import type { View } from "../config"
import type { Change, DeltaNote } from "../delta"
import type { FileNode, TreeRow } from "../files"
import type { History } from "../history"
import type { HeadingStyle } from "../markdown"
import type { Geometry, LinkSpot } from "../nav"
import type { ProjectEntry } from "../projects"
import type { Toast } from "../status"
import type { Glosses, Summaries } from "../summaries"
import type { ThemePick } from "../themepick"
import type { ZenConfig } from "../zen"
import type { Ctx } from "./keymap"

/** Sidebar j/k opens the file under the cursor once it rests this long. */
export const OPEN_DELAY = 100
/** No candidates: one shared empty list, so the ask memos hold */
export const NO_CANDS: readonly Candidate[] = []
/** Zen chrome without Ghost: the top line stays, mixed this far toward the background. */
export const ZEN_DIM = 0.5
/** Scrim: the document under an open drawer is mixed this far toward the background. */
export const SCRIM_DIM = 0.62
/** Tree indent stops growing here; deeper rows keep this indent and cut the name. */
export const MAX_DEPTH = 6

/** Where keys go: the panel (when shown) or the document. */
export type Focus = "doc" | "panel"
/** Find popup: `hl` is the highlighted row; -1 means "not moved yet". */
export type Prompt = { value: string; hl: number; top: number } | null
/** A Files list row; filter results carry the matched code points of the note's name. */
export type FileRow = TreeRow & { hits?: number[] }

/** Where a note was left: its scroll entry (Preview or Source key) at that moment. */
export type Spot = { key: string; top: number; geo: Geometry }
/** The open note's body (`noteText`) and properties when it was opened or last explained; memory only. */
export type Baseline = { path: string; text: string; props: string; at: number }
/** `D` for `path`: the changes sent, the text and properties they lead to, and the reply once it is in. */
export type DeltaState = { path: string; changes: Change[]; text: string; props: string; result: { summary: string; notes: (DeltaNote | undefined)[]; model: string } | null }
/** No changes or notes: shared empty lists, so the Info memo holds */
export const NO_CHANGES: Change[] = []
export const NO_NOTES: (DeltaNote | undefined)[] = []

/**
 * All UI state lives in one mutable store read at call time, so key handlers never act
 * on a stale render (keys arriving faster than frames used to be dropped).
 */
export interface UI {
  themeIdx: number
  /** the `t` picker while open; the app keeps `themeIdx` until ⏎ */
  themePick: ThemePick | null
  /** the workspace folder (Files lists it; `o` replaces it) */
  root: string
  tree: FileNode
  /** where wikilinks resolve: the enclosing vault when a single note was opened inside one, else `tree` */
  linkTree: FileNode
  /** a piped document's `linkTree` is a placeholder until the first link use scans the folder */
  linkLazy: boolean
  /** the session started on stdin and no `o` has replaced it, whichever note is open: no Files tab, no saved view, no project record */
  piped: boolean
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
  /** braille minimap on (saved by m; drawn from MINI_MIN_W columns, never in zen) */
  minimap: boolean
  /** heading style (saved by #) */
  headings: HeadingStyle
  /** main surfaces unpainted: the terminal background shows through (saved by T) */
  transparent: boolean
  /** animations on (prop, else config `motion`; always off under `bun test` unless the prop is given) */
  motion: boolean
  /** drawer open (below DRAWER_BELOW; never saved) */
  drawerOpen: boolean
  /** panel view shown */
  view: View
  /** bumped when code-block highlighting lands, to re-render the document */
  hl: number
  prompt: Prompt
  /** link labels on screen (`f`); dropped when the note, the mode, the width or the scroll position changes (`labelGeo`) */
  labels: { spots: LinkSpot[]; labels: string[]; typed: string; geo: string } | null
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
  /** `C-p` popup: query, highlighted row, first visible row; `ask` while a `?` question has been asked */
  switcher: { q: string; hl: number; top: number; ask?: AskState } | null
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
  /** the config's `ai` block, re-read on every `a` (null: AI off) */
  ai: AIConfig | null
  /** summaries.json, loaded once at start, keyed by absolute note path */
  summaries: Summaries
  /** glosses.json, read on the first zen entry (or zen `a`) with an `ai` block; null: not read yet */
  glosses: Glosses | null
  /** the zen gloss sheet: its section id, cache key, label, the section's text hash when shown, and when it began fading */
  gloss: { id: string; key: string; heading: string; hash: string; fadeAt: number | null } | null
  /** what the open note's change list compares against (dropped on leaving the note) */
  baseline: Baseline | null
  /** the explanation running or shown for `baseline.path` */
  delta: DeltaState | null
}
