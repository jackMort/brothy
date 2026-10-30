// The Proof sheet in the app: moving between its blocks and going to one. Opening it is `infoGo` on the Changed label,
// closing is `set({ proof: null })`. Not pure: closes over the app context.
import { clamp } from "../lib/text"
import { blockAt, proofTop } from "../ui/proof"
import type { AppCtx } from "./ctx"
import type { Links } from "./links"

/** The sheet's moves: highlight a change, step or page between blocks, go to one in the note. */
export function makeProof(c: AppCtx, { jumpChange }: Pick<Links, "jumpChange">) {
  const { set, derive, flash } = c

  /** Highlight change `hl` (clamped to the list) and scroll its block into view. */
  const proofAt = (hl: number) => {
    const { proof: p, cv } = derive()
    if (!p || !cv?.changes) return
    const at = clamp(hl, 0, cv.changes.length - 1)
    set({ proof: { hl: at, top: proofTop(p.rows, at, p.top, p.height) } })
  }

  /** A page down / up: the first block header at or below the new first row is highlighted (the last one past them all). */
  const proofPage = (dir: 1 | -1) => {
    const { proof: p, cv } = derive()
    if (!p || !cv?.changes) return
    const top = clamp(p.top + dir * (p.height - 1), 0, Math.max(0, p.rows.length - p.height))
    const first = p.rows.findIndex((r, y) => y >= top && r.kind === "block")
    const hl = first < 0 ? cv.changes.length - 1 : blockAt(p.rows, first)!
    set({ proof: { hl, top: proofTop(p.rows, hl, top, p.height) } })
  }

  /** `⏎` or a click on change `at` (the highlighted one by default): close the sheet and land on it; a removed section has no heading to go to. */
  const proofGo = (at?: number) => {
    const { proof: p, cv } = derive()
    if (!p) return
    const i = at ?? p.hl
    if (cv?.changes?.[i]?.status === "removed") return flash("section removed")
    set({ proof: null })
    jumpChange(i)
  }

  return { proofAt, proofPage, proofGo }
}
/** What `makeProof` gives App and the actions. */
export type Proof = ReturnType<typeof makeProof>
