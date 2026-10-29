// The cache store under $XDG_CACHE_HOME/brothy (summaries.json, glosses.json): merge-on-save, newest entry wins, pruned to a cap.
// Split from client.ts so system/config.ts and client.ts do not import each other.
import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { PROMPT_V } from "./config"
import { cacheHome, isRecord, readJSON, writeFileAtomic } from "../lib/json"

/** Every cache entry carries its time (epoch ms): the newest wins on merge, the oldest goes on prune. */
export interface Stamped {
  at: number
}
/** What a cache keeps from its file. */
export type IsEntry<T> = (e: unknown) => e is T

/** A cached model reply: `hash` is of the text sent, `v` the prompt version, `model` the configured name; the reply sits under `K`. */
export type Cached<K extends string> = Stamped & { hash: string; v: number; model: string } & Record<K, string>

/** The guard for `Cached<K>`: the fields are checked, `at` must be a finite number. */
const isCached =
  <K extends string>(field: K): IsEntry<Cached<K>> =>
  (e): e is Cached<K> => {
    if (!isRecord(e)) return false
    return typeof e.hash === "string" && typeof e.v === "number" && typeof e[field] === "string" && typeof e.model === "string" && Number.isFinite(e.at)
  }

/** `$XDG_CACHE_HOME/brothy/<name>.json`, resolved on every call (tests point XDG_CACHE_HOME at a temp dir); a relative XDG path is ignored. */
export function cacheFile(name: string): string {
  return join(cacheHome(), "brothy", `${name}.json`)
}

/** The file's valid entries, keyed by absolute path (a gloss key starts with one); a missing or unparsable file is empty. */
export function loadCache<T extends Stamped>(name: string, isEntry: IsEntry<T>): Record<string, T> {
  const f = readJSON(cacheFile(name))
  if (f.kind !== "ok" || !isRecord(f.value)) return {}
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(f.value)) if (isAbsolute(k) && isEntry(v)) out[k] = v
  return out
}

/** The newest `cap` entries by `at`. */
function pruneCache<T extends Stamped>(all: Record<string, T>, cap: number): Record<string, T> {
  return Object.fromEntries(
    Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, cap),
  )
}

/**
 * Re-read the file, overlay `add` (newest `at` wins per key, so another instance's entries
 * survive), prune to `cap` and write atomically: folder 0700, new file 0600. False when it can't write.
 */
export function saveCache<T extends Stamped>(name: string, add: Record<string, T>, cap: number, isEntry: IsEntry<T>): boolean {
  const merged = loadCache(name, isEntry)
  for (const [k, v] of Object.entries(add)) if (!merged[k] || merged[k]!.at <= v.at) merged[k] = v
  try {
    const file = cacheFile(name)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileAtomic(file, JSON.stringify(pruneCache(merged, cap)) + "\n", 0o600)
    return true
  } catch {
    return false
  }
}

/** One cached TL;DR; `model` is the configured name, `at` epoch ms. */
export type Summary = Cached<"summary">
/** Keyed by absolute note path. */
export type Summaries = Record<string, Summary>
export const CACHE_CAP = 500

/** The summaries file. */
export const cachePath = () => cacheFile("summaries")

const isSummary = isCached("summary")

export const loadSummaries = (): Summaries => loadCache("summaries", isSummary)
export const pruneSummaries = (all: Summaries, cap = CACHE_CAP): Summaries => pruneCache(all, cap)
export const saveSummaries = (add: Summaries): boolean => saveCache("summaries", add, CACHE_CAP, isSummary)

/** Content, not mtime: touches, sync and checkouts change mtime without changing text. */
export const textHash = (text: string) => Bun.hash(text).toString(16)

/** The model that made it doesn't matter; the text and the prompt version do. */
export const isFresh = (e: { hash: string; v: number }, hash: string, v: number = PROMPT_V) => e.hash === hash && e.v === v

/** One cached zen gloss; `hash` is of the exact section text sent (before clipping), `v` is `PROMPTS.gloss`. */
export type Gloss = Cached<"gloss">
/** Keyed by `glossKey(sectionId, style)`: absolute path + `#key#ord#style`. */
export type Glosses = Record<string, Gloss>
export const GLOSS_CAP = 2000

const isGloss = isCached("gloss")

/** glosses.json's valid entries; read on the first zen entry with an `ai` block. */
export const loadGlosses = (): Glosses => loadCache("glosses", isGloss)
/** Merge-on-save, newest GLOSS_CAP kept; false when it can't write. */
export const saveGlosses = (add: Glosses): boolean => saveCache("glosses", add, GLOSS_CAP, isGloss)
