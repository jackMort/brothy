// Reading a note from disk for the document and the switcher's peek: stat, the size cap, then the text.
import { readFileSync, statSync } from "node:fs"
import { fmtSize } from "./panel"
import { errText } from "./status"
import { MAX_BYTES } from "./stdin"

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
