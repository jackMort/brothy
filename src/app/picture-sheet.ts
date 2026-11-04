// The picture sheet's moves: which picture a key or a click means, and opening it. Not pure: closes over the app context.
// `openPicture` is the one way in (`⏎`, a click, and the `f` labels), so a label opens the sheet as the key does.
import type { Pic, Rendered } from "../markdown/render"
import type { AppCtx } from "./ctx"
import type { Window } from "./PictureLayer"

/** The picture on line `n` (its rows, caption or placeholder), if any. */
export const picAt = (view: Rendered, n: number): Pic | undefined => {
  const id = view.lines[n]?.pic
  return id === undefined ? undefined : view.pics?.[id]
}

/**
 * The first picture among the `rows` rows on screen: row `i` shows line `win.first + i` when it lies in `lo..hi` (zen's
 * reading line and pages make `first` something other than the scroll offset, so a caller passes the window).
 */
export function firstPicIn(view: Rendered, win: Pick<Window, "first" | "lo" | "hi">, rows: number): Pic | undefined {
  const end = Math.min(win.first + rows, win.hi, view.lines.length)
  for (let n = Math.max(win.first, win.lo); n < end; n++) {
    const p = picAt(view, n)
    if (p) return p
  }
  return undefined
}

/** The picture sheet's opening. */
export function makePictureSheet({ set, derive }: AppCtx) {
  return {
    /** Open the sheet on picture `id` of the open note; nothing when the note has none by that id. */
    openPicture: (id: number) => {
      if (derive().view.pics?.[id]) set({ picture: { id } })
    },
    /** `⏎`: the first picture on screen; nothing when none is. */
    viewPicture: () => {
      const { view, win, L } = derive()
      const p = firstPicIn(view, win, L.CH)
      if (p) set({ picture: { id: p.id } })
    },
    /** A click on row `y` of the document's text area (the first row is `win.first`). */
    clickRow: (y: number) => {
      const { view, win, L } = derive()
      const n = win.first + y
      const p = y >= 0 && y < L.CH && n >= win.lo && n < win.hi ? picAt(view, n) : undefined
      if (p) set({ picture: { id: p.id } })
    },
    closePicture: () => set({ picture: null }),
  }
}
export type PictureSheet = ReturnType<typeof makePictureSheet>
