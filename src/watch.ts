import { statSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"

/**
 * Watch one file for changes, including atomic saves (write temp + rename) that swap the
 * inode: the parent directory is watched and events are filtered by file name. If the
 * directory can't be watched, or the watcher dies, `error` is reported once and the file
 * is polled instead (baseline taken synchronously, so a file created right after this call is still noticed).
 * A directory watch goes dead silently when the folder is removed or renamed, so every `check` ms
 * the folder's identity is compared with the one being watched; on a change the watch is re-armed
 * (once the folder exists again) and a change is reported. Returns a function that stops watching.
 */
export function watchPath(
  path: string,
  on: { change: () => void; error: (msg: string) => void },
  { debounce = 50, poll = 500, check = 1000 } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const fire = () => {
    clearTimeout(timer)
    timer = setTimeout(() => !closed && on.change(), debounce)
  }

  let w: FSWatcher | undefined
  let polling = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  const signature = () => {
    try {
      const st = statSync(path)
      return `${st.mtimeMs}:${st.size}:${st.ino}`
    } catch {
      return "missing"
    }
  }
  const fallback = (e: unknown) => {
    w?.close()
    w = undefined
    if (closed || polling) return
    polling = true
    on.error(`live reload: ${(e as Error)?.message ?? e} · polling instead`)
    let last = signature()
    pollTimer = setInterval(() => {
      const now = signature()
      if (now !== last) {
        last = now
        fire()
      }
    }, poll)
    pollTimer.unref?.()
  }

  const name = basename(path)
  const dir = dirname(path)
  const inode = () => {
    try {
      return statSync(dir).ino
    } catch {
      return undefined
    }
  }
  let watched: number | undefined
  let guard: ReturnType<typeof setInterval> | undefined
  const arm = (first = false) => {
    w?.close()
    w = undefined
    watched = inode()
    if (watched === undefined && !first) return // gone; the guard re-arms when it is back
    try {
      w = watch(dir, { persistent: false }, (_ev, file) => {
        if (file === null || String(file) === name) fire()
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
      if (inode() === watched) return
      arm()
      fire() // the file went away or is a different one now
    }, check)
    guard.unref?.()
  }

  return () => {
    closed = true
    clearTimeout(timer)
    w?.close()
    clearInterval(pollTimer)
    clearInterval(guard)
  }
}
