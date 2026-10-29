// What a folder opens as: its Files tree, the tree links resolve against and the first note; the piped document's
// stand-in. Reads the folder (`scanTree`, `findVault`), otherwise pure.
import { basename } from "node:path"
import { ancestorsOf, findVault, firstFile, scanTree, type FileNode } from "./files"

/** The open path of the piped document: relative, so it can never be a file on disk. */
export const STDIN = "stdin"

/** The store fields a workspace sets (the app's `UI` holds them); every rebuild replaces all of them. */
export interface Workspace {
  root: string
  tree: FileNode
  linkTree: FileNode
  linkLazy: boolean
  piped: boolean
  linkRoot: string | null
  openPath: string | null
  expanded: Set<string>
}

/**
 * What a folder (and optionally a note in it) opens as, by the CLI's rules: a `single` note inside a
 * vault resolves links against the vault; without a note, the README or the first note opens.
 */
export function workspace(root: string, note?: string | null, single = false): Workspace {
  const tree = scanTree(root)
  const vault = note && single ? findVault(root) : null
  const linkRoot = vault && vault !== root ? vault : null
  let openPath = note ?? null
  if (!openPath) {
    const top = tree.children.filter((c) => !c.dir)
    openPath = (top.find((c) => /^readme\./i.test(c.name)) ?? top[0] ?? firstFile(tree))?.path ?? null
  }
  return {
    root,
    tree,
    linkTree: linkRoot ? scanTree(linkRoot) : tree,
    linkLazy: false,
    piped: false,
    linkRoot,
    openPath,
    expanded: new Set(openPath ? ancestorsOf(tree, openPath) : []),
  }
}

/** The piped document: an empty Files tree; links resolve against the notes under `root`, scanned on first use (`ensureLinks`). */
export function stdinWorkspace(root: string): Workspace {
  const tree: FileNode = { name: basename(root) || root, path: root, rel: "", dir: true, children: [] }
  return { root, tree, linkTree: tree, linkLazy: true, piped: true, linkRoot: null, openPath: STDIN, expanded: new Set() }
}

/** The folder a workspace is recorded under: the vault a single note was opened in, else the root. */
export const projectRoot = (s: Pick<Workspace, "root" | "linkRoot">) => s.linkRoot ?? s.root
