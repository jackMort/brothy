// The Markdown tree: the scan (`scanTree`, the only disk access), its rows and counts, and the fuzzy name scoring and ranking the filters and switcher use.

import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, relative, sep } from "node:path"
import { safeLine } from "../lib/spans"

export interface FileNode {
  name: string // display-safe (control characters replaced)
  path: string // absolute, as on disk
  rel: string // relative to root, display-safe
  dir: boolean
  children: FileNode[]
  /** A symlink whose target lies outside the scanned root. */
  outside?: boolean
  /** Set on the root when the scan hit the entry cap and the tree is partial. */
  truncated?: boolean
}

const MD_EXT = /\.(md|markdown|mdx|mdown|mkd)$/i
const SKIP = new Set(["node_modules"])
/** Directory entries examined per scan before giving up (keeps `brothy ~` responsive). */
export const SCAN_LIMIT = 20_000

/** Dot-entries are hidden, except `.github` (it holds docs worth reading). */
const skipped = (name: string) => SKIP.has(name) || (name.startsWith(".") && name !== ".github")

export const isMarkdown = (path: string) => MD_EXT.test(path)

/** The nearest folder at or above `dir` that holds an Obsidian `.obsidian/` folder, else null. */
export function findVault(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    try {
      if (statSync(join(d, ".obsidian")).isDirectory()) return d
    } catch {}
    if (dirname(d) === d) return null
  }
}

/** One `scanTree` run: the root, the realpaths already walked and the entry budget spent so far. */
interface Scan {
  root: string
  rootReal: string | null
  visited: Set<string>
  seen: number
  truncated: boolean
  maxDepth: number
  maxEntries: number
}

const realOf = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** `entries` without the names that aren't valid UTF-8: they decode to U+FFFD and could never be opened by that string. */
function decodable(dir: string, entries: Dirent[]): Dirent[] {
  if (!entries.some((e) => e.name.includes("\uFFFD"))) return entries
  const bad = new Set<string>()
  try {
    for (const b of readdirSync(dir, { encoding: "buffer" })) {
      const text = b.toString("utf8")
      if (!Buffer.from(text, "utf8").equals(b)) bad.add(text)
    }
  } catch {}
  return bad.size ? entries.filter((e) => !bad.has(e.name)) : entries
}

/** `dir`'s entries in walk order, or null when it cannot be read. */
function readEntries(dir: string): Dirent[] | null {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  entries = decodable(dir, entries)
  // real directories before symlinks, so an alias never claims a subtree first
  entries.sort((a, b) => +a.isSymbolicLink() - +b.isSymbolicLink() || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return entries
}

/** Whether an entry is a directory or a file, a symlink by its target; null for a link that cannot be followed. */
function entryType(ent: Dirent, full: string): { dir: boolean; file: boolean } | null {
  if (!ent.isSymbolicLink()) return { dir: ent.isDirectory(), file: ent.isFile() }
  try {
    const st = statSync(full)
    return { dir: st.isDirectory(), file: st.isFile() }
  } catch {
    return null
  }
}

/** A subfolder's node; null when it is too deep, already walked, a link into the tree, or holds no Markdown. */
function subfolder(s: Scan, ent: Dirent, full: string, depth: number): FileNode | null {
  if (depth >= s.maxDepth) return null
  const rp = realOf(full)
  if (!rp || s.visited.has(rp)) return null
  // links into (or around) the tree alias directories the walk reaches anyway
  if (ent.isSymbolicLink() && s.rootReal && (rp.startsWith(s.rootReal + sep) || s.rootReal.startsWith(rp + sep)))
    return null
  s.visited.add(rp)
  const sub = walkDir(s, full, depth + 1)
  if (!sub || sub.children.length === 0) return null
  return ent.isSymbolicLink() ? { ...sub, outside: true } : sub
}

/** A note's node, flagged `outside` when it is a symlink to a file beyond the root. */
function noteNode(s: Scan, ent: Dirent, full: string): FileNode {
  const rp = ent.isSymbolicLink() ? realOf(full) : null
  const outside = !!rp && !!s.rootReal && !rp.startsWith(s.rootReal + sep)
  return {
    name: safeLine(ent.name),
    path: full,
    rel: safeLine(relative(s.root, full)),
    dir: false,
    children: [],
    ...(outside ? { outside } : {}),
  }
}

/** README first, then natural order. */
function byName(a: FileNode, b: FileNode) {
  const ra = /^readme\./i.test(a.name) ? 0 : 1
  const rb = /^readme\./i.test(b.name) ? 0 : 1
  return ra - rb || a.name.localeCompare(b.name, undefined, { numeric: true })
}

/** `dir` as a folder node, subfolders before notes; null when it cannot be read. */
function walkDir(s: Scan, dir: string, depth: number): FileNode | null {
  const entries = readEntries(dir)
  if (!entries) return null
  const dirs: FileNode[] = []
  const files: FileNode[] = []
  for (const ent of entries) {
    if (skipped(ent.name)) continue
    if (++s.seen > s.maxEntries) {
      s.truncated = true
      break
    }
    const full = join(dir, ent.name)
    const type = entryType(ent, full)
    if (!type) continue
    if (type.dir) {
      const sub = subfolder(s, ent, full, depth)
      if (sub) dirs.push(sub)
    } else if (type.file && MD_EXT.test(ent.name)) files.push(noteNode(s, ent, full))
  }
  dirs.sort(byName)
  files.sort(byName)
  return {
    name: safeLine(basename(dir)),
    path: dir,
    rel: safeLine(relative(s.root, dir)),
    dir: true,
    children: [...dirs, ...files],
  }
}

/**
 * Recursively collect Markdown files; folders without Markdown are dropped.
 * Symlinked directories are followed only when they leave the tree, and once
 * per realpath, so loops and aliases never duplicate a subtree. At most `maxEntries` directory entries are
 * examined; past that the scan stops and the root is flagged `truncated`.
 */
export function scanTree(root: string, maxDepth = 8, maxEntries = SCAN_LIMIT): FileNode {
  const rootReal = realOf(root)
  const s: Scan = { root, rootReal, visited: new Set<string>(), seen: 0, truncated: false, maxDepth, maxEntries }
  if (rootReal) s.visited.add(rootReal)
  const tree = walkDir(s, root, 0) ?? { name: safeLine(basename(root)), path: root, rel: "", dir: true, children: [] }
  if (s.truncated) tree.truncated = true
  return tree
}

export interface TreeRow {
  node: FileNode
  depth: number
}

/** The first note, top level before folders, else the first in the first folder that has one; null for an empty tree. */
export function firstFile(root: FileNode): FileNode | null {
  for (const c of root.children) if (!c.dir) return c
  for (const c of root.children) {
    const f = c.dir ? firstFile(c) : null
    if (f) return f
  }
  return null
}

/** A note's display name: the file name without its Markdown extension. */
export const stem = (name: string) => name.replace(MD_EXT, "")

/** Last folder of a note's relative path ("" at the root). */
export const folderOf = (n: Pick<FileNode, "rel">) => (n.rel.includes(sep) ? basename(dirname(n.rel)) : "")

/** Tree rows to show: every folder starts closed; `expanded` holds the open ones (absolute paths). */
export function visibleRows(root: FileNode, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (n: FileNode, depth: number) => {
    for (const c of n.children) {
      rows.push({ node: c, depth })
      if (c.dir && expanded.has(c.path)) walk(c, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/** Folders (absolute paths, outermost first) that hold `absPath`; the root is not included. */
export function ancestorsOf(root: FileNode, absPath: string): string[] {
  const out: string[] = []
  let n: FileNode | undefined = root
  while (n) {
    n = n.children.find((c) => c.dir && absPath.startsWith(c.path + sep))
    if (n) out.push(n.path)
  }
  return out
}

const countCache = new WeakMap<FileNode, Map<string, number>>()
/** Notes under every folder (recursive), by absolute path; memoized per scanned tree. */
export function folderCounts(root: FileNode): Map<string, number> {
  const hit = countCache.get(root)
  if (hit) return hit
  const map = new Map<string, number>()
  const walk = (n: FileNode): number => {
    let k = 0
    for (const c of n.children) k += c.dir ? walk(c) : 1
    map.set(n.path, k)
    return k
  }
  walk(root)
  countCache.set(root, map)
  return map
}

const fold = (s: string) => [...s].map((c) => c.toLowerCase())

/**
 * Code-point indexes where `needle` occurs in `hay` as a subsequence, case-folded; null when it
 * does not. The span is tightened: the latest start that still ends at the first full match.
 */
export function fuzzyHits(hay: string, needle: string): number[] | null {
  const h = fold(hay)
  const n = fold(needle)
  if (!n.length) return []
  let i = 0
  let end = -1
  for (let j = 0; j < h.length; j++)
    if (h[j] === n[i] && ++i === n.length) {
      end = j
      break
    }
  if (end < 0) return null
  let k = n.length - 1
  let start = end
  for (let j = end; j >= 0; j--)
    if (h[j] === n[k] && --k < 0) {
      start = j
      break
    }
  const hits: number[] = []
  i = 0
  for (let j = start; j <= end && i < n.length; j++)
    if (h[j] === n[i]) {
      hits.push(j)
      i++
    }
  return hits
}

function indexOfSeq(h: string[], n: string[]): number {
  outer: for (let i = 0; i + n.length <= h.length; i++) {
    for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) continue outer
    return i
  }
  return -1
}

/** Score tiers of `scoreName`: a substring always beats a subsequence, which beats a match only in the path or an alias. */
const SCORE_SUBSTRING = 3e6
export const SCORE_SUBSEQUENCE = 2e6
export const SCORE_PATH = 1e6
/** a subsequence loses this much per code point of span */
const SPAN_PENALTY = 1e3
/** An alias match keeps 1/ALIAS_DAMP of its distance above `SCORE_PATH`, so it ranks between a name match and a path match. */
const ALIAS_DAMP = 10

/**
 * How well `needle` matches `name`, or null: a substring (earlier is better) beats a
 * subsequence (tighter span, then earlier start). Hits are code-point indexes into `name`.
 */
export function scoreName(name: string, needle: string): { hits: number[]; score: number } | null {
  const q = needle.trim()
  const nq = fold(q)
  if (!nq.length) return null
  const at = indexOfSeq(fold(name), nq)
  if (at >= 0) return { hits: nq.map((_, j) => at + j), score: SCORE_SUBSTRING - at }
  const hits = fuzzyHits(name, q)
  return hits
    ? { hits, score: SCORE_SUBSEQUENCE - (hits[hits.length - 1]! - hits[0]!) * SPAN_PENALTY - hits[0]! }
    : null
}

export interface RankedNote {
  node: FileNode
  /** code-point indexes into `stem(node.name)` */
  hits: number[]
  score: number
  /** the frontmatter alias that matched, when the name did not */
  alias?: { text: string; hits: number[] }
}

/**
 * Notes matching `q`, best first: the name (a substring beats a subsequence: tighter span,
 * then earlier start), then an alias from `aliases`, then a match only in the folder path.
 * Ties go to the shorter name, then alphabetical. At most `limit` rows; `total` counts every match.
 */
export function rankNotes(
  root: FileNode,
  q: string,
  limit = 500,
  aliases?: (node: FileNode) => readonly string[],
): { rows: RankedNote[]; total: number } {
  const needle = q.trim()
  if (!needle) return { rows: [], total: 0 }
  const out: RankedNote[] = []
  const walk = (n: FileNode) => {
    for (const c of n.children) {
      if (c.dir) {
        walk(c)
        continue
      }
      const m = scoreName(stem(c.name), needle)
      if (m) {
        out.push({ node: c, ...m })
        continue
      }
      let best: { text: string; hits: number[]; score: number } | null = null
      for (const text of aliases?.(c) ?? []) {
        const a = scoreName(text, needle)
        if (a && (!best || a.score > best.score)) best = { text, ...a }
      }
      if (best)
        out.push({
          node: c,
          hits: [],
          score: SCORE_PATH + (best.score - SCORE_PATH) / ALIAS_DAMP,
          alias: { text: best.text, hits: best.hits },
        })
      else if (fuzzyHits(stem(c.rel), needle)) out.push({ node: c, hits: [], score: SCORE_PATH })
    }
  }
  walk(root)
  const len = (r: RankedNote) => [...stem(r.node.name)].length
  out.sort((a, b) => b.score - a.score || len(a) - len(b) || stem(a.node.name).localeCompare(stem(b.node.name)))
  return { rows: out.slice(0, limit), total: out.length }
}
