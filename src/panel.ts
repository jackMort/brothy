// Panel views (Outline, Info): pure row data. Span styling stays in App; Files rows come from files.ts.

import { dirname, resolve, sep } from "node:path"
import type { Change, DeltaNote } from "./delta"
import { fuzzyHits, isMarkdown, stem, type FileNode } from "./files"
import { stripCode, wrap, width as sw, type LinkTarget, type Property, type Stats } from "./markdown"
import { safeLine } from "./spans"
import { truncate } from "./status"

// ------------------------------------------------------------- formatting

export const fmtNum = (n: number) => n.toLocaleString("en-US")
export const plural = (n: number, word: string) => `${fmtNum(n)} ${word}${n === 1 ? "" : "s"}`

export function fmtSize(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export function fmtAge(d: Date, now = Date.now()) {
  const s = (now - d.getTime()) / 1000
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${plural(Math.floor(s / 3600), "hour")} ago`
  if (s < 86400 * 30) return `${plural(Math.floor(s / 86400), "day")} ago`
  return d.toLocaleDateString()
}

// ------------------------------------------------------------- outline

export interface OutlineRow {
  /** index into the headings */
  index: number
  text: string
  /** columns: 2 per level below the shallowest heading */
  indent: number
  /** 0 = shallowest depth, 1 = one below, 2 = deeper */
  level: 0 | 1 | 2
  /** above the reading heading */
  read: boolean
  /** the reading heading */
  current: boolean
  /** matched code points (filter) */
  hits: number[]
}

/** One row per heading, or per matching heading (document order) when `filter` is set. */
export function outlineRows(headings: { depth: number; text: string }[], current: number, filter = ""): OutlineRow[] {
  const min = Math.min(...headings.map((h) => h.depth))
  const q = filter.trim()
  const out: OutlineRow[] = []
  headings.forEach((h, index) => {
    const hits = q ? fuzzyHits(h.text, q) : []
    if (!hits) return
    const d = h.depth - min
    out.push({ index, text: h.text, indent: 2 * d, level: d === 0 ? 0 : d === 1 ? 1 : 2, read: index < current, current: index === current, hits })
  })
  return out
}

// ------------------------------------------------------------- info

/** One screen row of the Info view. */
export type InfoItem =
  | { kind: "prop"; key: string; keyW: number; text: string }
  | { kind: "chips"; key: string; keyW: number; tags: string[]; more?: boolean }
  | { kind: "label"; text: string }
  | { kind: "link"; target: string; path: string | null }
  | { kind: "more"; n: number }
  | { kind: "stat"; text: string }
  | { kind: "blank" }
  | { kind: "tldr"; status: string }
  | { kind: "summary"; text: string; muted: boolean }
  | { kind: "changes"; status: string }
  | { kind: "change"; mark: "~" | "+" | "−"; text: string; counts: string; at: number; stop: boolean }

export interface LinkRef {
  target: string
  /** absolute path of the resolved note; null when unresolved */
  path: string | null
}
export interface FileMeta {
  size: number
  mtime: Date
}

const MAX_PROP_ROWS = 4
export const MAX_LINKS = 8
const TAG_KEYS = new Set(["tags", "tag"])
const ORDER = ["title", "aliases", "tags", "date", "created", "modified"]

/** Rows for one property: the key on the first row, values wrapped under the value column, 4 rows at most. */
export function wrapProperty(key: string, value: string | string[], width: number, keyW: number): InfoItem[] {
  const room = Math.max(4, width - keyW)
  const k = truncate(key, keyW - 1)
  let rows: InfoItem[]
  if (TAG_KEYS.has(key.toLowerCase())) {
    const tags = (Array.isArray(value) ? value : value.split(/[\s,]+/)).map((x) => x.replace(/^#/, "")).filter(Boolean)
    const lines: string[][] = []
    let w = 0
    for (const tg of tags) {
      const cw = Math.min(room, sw(tg) + 1) // "#tag"
      if (lines.length && w + 1 + cw <= room) {
        lines[lines.length - 1]!.push(tg)
        w += 1 + cw
      } else {
        lines.push([tg])
        w = cw
      }
    }
    rows = lines.map((tg, i): InfoItem => ({ kind: "chips", key: i ? "" : k, keyW, tags: tg }))
  } else {
    const text = Array.isArray(value) ? value.join(" · ") : value
    rows = wrap([{ text }], room).map((r, i): InfoItem => ({ kind: "prop", key: i ? "" : k, keyW, text: r.map((s) => s.text).join("") }))
  }
  if (!rows.length) rows = [{ kind: "prop", key: k, keyW, text: "" }]
  if (rows.length > MAX_PROP_ROWS) {
    rows = rows.slice(0, MAX_PROP_ROWS)
    const last = rows[MAX_PROP_ROWS - 1]!
    if (last.kind === "prop") last.text = truncate(`${last.text} …`, room)
    else if (last.kind === "chips") last.more = true
  }
  return rows
}

/** Summary text rows shown at most; the last is cut with `…`. */
export const SUMMARY_ROWS = 8
export type SummaryState = "none" | "streaming" | "fresh" | "outdated"
/** What the Info tab shows for the note's TL;DR; `model` is the display name. */
export interface SummaryView {
  text: string
  state: SummaryState
  model: string
}

const OUTDATED = " · outdated · a to refresh"

/** The TL;DR label row (muted suffix by state) and the wrapped text (spec: Mockups, Variant A). */
export function tldrItems(sv: SummaryView, width: number): InfoItem[] {
  const label = "TL;DR"
  const status =
    sv.state === "streaming"
      ? " · summarizing…"
      : sv.state === "fresh"
        ? truncate(" · " + sv.model, width - sw(label))
        : sv.state === "outdated"
          ? sw(label + OUTDATED) <= width ? OUTDATED : " · outdated · a"
          : ""
  const out: InfoItem[] = [{ kind: "tldr", status }]
  if (sv.state === "none") return [...out, { kind: "summary", text: "a to summarize", muted: true }]
  const rows = wrap([{ text: safeLine(sv.text) }], width).map((r) => r.map((s) => s.text).join(""))
  const shown = rows.slice(0, SUMMARY_ROWS)
  if (rows.length > SUMMARY_ROWS) shown[SUMMARY_ROWS - 1] = truncate(shown[SUMMARY_ROWS - 1]! + "…", width)
  for (const text of shown) out.push({ kind: "summary", text, muted: sv.state === "outdated" })
  return out
}

/** Change rows shown at most; the rest are counted in a `+ n more sections` row. */
export const MAX_CHANGE_ROWS = 8
/** Summary rows under the `Changed` label; the last is cut with `…`. */
export const CHANGE_SUMMARY_ROWS = 3
export type ChangeState = "idle" | "loading" | "result"
/** What Info shows for a live reload: `label` is the baseline's HH:MM (idle) or the model's display name (result). */
export interface ChangeView {
  state: ChangeState
  label: string
  changes: readonly Change[]
  summary: string
  notes: readonly (DeltaNote | undefined)[]
}
const MARK = { edited: "~", added: "+", removed: "−" } as const

/** `+a −r`, one side omitted when zero. */
export const changeCounts = (c: Pick<Change, "plus" | "minus">) => [c.plus ? `+${c.plus}` : "", c.minus ? `−${c.minus}` : ""].filter(Boolean).join(" ")

/** The `Changed` block (spec: Strings): label, summary, then a row per change with its model line under it. */
export function changeItems(cv: ChangeView, title: string, width: number): InfoItem[] {
  const label = "Changed"
  const status = cv.state === "loading" ? " · explaining…" : cv.state === "result" ? truncate(" · " + cv.label, width - sw(label)) : ` · since ${cv.label}`
  const out: InfoItem[] = [{ kind: "changes", status }]
  if (cv.state !== "idle" && cv.summary) {
    const rows = wrap([{ text: safeLine(cv.summary) }], width).map((r) => r.map((s) => s.text).join(""))
    const shown = rows.slice(0, CHANGE_SUMMARY_ROWS)
    if (rows.length > CHANGE_SUMMARY_ROWS) shown[CHANGE_SUMMARY_ROWS - 1] = truncate(shown[CHANGE_SUMMARY_ROWS - 1]! + "…", width)
    for (const text of shown) out.push({ kind: "summary", text, muted: true })
  }
  cv.changes.slice(0, MAX_CHANGE_ROWS).forEach((c, at) => {
    const counts = changeCounts(c)
    const room = Math.max(1, width - 2 - (counts ? sw(counts) + 1 : 0))
    const name = truncate(safeLine(c.index < 0 || !c.path.length ? title : c.path.at(-1)!), room)
    const text = name + " ".repeat(Math.max(0, room - sw(name)) + (counts ? 1 : 0))
    out.push({ kind: "change", mark: MARK[c.status], text, counts, at, stop: c.status !== "removed" })
    const what = cv.state === "idle" ? undefined : cv.notes[at]?.what
    if (what) out.push({ kind: "summary", text: truncate("    " + safeLine(what), width), muted: true })
  })
  if (cv.changes.length > MAX_CHANGE_ROWS) out.push({ kind: "stat", text: `+ ${cv.changes.length - MAX_CHANGE_ROWS} more sections` })
  return out
}

/** The Info view, top to bottom: the TL;DR block (AI on), the Changed block (after a reload), properties, links, then three stat lines. */
export function infoItems(props: Property[], st: Stats, links: LinkRef[], width: number, file: FileMeta | null, now = Date.now(), summary?: SummaryView, changes?: { view: ChangeView; title: string }): InfoItem[] {
  const out: InfoItem[] = summary ? [...tldrItems(summary, width), { kind: "blank" }] : []
  if (changes) out.push(...changeItems(changes.view, changes.title, width), { kind: "blank" })
  const rank = (k: string) => {
    const i = ORDER.indexOf(k.toLowerCase())
    return i < 0 ? ORDER.length : i
  }
  const sorted = props
    .map((p, i) => [p, i] as const)
    .sort((a, b) => rank(a[0][0]) - rank(b[0][0]) || a[1] - b[1])
    .map(([p]) => p)
  if (sorted.length) {
    const keyW = Math.min(8, Math.max(...sorted.map(([k]) => sw(k)))) + 1
    for (const [k, v] of sorted) out.push(...wrapProperty(k, v, width, keyW))
    out.push({ kind: "blank" })
  }
  if (links.length) {
    out.push({ kind: "label", text: "Links" })
    for (const l of links.slice(0, MAX_LINKS)) out.push({ kind: "link", target: l.target, path: l.path })
    if (links.length > MAX_LINKS) out.push({ kind: "more", n: links.length - MAX_LINKS })
    out.push({ kind: "blank" })
  }
  out.push({ kind: "stat", text: `${plural(st.words, "word")} · ${st.minutes} min read` })
  const counts = [
    st.headings ? plural(st.headings, "heading") : "",
    st.tasks[1] ? `${st.tasks[0]}/${st.tasks[1]} tasks` : "",
    st.tables ? plural(st.tables, "table") : "",
  ].filter(Boolean)
  if (counts.length) out.push({ kind: "stat", text: counts.join(" · ") })
  if (file) out.push({ kind: "stat", text: `${fmtSize(file.size)} · edited ${fmtAge(file.mtime, now)}` })
  return out
}

// ------------------------------------------------------------- links

/** Distinct outgoing wikilink targets, in order: `[[t]]`, `[[t|alias]]`, `[[t#h]]`, and `![[t]]` embeds of notes. Code is skipped. */
export function extractLinks(body: string): string[] {
  const text = stripCode(body)
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[2]!.split("|")[0]!.split(/[#^]/)[0]!.trim()
    if (!target) continue
    if (m[1] && /\.[^/.]+$/.test(target) && !isMarkdown(target)) continue // images and other files
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}

export interface NoteIndex {
  /** lowercase rel path without extension, "/"-separated → absolute path (first wins) */
  byRel: Map<string, string>
  /** lowercase note name → its notes (absolute path, lowercase "/"-joined rel stem) */
  byName: Map<string, { path: string; rel: string }[]>
  byPath: Set<string>
}
const indexes = new WeakMap<FileNode, NoteIndex>()

/** Every note under `tree`, indexed for link resolution; built once per scanned tree. */
export function noteIndex(tree: FileNode): NoteIndex {
  const hit = indexes.get(tree)
  if (hit) return hit
  const ix: NoteIndex = { byRel: new Map(), byName: new Map(), byPath: new Set() }
  const walk = (n: FileNode) => {
    for (const c of n.children) {
      if (c.dir) walk(c)
      else {
        const rel = stem(c.rel.split(sep).join("/")).toLowerCase()
        if (!ix.byRel.has(rel)) ix.byRel.set(rel, c.path)
        const name = stem(c.name).toLowerCase()
        ix.byName.set(name, [...(ix.byName.get(name) ?? []), { path: c.path, rel }])
        ix.byPath.add(c.path)
      }
    }
  }
  walk(tree)
  indexes.set(tree, ix)
  return ix
}

/**
 * Resolve a wikilink like Obsidian does: the exact relative path (extension optional) first,
 * else a note of that name. Among several, a path suffix (`[[q/take]]`) narrows them, then a note
 * in the folder of `from` (the linking note) wins, then the shortest path, then alphabetical.
 */
export function resolveLink(target: string, tree: FileNode, from?: string | null): string | null {
  const ix = noteIndex(tree)
  const want = stem(target.replace(/\\/g, "/").replace(/^\.?\//, "")).toLowerCase()
  const exact = ix.byRel.get(want)
  if (exact) return exact
  let named = ix.byName.get(want.split("/").at(-1)!) ?? []
  if (named.length > 1 && want.includes("/")) {
    const tail = named.filter((n) => n.rel.endsWith("/" + want))
    if (tail.length) named = tail
  }
  if (named.length < 2) return named[0]?.path ?? null
  const here = from ? named.filter((n) => dirname(n.path) === dirname(from)) : []
  if (here.length) return here[0]!.path
  return named.reduce((a, b) => (b.rel.length < a.rel.length || (b.rel.length === a.rel.length && b.rel < a.rel) ? b : a)).path
}

export interface LinkDest {
  /** note to open (null: not found, or a URL) */
  path: string | null
  heading?: string
  /** what to name in a "not found" toast */
  label: string
  url?: string
}

/** Where following `l` from the note `from` leads. */
export function linkDest(l: LinkTarget, from: string | null, tree: FileNode): LinkDest {
  if (l.kind === "url") return { path: null, label: l.href, url: l.href }
  if (l.kind === "wiki") {
    if (!l.target) return { path: from, ...(l.heading ? { heading: l.heading } : {}), label: l.heading ?? "" }
    return { path: resolveLink(l.target, tree, from), ...(l.heading ? { heading: l.heading } : {}), label: l.target }
  }
  let href = l.href
  try {
    href = decodeURIComponent(href)
  } catch {}
  href = safeLine(href) // `%1b` decodes to ESC
  const hash = href.indexOf("#")
  const file = hash >= 0 ? href.slice(0, hash) : href
  const heading = hash >= 0 ? href.slice(hash + 1) : ""
  const h = heading ? { heading } : {}
  if (!file) return { path: from, ...h, label: heading }
  if (!from) return { path: null, ...h, label: file }
  const abs = resolve(dirname(from), file)
  const ix = noteIndex(tree)
  const path = ix.byPath.has(abs) ? abs : ix.byPath.has(abs + ".md") ? abs + ".md" : null
  return { path, ...h, label: file }
}

/** Heading text as a lenient key: lowercase, `#` dropped, dashes and runs of spaces as one space, punctuation removed. */
export const headingKey = (s: string) =>
  s.normalize("NFC").toLowerCase().replace(/#/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/[\s-]+/g, " ").trim()

/** Index of the first heading matching `wanted` by `headingKey`, else null. */
export function findHeading(headings: { text: string }[], wanted: string): number | null {
  const k = headingKey(wanted)
  const i = headings.findIndex((h) => headingKey(h.text) === k)
  return i < 0 ? null : i
}
