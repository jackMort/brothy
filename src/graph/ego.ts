// The ego graph: the centre note and the notes within one or two links of it, capped, nearest first, then the best
// connected, then by name. Pure.
import { basename } from "node:path"
import { safeLine } from "../lib/spans"
import { stem } from "../notes/files"
import { STDIN } from "../notes/workspace"
import { degree, type LinkGraph } from "./links"

/** Neighbours drawn at depth 1 (the rest are listed), and nodes drawn in all at depth 2. */
export const CAP_NEAR = 18
export const CAP_ALL = 40

/** How a node is linked to the centre (depth 1) or to the depth-1 note that brought it in (depth 2). */
export type Dir = "out" | "in" | "both" | "unresolved"

export interface EgoNode {
  /** absolute path; an unresolved target is `?` + its text */
  path: string
  name: string
  depth: 0 | 1 | 2
  /** null for the centre */
  dir: Dir | null
  /** links in and out in the whole graph */
  degree: number
  /** a depth-2 node's depth-1 note; -1 otherwise */
  parent: number
}
/** A link between two drawn nodes, `a < b`. */
export interface EgoEdge {
  a: number
  b: number
}
export interface Ego {
  /** the centre first, then depth 1, then depth 2 */
  nodes: EgoNode[]
  edges: EgoEdge[]
  /** depth-1 neighbours past CAP_NEAR: listed, not drawn */
  rest: EgoNode[]
  counts: { back: number; out: number; unresolved: number }
}

/** What a note is called in the sheet: its file's stem; a piped document is `stdin`. */
export const noteName = (path: string) => (path === STDIN ? STDIN : safeLine(stem(basename(path))))

const cmp = (a: string, b: string) => Number(a > b) - Number(a < b)

const dirOf = (g: LinkGraph, from: string, to: string): Dir => {
  const out = g.out.get(from)?.has(to) ?? false
  const back = g.back.get(from)?.has(to) ?? false
  if (out && back) return "both"
  return out ? "out" : "in"
}

/** `p`'s linked notes, best connected first, then by name. */
function linked(g: LinkGraph, p: string): string[] {
  const all = new Set([...(g.out.get(p) ?? []), ...(g.back.get(p) ?? [])])
  return [...all].sort(
    (a, b) => degree(g, b) - degree(g, a) || cmp(noteName(a).toLowerCase(), noteName(b).toLowerCase()) || cmp(a, b),
  )
}

const node = (g: LinkGraph, path: string, depth: 0 | 1 | 2, dir: Dir | null, parent: number): EgoNode => ({
  path,
  name: noteName(path),
  depth,
  dir,
  degree: degree(g, path),
  parent,
})

/** Every depth-1 neighbour: the linked notes, then the unresolved targets. */
function near(g: LinkGraph, centre: string): EgoNode[] {
  const notes = linked(g, centre).map((p) => node(g, p, 1, dirOf(g, centre, p), -1))
  const missing = (g.unresolved.get(centre) ?? []).map(
    (target): EgoNode => ({
      path: `?${target}`,
      name: safeLine(target),
      depth: 1,
      dir: "unresolved",
      degree: 0,
      parent: -1,
    }),
  )
  return [...notes, ...missing]
}

/** The notes the drawn depth-1 notes link with, in their order, until CAP_ALL. */
function far(g: LinkGraph, nodes: readonly EgoNode[]): EgoNode[] {
  const seen = new Set(nodes.map((n) => n.path))
  const out: EgoNode[] = []
  nodes.forEach((n, i) => {
    if (n.depth !== 1 || n.dir === "unresolved") return
    for (const p of linked(g, n.path)) {
      if (seen.has(p) || nodes.length + out.length >= CAP_ALL) continue
      seen.add(p)
      out.push(node(g, p, 2, dirOf(g, n.path, p), i))
    }
  })
  return out
}

/** Every link between drawn nodes, once per pair; an unresolved node hangs off the centre. */
function edgesOf(g: LinkGraph, nodes: readonly EgoNode[]): EgoEdge[] {
  const at = new Map(nodes.map((n, i) => [n.path, i]))
  const seen = new Set<string>()
  const edges: EgoEdge[] = []
  const link = (x: number, y: number) => {
    const [a, b] = x < y ? [x, y] : [y, x]
    if (a === b || seen.has(`${a}:${b}`)) return
    seen.add(`${a}:${b}`)
    edges.push({ a, b })
  }
  nodes.forEach((n, i) => {
    if (n.dir === "unresolved") link(0, i)
    for (const p of g.out.get(n.path) ?? []) {
      const j = at.get(p)
      if (j !== undefined) link(i, j)
    }
  })
  return edges
}

/** `centre` and its neighbourhood to `depth`. */
export function egoGraph(g: LinkGraph, centre: string, depth: 1 | 2): Ego {
  const all = near(g, centre)
  const nodes = [node(g, centre, 0, null, -1), ...all.slice(0, CAP_NEAR)]
  if (depth === 2) nodes.push(...far(g, nodes))
  return {
    nodes,
    edges: edgesOf(g, nodes),
    rest: all.slice(CAP_NEAR),
    counts: {
      back: g.back.get(centre)?.size ?? 0,
      out: g.out.get(centre)?.size ?? 0,
      unresolved: g.unresolved.get(centre)?.length ?? 0,
    },
  }
}
