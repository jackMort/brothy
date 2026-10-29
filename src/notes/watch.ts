// Live reload for the open note: `watchPath` survives atomic saves and falls back to polling. The one module here with timers and watchers.
import { statSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"

/** Identity of the file's current content (mtime, size, inode), or `"missing"`. */
function fileSignature(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}:${st.ino}`
  } catch {
    return "missing"
  }
}

/** Inode of the watched folder, or undefined once it is gone. */
function dirInode(dir: string): number | undefined {
  try {
    return statSync(dir).ino
  } catch {
    return undefined
  }
}

/** Debounced change detection: `fire` schedules a look, `report` calls `change` only when the signature differs from the last one reported. */
function makeReporter(path: string, change: () => void, debounce: number) {
  let last = fileSignature(path)
  let timer: ReturnType<typeof setTimeout> | undefined
  const r = {
    closed: false,
    report() {
      const now = fileSignature(path)
      if (r.closed || now === last) return
      last = now
      change()
    },
    fire() {
      clearTimeout(timer)
      timer = setTimeout(r.report, debounce)
    },
    stop() {
      r.closed = true
      clearTimeout(timer)
    },
  }
  return r
}

/**
 * Watch one file for changes, including atomic saves (write temp + rename) that swap the
 * inode: the parent directory is watched and events are filtered by file name. If the
 * directory can't be watched, or the watcher dies, `error` is reported once and the file
 * is polled instead (baseline taken synchronously, so a file created right after this call is still noticed).
 * A directory watch goes dead silently when the folder is removed or renamed, so every `check` ms
 * the folder's identity is compared with the one being watched; on a change the watch is re-armed
 * (once the folder exists again) and a change is reported. Returns a function that stops watching.
 * A change is reported only when the file's signature (mtime, size, inode) differs from the last one
 * reported: FSEvents (macOS) can replay the file's creation from just before the watch started and
 * may name no file (`null`), so an event is only a hint to look, never a change by itself.
 */
export function watchPath(
  path: string,
  on: { change: () => void; error: (msg: string) => void },
  { debounce = 50, poll = 500, check = 1000 } = {},
): () => void {
  const rep = makeReporter(path, on.change, debounce)

  let w: FSWatcher | undefined
  let polling = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  const fallback = (e: unknown) => {
    w?.close()
    w = undefined
    if (rep.closed || polling) return
    polling = true
    on.error(`live reload: ${(e as Error)?.message ?? e} · polling instead`)
    pollTimer = setInterval(rep.report, poll)
    pollTimer.unref()
  }

  const name = basename(path)
  const dir = dirname(path)
  let watched: number | undefined
  let guard: ReturnType<typeof setInterval> | undefined
  const arm = (first = false) => {
    w?.close()
    w = undefined
    watched = dirInode(dir)
    if (watched === undefined && !first) return // gone; the guard re-arms when it is back
    try {
      w = watch(dir, { persistent: false }, (_ev, file) => {
        if (file === null || String(file) === name) rep.fire()
      })
      w.on("error", fallback)
    } catch (e) {
      fallback(e)
    }
  }
  arm(true)
  if (!polling) {
    guard = setInterval(() => {
      if (polling) return clearInterval(guard)
      if (dirInode(dir) === watched) return
      arm()
      rep.fire() // the file went away or is a different one now
    }, check)
    guard.unref()
  }

  return () => {
    rep.stop()
    w?.close()
    clearInterval(pollTimer)
    clearInterval(guard)
  }
}
