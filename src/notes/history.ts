// Back / forward through the notes opened this run (`H` / `L`). Pure: the app stores the
// position (`P`) a note was left at and restores it on the way back.

/** Entries kept; the oldest go first. */
export const HISTORY_CAP = 100

export interface Entry<P> {
  path: string
  /** where the note was left (null until it is left) */
  pos: P | null
  /** only previewed (Files cursor): the next visit replaces it instead of pushing */
  peek: boolean
}

export interface History<P> {
  entries: readonly Entry<P>[]
  /** the current entry; -1 when empty */
  at: number
}

export const startHistory = <P>(path: string | null): History<P> => (path ? { entries: [{ path, pos: null, peek: false }], at: 0 } : { entries: [], at: -1 })

/** `entries` with the current one's `pos` set to `pos`. */
const leave = <P>(h: History<P>, pos: P | null): Entry<P>[] => h.entries.map((e, i) => (i === h.at ? { ...e, pos } : e))

/**
 * Open `path`, leaving the current note at `pos`: the forward part is cut, and a current entry that was
 * only previewed is replaced. The current note itself changes nothing; the oldest entries fall past the cap.
 */
export function visit<P>(h: History<P>, path: string, pos: P | null, peek = false): History<P> {
  const cur = h.entries[h.at]
  if (cur?.path === path) return h
  const entries = leave(h, pos).slice(0, h.at + 1)
  if (cur?.peek) {
    entries.pop()
    // previewing back onto the note before: that one is current again
    if (entries.at(-1)?.path === path) return { entries, at: entries.length - 1 }
  }
  entries.push({ path, pos: null, peek })
  const cut = Math.max(0, entries.length - HISTORY_CAP)
  return { entries: entries.slice(cut), at: entries.length - 1 - cut }
}

/** The current note had document focus (or was followed from): later visits push past it. */
export function keep<P>(h: History<P>): History<P> {
  if (!h.entries[h.at]?.peek) return h
  return { ...h, entries: h.entries.map((e, i) => (i === h.at ? { ...e, peek: false } : e)) }
}

/** Index one step back (-1) or forward (1), null at that end. */
export function stepTo<P>(h: History<P>, dir: -1 | 1): number | null {
  const i = h.at + dir
  return h.at >= 0 && i >= 0 && i < h.entries.length ? i : null
}

/** Move to entry `i`, leaving the current note at `pos`. */
export const go = <P>(h: History<P>, i: number, pos: P | null): History<P> => ({ entries: leave(h, pos), at: i })

/** Remove entry `i` (a note gone from disk); `at` stays on the same note, and neighbours left equal merge. */
export function drop<P>(h: History<P>, i: number): History<P> {
  const entries = h.entries.filter((_, k) => k !== i)
  let at = h.at > i ? h.at - 1 : Math.min(h.at, entries.length - 1)
  // a b a minus b: keep the earlier a (it holds the older position), moving off the later one
  if (i > 0 && entries[i - 1]?.path === entries[i]?.path) {
    entries.splice(i, 1)
    if (at >= i) at--
  }
  return { entries, at }
}
