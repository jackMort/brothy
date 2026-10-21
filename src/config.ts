import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { pickZen, type ZenConfig } from "./zen"

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
  /** Zen mode settings (whether zen is on is never saved). */
  zen?: Partial<ZenConfig>
}

/** Resolved on every call so env changes apply; relative XDG paths are ignored per the spec. */
export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config")
  return join(base, "brothy", "config.json")
}

type Raw = Record<string, unknown>

/** `null` means the file exists but is unreadable or not a JSON object. */
function readRaw(): Raw | null {
  let text: string
  try {
    text = readFileSync(configPath(), "utf8")
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : null
  }
  text = text.replace(/^\uFEFF/, "")
  if (!text.trim()) return {}
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null
  } catch {
    return null
  }
}

/** The valid fields of a raw `sidebar` value. */
export function pickSidebar(raw: unknown): Partial<SidebarConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const r = raw as Raw
  const out: Partial<SidebarConfig> = {}
  if (VIEWS.includes(r.view as View)) out.view = r.view as View
  if (typeof r.hidden === "boolean") out.hidden = r.hidden
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
  let folds: Partial<Record<View, boolean>> | undefined
  const f = raw.folds
  if (f && typeof f === "object" && !Array.isArray(f)) {
    const ok: Partial<Record<View, boolean>> = {}
    for (const k of VIEWS) if (typeof (f as Raw)[k] === "boolean") ok[k] = (f as Raw)[k] as boolean
    if (Object.keys(ok).length) folds = ok
  }
  if (raw.sidebar !== undefined) {
    const sb = pickSidebar(raw.sidebar)
    if (Object.keys(sb).length) out.sidebar = sb
  } else if (folds) out.sidebar = migrateFolds(folds)
  const zen = pickZen(raw.zen)
  if (Object.keys(zen).length) out.zen = zen
  return out
}

/**
 * Write via a temp file in the target's own folder and rename over it. A symlinked file is
 * followed (the link survives, its target is replaced) and the old mode is kept. Throws on failure.
 */
export function writeFileAtomic(file: string, text: string) {
  let target = file
  let mode: number | undefined
  try {
    target = realpathSync(file)
    mode = statSync(target).mode & 0o7777
  } catch {
    // new file (or a dangling link): plain write
  }
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  if (mode !== undefined) chmodSync(tmp, mode)
  renameSync(tmp, target)
}

const isObject = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * Merge `patch` into the file: top-level keys replace, except object-valued ones (`sidebar`,
 * `zen`) merge one level, so a patch of one field leaves what another instance saved. Returns
 * whether the file was written; false means it exists but doesn't parse (left alone) or the
 * write failed (read-only home).
 */
export function saveConfig(patch: Config): boolean {
  const current = readRaw()
  if (!current) return false // exists but invalid: leave the user's file alone
  const next: Raw = { ...current }
  for (const [k, v] of Object.entries(patch)) next[k] = isObject(v) && isObject(current[k]) ? { ...current[k], ...v } : v
  try {
    writeFileAtomic(configPath(), JSON.stringify(next, null, 2) + "\n")
    return true
  } catch {
    return false
  }
}
