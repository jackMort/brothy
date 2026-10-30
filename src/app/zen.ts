// Zen mode in the app: on and off, the `Z` settings popup, pages, manual scrolling, the Ghost top line and the
// teleprompter. Not pure: `makeZen` closes over the app context (the settings model is ../zen.ts).

import { clamp } from "../lib/text"
import { GHOST_HOLD } from "../ui/status"
import { normalizeZen, prompterRate, ZEN_ROWS, type ZenConfig, zenAdjust } from "../ui/zen"
import type { AIJobs } from "./ai-jobs"
import type { AppCtx } from "./ctx"
import type { Focus } from "./store"

/** The teleprompter and the ways to move through the text in zen: pages and manual scrolling. */
function makeZenMotion(c: AppCtx) {
  const { set, derive, timers, setTop, scrollBy, stopRolling } = c

  // the rate is read afresh every line, so wpm changes, resizes and reloads apply at once
  const startRolling = () => {
    clearTimeout(timers.current.roll)
    const d0 = derive()
    if (!d0.prompter || d0.top >= d0.maxTop) return stopRolling()
    set({ rolling: true })
    const tick = () => {
      const d = derive()
      if (!d.prompter || d.top >= d.maxTop) return stopRolling()
      setTop(d.top + 1)
      const next = derive()
      if (next.top >= next.maxTop) return stopRolling()
      timers.current.roll = setTimeout(tick, 1000 / prompterRate(next.view.plain, next.s.zenCfg.wpm))
    }
    timers.current.roll = setTimeout(tick, 1000 / prompterRate(d0.view.plain, d0.s.zenCfg.wpm))
  }

  /** Pages flow: show page `i` (clamped) from its start. */
  const goPage = (i: number) => {
    const { ranges } = derive()
    setTop(ranges[clamp(i, 0, ranges.length - 1)]![0])
  }

  /** Manual scroll inside zen; a page only scrolls within its own section. */
  const zenScroll = (n: number) => {
    stopRolling()
    const { pg } = derive()
    if (pg) return setTop(Math.max(pg.start, Math.min(pg.top + n, pg.maxTop)))
    scrollBy(n)
  }

  return { startRolling, goPage, zenScroll }
}

/** The `Z` settings popup. */
function makeZenSettings(
  c: AppCtx,
  { toggleZen, setZen }: { toggleZen: (on?: boolean) => void; setZen: (patch: Partial<ZenConfig>) => boolean },
) {
  const { ui, set, persist, flash } = c

  // `Z` popup: live preview while editing, ⏎ saves, esc restores what was there before
  const openZenSettings = () => {
    const s = ui.current
    set({ zenOrig: { cfg: s.zenCfg, zen: s.zen, source: s.source }, zenRow: 0 })
    if (!s.zen || s.source) toggleZen(true)
  }

  const revertZen = () => {
    const o = ui.current.zenOrig
    if (!o) return
    set({ zenCfg: o.cfg, source: o.source, zenOrig: null })
    if (!o.zen) toggleZen(false)
  }

  const applyZen = () => {
    const was = ui.current.zenOrig?.cfg
    const cfg = ui.current.zenCfg
    set({ zenOrig: null })
    const changed = Object.fromEntries(Object.entries(cfg).filter(([k, v]) => was?.[k as keyof ZenConfig] !== v))
    if (persist({ zen: changed })) flash("zen settings saved", "ok")
  }

  const zenEdit = (row: number, dir: -1 | 0 | 1) => setZen(zenAdjust(ui.current.zenCfg, ZEN_ROWS[row]!, dir))

  return { openZenSettings, revertZen, applyZen, zenEdit }
}

/** Zen over the app context; entering it reads the gloss cache (`ensureGlosses`). */
export function makeZen(c: AppCtx, { ensureGlosses }: Pick<AIJobs, "ensureGlosses">) {
  const { ui, set, derive, timers, zenBack, scrolls, persist, runFade, stopRolling } = c
  const { startRolling, ...motion } = makeZenMotion(c)

  /** Ghost chrome: show the zen top line now; it holds, fades in steps, then hides. */
  const pokeGhost = () => {
    set({ ghostAt: Date.now() })
    runFade(
      "ghost",
      () => ui.current.ghostAt,
      GHOST_HOLD,
      () => set({ ghostAt: null }),
    )
  }

  /** Zen on / off. Entering shows the Preview; only the settings persist, never the mode. */
  const toggleZen = (on = !ui.current.zen) => {
    stopRolling()
    clearTimeout(timers.current.ghost)
    const s = ui.current
    if (on) {
      set({ landing: null })
      if (!s.zen && !s.source) {
        const d = derive()
        zenBack.current = { key: d.scrollKey, top: d.top, geo: d.geo }
      }
      ensureGlosses()
    } else {
      if (zenBack.current) scrolls.current.set(zenBack.current.key, { ...zenBack.current })
      zenBack.current = null
      clearTimeout(timers.current.gloss)
      clearTimeout(timers.current.dwell)
    }
    set({
      zen: on,
      ghostAt: null,
      filterTyping: false,
      ...(on ? { drawerOpen: false, focus: "doc" as Focus, source: false } : { gloss: null }),
    })
    if (on && ui.current.zenCfg.ghost) pokeGhost()
  }

  /** Change zen settings (clamped); `save` writes them to the config at once. False when that save failed. */
  const setZen = (patch: Partial<ZenConfig>, save = false) => {
    const zenCfg = normalizeZen({ ...ui.current.zenCfg, ...patch })
    set({ zenCfg })
    // only the keys changed (as clamped): another instance's other settings stay
    const ok =
      !save || persist({ zen: Object.fromEntries(Object.keys(patch).map((k) => [k, zenCfg[k as keyof ZenConfig]])) })
    if (ui.current.rolling) startRolling() // pick up the new speed now, not after the pending line
    return ok
  }

  return { startRolling, ...motion, ...makeZenSettings(c, { toggleZen, setZen }), pokeGhost, toggleZen, setZen }
}
/** What `makeZen` gives App and the other factories. */
export type Zen = ReturnType<typeof makeZen>
