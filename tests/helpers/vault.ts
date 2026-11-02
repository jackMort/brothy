// In-memory vaults for the index and graph tests: a tree from paths, IO over a map, and two fixtures. Nothing runs at import.
import type { FileNode } from "../../src/notes/files"
import { emptyIndex, type IndexIO, indexNote, type VaultIndex } from "../../src/notes/vault"

/** An in-memory tree under /v from "dir/name.md" paths (folders created on the way). */
export function treeOf(rels: string[]): FileNode {
  const root: FileNode = { name: "v", path: "/v", rel: "", dir: true, children: [] }
  for (const rel of rels) {
    const parts = rel.split("/")
    let dir = root
    parts.slice(0, -1).forEach((p, k) => {
      const r = parts.slice(0, k + 1).join("/")
      let d = dir.children.find((c) => c.dir && c.rel === r)
      if (!d) dir.children.push((d = { name: p, path: "/v/" + r, rel: r, dir: true, children: [] }))
      dir = d
    })
    dir.children.push({ name: parts.at(-1)!, path: "/v/" + rel, rel, dir: false, children: [] })
  }
  return root
}

/** IO over a map of "rel" → source; `mtimes` overrides the default mtime 1; `reads` logs every read. */
export function memIO(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  const reads: string[] = []
  const io: IndexIO = {
    stat: (p) => {
      const rel = p.slice(3)
      return rel in files ? { mtime: mtimes[rel] ?? 1, size: files[rel]!.length } : null
    },
    read: async (p) => {
      const rel = p.slice(3)
      reads.push(rel)
      if (files[rel] === undefined) throw new Error("gone")
      return files[rel]!
    },
  }
  return { io, reads }
}

/** The tree of `files`' paths under /v and their index, every note at mtime 1. */
export function vaultOf(files: Record<string, string>): { tree: FileNode; ix: VaultIndex } {
  const ix = emptyIndex()
  for (const [rel, src] of Object.entries(files)) ix.docs.set(`/v/${rel}`, indexNote(src, 1, src.length))
  return { tree: treeOf(Object.keys(files)), ix }
}

/**
 * Six notes: Broth links to Stock, Simmering, itself and a missing Nowhere; Stock links back and to Bones; Garnish
 * links to Broth; Lonely links nowhere and nothing links to it.
 */
export const KITCHEN: Record<string, string> = {
  "Broth.md": "# Broth\n\n[[Stock]] and [[Simmering]], also [[Broth]] and [[Nowhere]].\n",
  "Stock.md": "# Stock\n\nBack to [[Broth]]. See [[Bones]].\n",
  "Simmering.md": "# Simmering\n\nslow\n",
  "Bones.md": "# Bones\n\nroast\n",
  "Garnish.md": "# Garnish\n\nOn top of [[Broth]].\n",
  "Lonely.md": "# Lonely\n\nno links\n",
}

/** A hub linking to 25 notes `n00`–`n24`, each linking to two leaves of its own: past both caps. */
export function hubVault() {
  return vaultOf(hubFiles())
}

/** hubVault's notes by "rel" (76 in all). */
export function hubFiles(): Record<string, string> {
  const pad = (i: number) => String(i).padStart(2, "0")
  const files: Record<string, string> = {
    "Hub.md": `# Hub\n${Array.from({ length: 25 }, (_, i) => `[[n${pad(i)}]]`).join(" ")}\n`,
  }
  for (let i = 0; i < 25; i++) {
    files[`n${pad(i)}.md`] = `# n${pad(i)}\n[[a${pad(i)}]] [[b${pad(i)}]]\n`
    files[`a${pad(i)}.md`] = "# a\n"
    files[`b${pad(i)}.md`] = "# b\n"
  }
  return files
}
