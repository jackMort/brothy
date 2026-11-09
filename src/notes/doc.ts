// Reading a note from disk for the document, the switcher's peek and chat: stat, the size cap, then the text; or the
// piped document.
import { readFileSync, statSync } from "node:fs"
import { fmtSize } from "../ui/panel"
import { errText } from "../ui/status"
import { MAX_BYTES } from "./stdin"
import { STDIN } from "./workspace"

/** A note as read: its text, size and mtime (null when it is missing or not a file), or why it could not be read. */
export interface DocFile {
  src: string
  info: { size: number; mtime: Date } | null
  error: string | null
}

/** `_nonce` only busts the cache: live reload and `r` bump it to force a re-read. */
export function readDoc(path: string, _nonce: number): DocFile {
  try {
    const st = statSync(path)
    const info = { size: st.size, mtime: st.mtime }
    if (!st.isFile()) return { src: "", info: null, error: "not a regular file" }
    if (st.size > MAX_BYTES) return { src: "", info, error: `file too large (${fmtSize(st.size)}, limit 5 MB)` }
    return { src: readFileSync(path, "utf8"), info, error: null }
  } catch (e) {
    return { src: "", info: null, error: errText(e) }
  }
}

/** The note at `path`, or the piped document (`stdin`) for STDIN, under the same 5 MB cap. */
export function readNote(path: string, nonce: number, stdin: string | undefined): DocFile {
  if (path !== STDIN || stdin === undefined) return readDoc(path, nonce)
  const size = Buffer.byteLength(stdin)
  if (size > MAX_BYTES) return { src: "", info: null, error: `input too large (${fmtSize(size)}, limit 5 MB)` }
  return { src: stdin, info: null, error: null }
}
