// The note's pictures over their reserved rows: one <image> per picture on screen, cut to the rows it has there. Not
// pure: asks the cache for what isn't decoded yet and reports through the store, always after the render.
import { rgb } from "../graph/canvas"
import { truncate } from "../lib/text"
import { type Pic, plainOf, type Rendered } from "../markdown/render"
import type { AppCtx } from "./ctx"
import type { Derived } from "./derive"
import { type Cell, picKey, picWindow } from "./pictures"
import { Row } from "./Row"

/** What a failed picture's row needs besides the alt: `▣ `, ` · ` and `unreadable`. */
const FAILED_W = 15

/** Line `n` is a reserved row with nothing on it: an empty box, since a `<text>` over an `<image>` paints black. */
export function reservedBlank(view: Rendered, n: number) {
  const l = view.lines[n]
  const p = l?.pic === undefined ? undefined : view.pics?.[l.pic]
  return !!l && !!p && n < p.line + p.rows && !plainOf(l.spans).trim()
}

/** Decode `p` for this cell, theme and background; once it lands draw it, or say once per note that it won't. */
function askPicture(c: AppCtx, d: Derived, key: string, file: string, p: Pic, cell: Cell) {
  const { ui, set, flash, alive, pics, picTold } = c
  const note = ui.current.openPath ?? ""
  const bg = d.s.transparent ? null : rgb(d.t.background)
  pics.want(key, file, p.cols * cell.w, p.rows * cell.h, bg, () => {
    if (!alive.current) return
    set({ picVer: ui.current.picVer + 1 })
    if (!pics.failed(key) || picTold.current.has(note) || ui.current.openPath !== note) return
    picTold.current.add(note)
    flash(`pictures · ${p.alt} unreadable`, "error")
  })
}

/** The image could not be shown in this terminal: text for the rest of the run. */
function pixelsFailed({ ui, set, flash }: AppCtx) {
  if (ui.current.picFailed) return
  set({ picFailed: true })
  flash("pictures · pixels failed · text instead", "error")
}

/**
 * What the pictures in the `rows` rows on screen draw: each `<image>` (a `get` per picture keeps it from being evicted
 * while on screen); nothing while it is decoding, so its blank rows show; a failed one's `▣` row.
 */
export function pictureLayer(c: AppCtx, d: Derived, rows: number) {
  const { s, t, view, top, L } = d
  const { cell } = s
  if (d.picMode !== "pixels" || !cell) return null
  return (view.pics ?? []).flatMap((p) => {
    const at = picWindow(p, top, rows, cell)
    const file = at && d.picFiles.file(p.src)
    if (!at || !file) return []
    const key = picKey(file, p, cell, t.name, s.transparent)
    const img = c.pics.get(key)
    if (img === undefined) {
      askPicture(c, d, key, file, p, cell)
      return []
    }
    const place = { position: "absolute", left: p.left, top: at.y } as const
    return img ? (
      <image
        key={`pic-${p.id}-${key}`}
        source={img}
        fit="fill"
        crop={at.crop}
        onError={() => pixelsFailed(c)}
        style={{ ...place, width: p.cols, height: at.rows }}
      />
    ) : (
      <box key={`pic-${p.id}-failed`} style={{ ...place, width: L.CW - p.left, height: 1 }}>
        <Row
          spans={[
            { text: "▣ ", fg: t.primary },
            { text: `${truncate(p.alt, Math.max(1, L.CW - p.left - FAILED_W))} · `, fg: t.textMuted },
            { text: "unreadable", fg: t.warning },
          ]}
        />
      </box>
    )
  })
}
