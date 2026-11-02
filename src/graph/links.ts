// The note link graph: who links to whom, from the vault index's wikilink targets resolved against the link tree. Pure.
import type { FileNode } from "../notes/files"
import type { VaultIndex } from "../notes/vault"
import { resolveLink } from "../ui/panel"

/** Links between notes by absolute path, both ways; a target no note answers is kept by its text under `unresolved`. */
export interface LinkGraph {
  out: Map<string, Set<string>>
  back: Map<string, Set<string>>
  unresolved: Map<string, string[]>
  /** notes in the index */
  notes: number
}

const add = (m: Map<string, Set<string>>, k: string, v: string) => {
  const s = m.get(k)
  if (s) s.add(v)
  else m.set(k, new Set([v]))
}

/** `from`'s targets into `g`: a link to itself is dropped, an unresolved one kept. */
function linkNote(g: LinkGraph, tree: FileNode, from: string, targets: readonly string[]) {
  const missing: string[] = []
  for (const target of targets) {
    const to = resolveLink(target, tree, from)
    if (to === from) continue
    if (!to) missing.push(target)
    else {
      add(g.out, from, to)
      add(g.back, to, from)
    }
  }
  if (missing.length) g.unresolved.set(from, missing)
}

/** The graph of every indexed note; `live` (the open note as read, e.g. piped) replaces or adds one note's targets. */
export function buildLinks(
  ix: VaultIndex,
  tree: FileNode,
  live: { path: string; targets: readonly string[] } | null = null,
): LinkGraph {
  const g: LinkGraph = { out: new Map(), back: new Map(), unresolved: new Map(), notes: ix.docs.size }
  for (const [path, doc] of ix.docs) if (path !== live?.path) linkNote(g, tree, path, doc.links)
  if (live) linkNote(g, tree, live.path, live.targets)
  return g
}

/** Links in and out of `path`. */
export const degree = (g: LinkGraph, path: string) => (g.out.get(path)?.size ?? 0) + (g.back.get(path)?.size ?? 0)
