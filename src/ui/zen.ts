// Zen mode: settings model and pure helpers (sections, typewriter, pages, dimming, timing).

import { isRecord } from "../lib/json"
import type { Span } from "../lib/spans"
import { clamp } from "../lib/text"
import { mix, type Theme } from "../theme/theme"

export interface ZenConfig {
  flow: "scroll" | "pages"
  spotlight: boolean
  typewriter: boolean
  ghost: boolean
  /** Teleprompter option: `space` starts / pauses auto-scroll. */
  prompter: boolean
  /** Teleprompter speed, words per minute. */
  wpm: number
  /** Wrap width in columns, or `"full"` for the whole pane (minus margins). */
  measure: number | "full"
}

export const ZEN_DEFAULTS: ZenConfig = {
  flow: "scroll",
  spotlight: true,
  typewriter: true,
  ghost: true,
  prompter: false,
  wpm: 220,
  measure: 72,
}

export const ZEN_WPM = { min: 120, max: 400, step: 20 } as const
const ZEN_MEASURE = { min: 60, max: 100, step: 4 } as const

const BOOLS = ["spotlight", "typewriter", "ghost", "prompter"] as const

/** The valid fields of a raw `zen` config value (numbers rounded and clamped); everything else is dropped. */
export function pickZen(raw: unknown): Partial<ZenConfig> {
  if (!isRecord(raw)) return {}
  const out: Partial<ZenConfig> = {}
  if (raw.flow === "scroll" || raw.flow === "pages") out.flow = raw.flow
  for (const k of BOOLS) {
    const v = raw[k]
    if (typeof v === "boolean") out[k] = v
  }
  if (typeof raw.wpm === "number" && Number.isFinite(raw.wpm)) out.wpm = clamp(Math.round(raw.wpm), ZEN_WPM.min, ZEN_WPM.max)
  if (raw.measure === "full") out.measure = "full"
  else if (typeof raw.measure === "number" && Number.isFinite(raw.measure)) out.measure = clamp(Math.round(raw.measure), ZEN_MEASURE.min, ZEN_MEASURE.max)
  return out
}

/** One `<` / `>` step on the measure dial: numbers move by the step, 100 → full → 100. */
export function stepMeasure(m: ZenConfig["measure"], dir: -1 | 1): ZenConfig["measure"] {
  if (m === "full") return dir < 0 ? ZEN_MEASURE.max : "full"
  return dir > 0 && m >= ZEN_MEASURE.max ? "full" : clamp(m + dir * ZEN_MEASURE.step, ZEN_MEASURE.min, ZEN_MEASURE.max)
}

/** A complete config: valid fields of `raw`, defaults for the rest. */
export const normalizeZen = (raw: unknown): ZenConfig => ({ ...ZEN_DEFAULTS, ...pickZen(raw) })

// ------------------------------------------------------------- settings popup

export type ZenRowId = "flow" | "spotlight" | "typewriter" | "ghost" | "prompter" | "measure"
/** Settings popup rows, top to bottom. */
export const ZEN_ROWS: readonly ZenRowId[] = ["flow", "spotlight", "typewriter", "ghost", "prompter", "measure"]

export interface ZenRow {
  id: ZenRowId
  label: string
  value: string
  /** shown greyed: the option has no effect in the current flow (it can still be changed) */
  disabled: boolean
}

const onOff = (b: boolean) => (b ? "on" : "off")

/** The settings popup rows for `c`: label, value as drawn, and whether the current flow ignores the option. */
export function zenRows(c: ZenConfig): ZenRow[] {
  const pages = c.flow === "pages"
  return [
    { id: "flow", label: "Flow", value: `◀ ${c.flow} ▶`, disabled: false },
    { id: "spotlight", label: "Spotlight", value: onOff(c.spotlight), disabled: pages },
    { id: "typewriter", label: "Typewriter", value: onOff(c.typewriter), disabled: pages },
    { id: "ghost", label: "Ghost chrome", value: onOff(c.ghost), disabled: false },
    { id: "prompter", label: "Teleprompter", value: `${onOff(c.prompter)} · ◀ ${c.wpm} wpm ▶`, disabled: pages },
    { id: "measure", label: "Measure", value: `◀ ${c.measure} ▶`, disabled: false },
  ]
}

/** One popup edit on row `id`: `dir` 0 is space (toggle), ±1 is ← / → (adjust; on/off rows toggle). */
export function zenAdjust(c: ZenConfig, id: ZenRowId, dir: -1 | 0 | 1): ZenConfig {
  switch (id) {
    case "flow":
      return { ...c, flow: c.flow === "scroll" ? "pages" : "scroll" }
    case "prompter":
      return dir === 0 ? { ...c, prompter: !c.prompter } : normalizeZen({ ...c, wpm: c.wpm + dir * ZEN_WPM.step })
    case "measure":
      return dir === 0 ? c : { ...c, measure: stepMeasure(c.measure, dir) }
    default:
      return { ...c, [id]: !c[id] }
  }
}

// ------------------------------------------------------------- sections and geometry

/** `[start, end)` line ranges of the sections: each heading starts one; lines before the first heading form their own. */
export function sectionRanges(headings: number[], len: number): [number, number][] {
  const cuts = [...new Set([0, ...headings.filter((h) => h > 0 && h < len)])].sort((a, b) => a - b)
  return cuts.map((c, i): [number, number] => [c, cuts[i + 1] ?? Math.max(c, len)])
}

/** Index of the section holding `line`; lines outside the document clamp to the first / last section. */
export function sectionAt(ranges: [number, number][], line: number): number {
  let i = 0
  while (i + 1 < ranges.length && ranges[i + 1]![0] <= line) i++
  return i
}

/** First visible line that puts `reading` on the middle row of `h`; negative near the top. */
export const typewriterTop = (reading: number, h: number): number => reading - Math.floor(h / 2)

/** Pages flow: a short section is centered (`pad` blank rows above); a tall one scrolls by `offset`. */
export function pageSlice(range: [number, number], h: number, offset: number): { top: number; pad: number } {
  const [start, end] = range
  const len = end - start
  if (len <= h) return { top: start, pad: Math.floor((h - len) / 2) }
  return { top: start + clamp(offset, 0, len - h), pad: 0 }
}

/** Texts of heading `idx` and its shallower ancestors, outermost first. */
export function headingPath(hs: { depth: number; text: string }[], idx: number): string[] {
  const out: string[] = []
  let depth = Infinity
  for (let i = Math.min(idx, hs.length - 1); i >= 0; i--) {
    const h = hs[i]!
    if (h.depth < depth) {
      out.unshift(h.text)
      depth = h.depth
    }
  }
  return out
}

// ------------------------------------------------------------- reading aids

/** Spotlight: how far lines outside the current section are mixed toward the background. */
export const SPOT_DIM = 0.6

/** Mix every span's colors `amount` of the way toward the background. */
export function dimSpans(spans: Span[], t: Theme, amount: number): Span[] {
  return spans.map((s) => ({
    ...s,
    fg: mix(s.fg ?? t.text, t.background, amount),
    ...(s.bg ? { bg: mix(s.bg, t.background, amount) } : {}),
  }))
}

const WORDY = /[\p{L}\p{N}]/u
const words = (line: string) => line.split(/\s+/).filter((w) => WORDY.test(w)).length

/** `[i]` = words from line `i` to the end (one extra trailing 0), so "time left" is O(1) per frame. */
export function wordSuffix(lines: string[]): number[] {
  const out = new Array<number>(lines.length + 1).fill(0)
  for (let i = lines.length - 1; i >= 0; i--) out[i] = out[i + 1]! + words(lines[i]!)
  return out
}

/** Reading speed for "~N min left". */
const READ_WPM = 230

/** Whole minutes of reading left from line `from`, given `wordSuffix`. */
export function minutesLeft(suffix: number[], from: number): number {
  const i = clamp(from, 0, suffix.length - 1)
  return Math.ceil((suffix[i] ?? 0) / READ_WPM)
}

/** Teleprompter speed in rendered lines per second: words per second over the average words per non-blank line (at least 1). */
export function prompterRate(lines: string[], wpm: number): number {
  let total = 0
  let filled = 0
  for (const l of lines) {
    if (!l.trim()) continue
    filled++
    total += words(l)
  }
  const avg = Math.max(1, filled ? total / filled : 1)
  return wpm / 60 / avg
}
