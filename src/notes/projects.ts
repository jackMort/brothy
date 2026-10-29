// Recent projects (`projects.json` next to `config.json`) and the `o` picker's rows: the recents
// filtered by the query, plus directory entries when the query looks like a path. Pure apart from
// load/save; listing a directory goes through an injectable `DirIO`.

import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { configPath } from "../system/config"
import { SCORE_PATH, fuzzyHits, isMarkdown, scoreName } from "./files"
import { isRecord, readJSON, writeFileAtomic } from "../lib/json"
import type { Geometry } from "../markdown/render"

/** Entries kept; the oldest go first. */
export const PROJECTS_CAP = 20
/** Path rows listed at most. */
export const PATH_CAP = 50

export interface ProjectEntry {
  /** absolute workspace folder */
  root: string
  /** absolute path of the note open when it was left */
  lastNote: string | null
  /** that note's Preview scroll line */
  top: number
  /** the layout `top` was measured in, so a different width can `remapTop` it (absent in old entries) */
  geo?: Geometry
  /** when it was last opened or left (ms) */
  at: number
}

export const projectsPath = () => join(dirname(configPath()), "projects.json")

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0

/** A stored `Geometry`, or undefined when any part is malformed. */
function pickGeometry(raw: unknown): Geometry | undefined {
  if (!isRecord(raw)) return undefined
  const { heads, total } = raw
  return Array.isArray(heads) && heads.every(isCount) && isCount(total) ? { heads: heads as number[], total } : undefined
}

/** One stored entry with bad fields defaulted; null when it is not an object or has no absolute `root`. */
function pickEntry(r: unknown): ProjectEntry | null {
  if (!isRecord(r)) return null
  const { root, lastNote, top, at, geo } = r
  if (typeof root !== "string" || !isAbsolute(root)) return null
  const g = pickGeometry(geo)
  return {
    root,
    lastNote: typeof lastNote === "string" && isAbsolute(lastNote) ? lastNote : null,
    top: isCount(top) ? top : 0,
    ...(g ? { geo: g } : {}),
    at: typeof at === "number" && Number.isFinite(at) ? at : 0,
  }
}

/** The valid entries of a raw `projects` value: bad ones dropped, bad fields defaulted, deduped, capped. */
function pickProjects(raw: unknown): ProjectEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ProjectEntry[] = []
  for (const r of raw) {
    const e = pickEntry(r)
    if (!e || out.some((x) => x.root === e.root)) continue
    out.push(e)
    if (out.length === PROJECTS_CAP) break
  }
  return out
}

/** Recents, newest first; a missing or broken file is an empty list. */
export function loadProjects(): ProjectEntry[] {
  const f = readJSON(projectsPath())
  return f.kind === "ok" && isRecord(f.value) ? pickProjects(f.value.projects) : []
}

/** Best effort: a broken file is replaced (it holds no settings), a write error is ignored. */
export function saveProjects(list: readonly ProjectEntry[]) {
  try {
    writeFileAtomic(projectsPath(), JSON.stringify({ projects: list }, null, 2) + "\n")
  } catch {}
}

/** `e` first, any older entry for its root dropped, at most `cap` kept. */
export const remember = (list: readonly ProjectEntry[], e: ProjectEntry, cap = PROJECTS_CAP): ProjectEntry[] =>
  [e, ...list.filter((x) => x.root !== e.root)].slice(0, cap)

export const projectName = (root: string) => basename(root) || root

/** `~` for the home folder and paths under it. */
export function tildify(p: string, home = homedir()): string {
  if (p === home) return "~"
  return p.startsWith(home + sep) ? "~" + p.slice(home.length) : p
}

/** A leading `~` or `~/` as the home folder; anything else unchanged. */
export function expandTilde(q: string, home = homedir()): string {
  if (q === "~") return home
  return q.startsWith("~/") ? home + q.slice(1) : q
}

/** The query is a path (and gets the Path section): it starts with `/`, `~` or `.`. */
export const looksLikePath = (q: string) => /^[/~.]/.test(q)

export interface RankedProject {
  entry: ProjectEntry
  name: string
  /** code-point indexes into `name` */
  hits: number[]
  score: number
}

/** Recents matching `q` by name, then by `~`-path; ties keep the list order (newest first). */
export function rankProjects(list: readonly ProjectEntry[], q: string, home = homedir()): RankedProject[] {
  const needle = q.trim()
  const out: RankedProject[] = []
  for (const entry of list) {
    const name = projectName(entry.root)
    if (!needle) {
      out.push({ entry, name, hits: [], score: 0 })
      continue
    }
    const m = scoreName(name, needle)
    if (m) out.push({ entry, name, ...m })
    else if (fuzzyHits(tildify(entry.root, home), needle)) out.push({ entry, name, hits: [], score: SCORE_PATH })
  }
  return out.sort((a, b) => b.score - a.score) // stable: equal scores stay newest first
}

/** Directory listing; null when it cannot be read. */
export interface DirIO {
  list(dir: string): { name: string; dir: boolean }[] | null
}

/** The real filesystem; a symlink counts as what it points at. */
export const fsDirIO: DirIO = {
  list(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((d) => {
        let isDir = d.isDirectory()
        if (d.isSymbolicLink())
          try {
            isDir = statSync(join(dir, d.name)).isDirectory()
          } catch {}
        return { name: d.name, dir: isDir }
      })
    } catch {
      return null
    }
  },
}

export interface PathHit {
  /** absolute */
  path: string
  name: string
  dir: boolean
  /** code-point indexes into `name` */
  hits: number[]
  /** the query `tab` turns into: the typed folder part plus the name (dirs end in `/`) */
  completion: string
  /** the typed folder itself (the query ends in `/`) */
  self?: boolean
}

/**
 * Entries of the folder the query names, matching its last segment: folders and Markdown files,
 * dot-entries only once the segment starts with a dot. With nothing after the last `/` the folder
 * itself comes first. `~`, `.` and `..` alone mean that folder; relative paths resolve against `cwd`.
 */
export function pathCompletions(query: string, io: DirIO, o: { cwd: string; home?: string }, cap = PATH_CAP): PathHit[] {
  const home = o.home ?? homedir()
  const q = query === "~" || query === "." || query === ".." ? query + "/" : query
  const cut = q.lastIndexOf("/") + 1
  const head = q.slice(0, cut)
  const prefix = q.slice(cut)
  const dir = resolve(o.cwd, expandTilde(head, home))
  const entries = io.list(dir)
  if (!entries) return []
  const hits: (PathHit & { score: number })[] = []
  for (const e of entries) {
    if (e.name.startsWith(".") && !prefix.startsWith(".")) continue
    if (!e.dir && !isMarkdown(e.name)) continue
    const m = prefix ? scoreName(e.name, prefix) : { hits: [], score: 0 }
    if (!m) continue
    hits.push({ path: join(dir, e.name), name: e.name, dir: e.dir, hits: m.hits, score: m.score, completion: head + e.name + (e.dir ? "/" : "") })
  }
  hits.sort((a, b) => b.score - a.score || Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  const rows: PathHit[] = hits.slice(0, cap).map(({ score: _, ...h }) => h)
  return prefix ? rows : [{ path: dir, name: head, dir: true, hits: [], completion: head, self: true }, ...rows]
}

export type OpenRow = { kind: "header"; title: string; count: string } | ({ kind: "recent"; missing: boolean } & RankedProject) | ({ kind: "path" } & PathHit)

/**
 * The picker's rows: Recent (all but `current`) matching `q` fuzzily. A path-looking `q` lists the
 * Path section first (⏎ opens what was typed), and Recent keeps only the projects under that path.
 */
export function openRows(
  list: readonly ProjectEntry[],
  q: string,
  o: { cwd: string; home?: string; io: DirIO; exists: (p: string) => boolean; current?: string | null },
): OpenRow[] {
  const rows: OpenRow[] = []
  const query = q.trim()
  const isPath = looksLikePath(query)
  let all: PathHit[] = []
  if (isPath) {
    // one past the cap, to know whether there is more
    all = pathCompletions(query, o.io, o, PATH_CAP + 1)
    const more = all.filter((p) => !p.self).length > PATH_CAP
    const paths = more ? all.slice(0, -1) : all
    if (paths.length) {
      const n = paths.filter((p) => !p.self).length
      rows.push({ kind: "header", title: "Path", count: more ? `${PATH_CAP}+` : String(n) })
      for (const p of paths) rows.push({ kind: "path", ...p })
    }
  }
  const others = list.filter((e) => e.root !== o.current)
  const typed = isPath ? resolve(o.cwd, expandTilde(query, o.home ?? homedir())) : ""
  // under the typed folder; a half-typed name (`~/Doc`) stands for the folders it completes to,
  // unless it already names one (`~/notes` must not list `~/notes-archive`)
  const dirs = all.filter((p) => p.dir && !p.self).map((p) => p.path)
  const bases = dirs.includes(typed) ? [typed] : [typed, ...dirs]
  const under = (root: string) => bases.some((b) => root === b || root.startsWith(b.endsWith(sep) ? b : b + sep))
  const recent = isPath
    ? rankProjects(
        others.filter((e) => under(e.root)),
        "",
        o.home,
      )
    : rankProjects(others, query, o.home)
  if (recent.length) {
    rows.push({ kind: "header", title: "Recent", count: String(recent.length) })
    for (const r of recent) rows.push({ kind: "recent", missing: !o.exists(r.entry.root), ...r })
  }
  return rows
}
