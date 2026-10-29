// `e`: the editor command for the open note ($VISUAL, $EDITOR, else vi), the source line it opens at, and the suspend / spawn / resume
// around it. Pure apart from `runEditor`, which goes through an injectable `EditorIO`.
import { basename } from "node:path"
import { clamp } from "../lib/text"
import type { Heading } from "../markdown/render"

interface SourceLineAt {
  source: boolean
  /** first visible row */
  top: number
  /** Source view: the first row of each source line */
  srcRow?: number[]
  /** Preview: the rendered headings, the Source outline (same order) and the front matter's line count */
  headings?: Heading[]
  scan?: { line: number }[]
  offset?: number
}

/**
 * The 1-based source line to open the editor at for the row at the top of the view. Source is exact;
 * Preview counts rows from the nearest heading above (wrapping and tables make it approximate) and
 * stops short of the next heading.
 */
export function sourceLineAt(v: SourceLineAt): number {
  if (v.source) {
    const rows = v.srcRow ?? []
    let lo = 0
    for (let i = 0; i < rows.length; i++) if (rows[i]! <= v.top) lo = i
    return lo + 1
  }
  const heads = v.headings ?? []
  const scan = v.scan ?? []
  let k = -1
  for (let i = 0; i < heads.length; i++) if (heads[i]!.line <= v.top) k = i
  if (k < 0 || !scan[k]) return (v.offset ?? 0) + 1 + v.top
  const want = scan[k]!.line + 1 + (v.top - heads[k]!.line)
  const next = scan[k + 1]
  return next ? clamp(want, scan[k]!.line + 1, next.line) : want
}

/** Editors that take `-g path:line` (VS Code and its forks); a `+N` would open as a second file. */
const GOTO_FLAG = new Set(["code", "code-insiders", "codium", "cursor"])

/**
 * `$VISUAL`, else `$EDITOR`, else `vi`, as argv (split on spaces, never a shell), then the file at
 * `line` in the command's own syntax by its basename: `-g path:line` (VS Code and forks),
 * `path:line` (Sublime Text), else `+line path`.
 */
export function editorCommand(env: Record<string, string | undefined>, path: string, line: number): string[] {
  const pick = [env.VISUAL, env.EDITOR].find((v) => v?.trim())
  const cmd = (pick ?? "vi").trim().split(/\s+/)
  const name = basename(cmd[0]!)
  if (GOTO_FLAG.has(name)) return [...cmd, "-g", `${path}:${line}`]
  if (name === "subl") return [...cmd, `${path}:${line}`]
  return [...cmd, `+${line}`, path]
}

/** What `e` gets back: the editor's exit (`code` null when a signal ended it), or why it never ran. */
export type EditResult = { code: number | null; signal: string | null } | { error: string }

/** The terminal side of running the editor; App passes the real one, tests a fake. */
export interface EditorIO {
  /** a read fd on /dev/tty; throws when there is none */
  openTTY: () => number
  close: (fd: number) => void
  spawn: (argv: string[], stdin: "inherit" | number) => { exitCode: number | null; signalCode?: string | number | null }
  suspend: () => void
  resume: () => void
}

/**
 * Run the editor with the renderer suspended around the blocking spawn. A piped session's stdin is
 * the drained pipe, so its editor reads keys from /dev/tty; without one it does not run. A spawn
 * that throws (no such editor) still resumes the renderer.
 */
export function runEditor(argv: string[], piped: boolean, io: EditorIO): EditResult {
  let fd: number | undefined
  if (piped) {
    try {
      fd = io.openTTY()
    } catch {
      return { error: "no terminal for the editor" }
    }
  }
  io.suspend()
  try {
    const r = io.spawn(argv, fd ?? "inherit")
    return { code: r.exitCode, signal: r.signalCode == null ? null : String(r.signalCode) }
  } finally {
    io.resume()
    if (fd !== undefined) io.close(fd)
  }
}
