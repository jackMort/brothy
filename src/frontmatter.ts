// Front matter: the `---` block at the top of a note, as plain entries (Info) and as Obsidian-style properties.
// Pure.

import { normalize } from "./lexer"
import { safeLine } from "./spans"

export interface FrontMatter {
  entries: [string, string][]
  body: string
  offset: number // number of source lines consumed by front matter
}

const FRONT = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

export function parseFrontMatter(src: string): FrontMatter {
  src = normalize(src)
  const m = FRONT.exec(src)
  if (!m) return { entries: [], body: src, offset: 0 }
  const entries: [string, string][] = []
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(line)
    if (kv) entries.push([kv[1]!, safeLine(kv[2]!.replace(/^["']|["']$/g, ""))])
  }
  return { entries, body: src.slice(m[0].length), offset: m[0].replace(/\r?\n$/, "").split("\n").length }
}

export type Property = [string, string | string[]]
/** Keys whose plain `a, b` values are lists (Obsidian writes `tags: a, b`). */
const LIST_KEYS = new Set(["tags", "tag", "aliases", "alias", "cssclasses"])
const unquote = (s: string) => {
  const t = safeLine(s).trim()
  return t.length >= 2 && /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t
}

/**
 * Front-matter properties, tolerant of the YAML Obsidian writes: `k: v` scalars (quotes
 * stripped), flow lists `[a, b]`, comma lists for list-like keys, and block lists (`k:` then
 * `  - a` lines). Other nested YAML is skipped.
 */
export function parseProperties(src: string): Property[] {
  const m = FRONT.exec(normalize(src))
  if (!m) return []
  const lines = (m[1] ?? "").split(/\r?\n/)
  const out: Property[] = []
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    const key = kv[1]!
    const raw = kv[2]!.trim()
    if (raw === "") {
      const items: string[] = []
      while (i + 1 < lines.length && /^\s*-(\s|$)/.test(lines[i + 1]!)) {
        const item = unquote(lines[++i]!.replace(/^\s*-\s*/, ""))
        if (item) items.push(item)
      }
      out.push([key, items.length ? items : ""])
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      out.push([key, raw.slice(1, -1).split(",").map(unquote).filter(Boolean)])
    } else if (LIST_KEYS.has(key.toLowerCase()) && raw.includes(",")) {
      out.push([key, raw.split(",").map(unquote).filter(Boolean)])
    } else out.push([key, unquote(raw)])
  }
  return out
}
