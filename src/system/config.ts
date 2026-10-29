// config.json under $XDG_CONFIG_HOME/brothy: validated load, merge-on-save that refuses to overwrite a file that does not parse.
import { join } from "node:path"
import { normalizeAI, type AIConfig } from "../ai/config"
import { configHome, isRecord, readJSON, writeFileAtomic } from "../lib/json"
import { HEADING_STYLES, type HeadingStyle } from "../markdown/heading-style"
import { pickZen, type ZenConfig } from "../ui/zen"

/** Panel views, in tab-strip (and `1 2 3`) order. */
export type View = "files" | "outline" | "info"
export const VIEWS: readonly View[] = ["files", "outline", "info"]

/** Panel layout that persists: the view shown and whether the inline panel is hidden. */
export interface SidebarConfig {
  view: View
  hidden: boolean
}

export interface Config {
  theme?: string
  /** Legacy key: pass `undefined` in a patch to drop it from the file. */
  folds?: undefined
  /** Panel view and inline visibility. */
  sidebar?: Partial<SidebarConfig>
  /** Full-width document instead of the fixed measure. */
  wide?: boolean
  /** Leave the main background unpainted so the terminal's shows through. */
  transparent?: boolean
  /** Animations (the welcome ink-in and steam); default on. */
  motion?: boolean
  /** Braille minimap at the right edge (shown from 110 columns); default on. */
  minimap?: boolean
  /** Heading style (`#` cycles); default classic. */
  headings?: HeadingStyle
  /** Zen mode settings (whether zen is on is never saved). */
  zen?: Partial<ZenConfig>
  /** Opt-in AI summaries; never patched by brothy (keys come only from the environment). */
  ai?: AIConfig
}

/** Resolved on every call so env changes apply; relative XDG paths are ignored per the spec. */
export function configPath(): string {
  return join(configHome(), "brothy", "config.json")
}

type Raw = Record<string, unknown>

/** `null` means the file exists but is unreadable or not a JSON object. */
function readRaw(): Raw | null {
  const f = readJSON(configPath(), { lenient: true })
  if (f.kind === "missing") return {}
  return f.kind === "ok" && isRecord(f.value) ? f.value : null
}

/** The valid fields of a raw `sidebar` value. */
function pickSidebar(raw: unknown): Partial<SidebarConfig> {
  if (!isRecord(raw)) return {}
  const out: Partial<SidebarConfig> = {}
  if (VIEWS.includes(raw.view as View)) out.view = raw.view as View
  if (typeof raw.hidden === "boolean") out.hidden = raw.hidden
  return out
}

/** Legacy `folds` → `sidebar`: the first open section is the view; nothing open means hidden. */
function migrateFolds(folds: Partial<Record<View, boolean>>): Partial<SidebarConfig> {
  const f = { files: true, outline: true, info: false, ...folds }
  const view = VIEWS.find((v) => f[v])
  return view ? { view, hidden: false } : { hidden: true }
}

export function loadConfig(): Config {
  const raw = readRaw()
  const out: Config = {}
  if (!raw) return out
  if (typeof raw.theme === "string") out.theme = raw.theme
  if (typeof raw.wide === "boolean") out.wide = raw.wide
  if (typeof raw.transparent === "boolean") out.transparent = raw.transparent
  if (typeof raw.motion === "boolean") out.motion = raw.motion
  if (typeof raw.minimap === "boolean") out.minimap = raw.minimap
  if (typeof raw.headings === "string" && (HEADING_STYLES as readonly string[]).includes(raw.headings)) out.headings = raw.headings as HeadingStyle
  let folds: Partial<Record<View, boolean>> | undefined
  const f = raw.folds
  if (isRecord(f)) {
    const ok: Partial<Record<View, boolean>> = {}
    for (const k of VIEWS) if (typeof f[k] === "boolean") ok[k] = f[k] as boolean
    if (Object.keys(ok).length) folds = ok
  }
  if (raw.sidebar !== undefined) {
    const sb = pickSidebar(raw.sidebar)
    if (Object.keys(sb).length) out.sidebar = sb
  } else if (folds) out.sidebar = migrateFolds(folds)
  const zen = pickZen(raw.zen)
  if (Object.keys(zen).length) out.zen = zen
  const ai = normalizeAI(raw.ai)
  if (ai) out.ai = ai
  return out
}

/**
 * Merge `patch` into the file: top-level keys replace, except object-valued ones (`sidebar`,
 * `zen`) merge one level, so a patch of one field leaves what another instance saved. Returns
 * whether the file was written; false means it exists but doesn't parse (left alone) or the
 * write failed (read-only home).
 */
export function saveConfig(patch: Config): boolean {
  const current = readRaw()
  if (!current) return false
  const next: Raw = { ...current }
  for (const [k, v] of Object.entries(patch)) next[k] = isRecord(v) && isRecord(current[k]) ? { ...current[k], ...v } : v
  try {
    writeFileAtomic(configPath(), JSON.stringify(next, null, 2) + "\n")
    return true
  } catch {
    return false
  }
}
