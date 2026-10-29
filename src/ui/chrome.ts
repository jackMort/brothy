// Help and welcome chrome, from theme roles and the app's own fade only: group chips, <kbd> keycaps,
// the 4-frame ink-in and the steam colours. No new hues and no ramps.
import { A, type Span } from "../lib/spans"
import { contrast, mix, type Theme } from "../theme/theme"

/** The app's fade: `c` pulled `k` of the way to the background (k = step / 5, as the ghost line and toasts do). */
export const fade = (t: Theme, c: string, k: number) => mix(c, t.background, k)

/** Zen chrome, the ghost line's hints and toasts: every span's colour (text when unset) faded `k` toward the background (0 = full colour). */
export const fadeSpans = (t: Theme, spans: Span[], k: number): Span[] =>
  spans.map((sp) => ({ ...sp, fg: fade(t, sp.fg ?? t.text, k) }))

/** Help groups in their one-column order. */
export const HELP_GROUP_TITLES = ["Global", "Document", "Zen", "Panel", "AI"] as const
const GROUP_ROLE: Record<string, "primary" | "secondary" | "info" | "success" | "accent"> = {
  Global: "primary",
  Document: "secondary",
  Zen: "info",
  Panel: "success",
  AI: "accent",
}

/** A help group's colour; anything else is textMuted. */
export const groupColor = (t: Theme, title: string) => {
  const role = GROUP_ROLE[title]
  return role ? t[role] : t.textMuted
}

/** A group chip: `color` in bold on backgroundElement (the code / <kbd> fill), one cell of padding each side. */
export const chip = (t: Theme, label: string, color: string): Span[] => [
  { text: " ", bg: t.backgroundElement },
  { text: label, fg: color, bg: t.backgroundElement, attr: A.BOLD },
  { text: " ", bg: t.backgroundElement },
]

/** A keycap in markdown's <kbd> style (accent on backgroundElement), padded by one cell. */
export const keycap = (t: Theme, key: string): Span[] => [{ text: ` ${key} `, fg: t.accent, bg: t.backgroundElement }]

/** Keycaps with their words in textMuted, the footer's 3-cell gaps between them. */
export const keycaps = (t: Theme, items: readonly (readonly [string, string])[]): Span[] =>
  items.flatMap(([k, word], i) => [
    ...(i ? [{ text: "   " }] : []),
    ...keycap(t, k),
    { text: " " + word, fg: t.textMuted },
  ])

/** Ink-in frames: border, the role faded 2/5, 1/5, then the role. */
export const INK_STEPS = 4
export const INK_MS = 100
export const inkAt = (t: Theme, step: number, c: string) =>
  step <= 0 ? t.border : step === 1 ? fade(t, c, 2 / 5) : step === 2 ? fade(t, c, 1 / 5) : c

/** Steam is decorative: every row stays at least this far from the background. */
export const STEAM_FLOOR = 1.5
/**
 * Steam colour per row, top to bottom (5 rows; a shorter field keeps the bottom ones): borderSubtle high up,
 * then textMuted faded 2/5 and 1/5, textMuted by the bowl. Where borderSubtle barely shows, textMuted faded 3/5.
 */
export function steamColors(t: Theme): string[] {
  const hi = contrast(t.borderSubtle, t.background) >= STEAM_FLOOR ? t.borderSubtle : fade(t, t.textMuted, 3 / 5)
  return [hi, hi, fade(t, t.textMuted, 2 / 5), fade(t, t.textMuted, 1 / 5), t.textMuted]
}
