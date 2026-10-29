// The `t` picker's pure side: the palettes as families (a dark/light pair, or a single-mode
// family with only one of them), the query and the mode toggle (`ThemePick`), the popup geometry (a list, and from PEEK_MIN_W a pane),
// the board (a `dark` / `light` column per family, each cell a specimen in that theme's own roles) and the pane's
// sample note rendered in the candidate theme on its own background. App holds the state and
// applies the theme; nothing here saves config or re-themes the app.
import { fuzzyHits } from "./files"
import { render, type HeadingStyle, type Rendered } from "./markdown"
import { PEEK_MIN_W } from "./peek"
import { A, type Span } from "./spans"
import { clamp, spanWidth, width } from "./text"
import { contrast, themes, type Theme } from "./theme"

export type ThemeMode = Theme["mode"]

/** A family has at least one of `dark` and `light`; with only one it is single-mode (synthwave84, vesper). */
export interface Family {
  /** the shared name: `brothy` for brothy / brothy-light, `one` for one-dark / one-light */
  name: string
  dark?: Theme
  light?: Theme
}

/** The palettes grouped by name (`x` or `x-dark` with `x-light`), in `list` order of each family's first palette. */
export function themeFamilies(list: readonly Theme[] = themes): Family[] {
  const by = new Map<string, Family>()
  for (const t of list) {
    const name = t.name.replace(/-(dark|light)$/, "")
    let f = by.get(name)
    if (!f) by.set(name, (f = { name }))
    f[t.mode] = t
  }
  return [...by.values()]
}

export const FAMILIES = themeFamilies()

/** The one mode a single-mode family has, undefined for a pair. */
export const onlyMode = (f: Family): ThemeMode | undefined => (f.dark && f.light ? undefined : f.dark ? "dark" : "light")

/** The family's theme in `mode`, or its only theme when it lacks that mode. */
export const familyTheme = (f: Family, mode: ThemeMode): Theme => (f[mode] ?? f.dark ?? f.light)!

/** A configured theme: its own name, else a family's (`one`, `ayu`) in its dark theme, light when that is all it has. */
export const resolveTheme = (name: string | undefined, fams: readonly Family[] = FAMILIES): Theme | undefined => {
  const f = fams.find((x) => x.name === name)
  return themes.find((t) => t.name === name) ?? (f && familyTheme(f, "dark"))
}

/** The family a theme belongs to. */
export const familyOf = (t: Theme, fams: readonly Family[] = FAMILIES): Family | undefined =>
  fams.find((f) => f.dark?.name === t.name || f.light?.name === t.name)

export interface FamilyHit {
  family: Family
  /** code-point indexes of the query in the name */
  hits: number[]
}

/** Families whose name holds `q` as a subsequence (`fuzzyHits`): the tightest, earliest match first, then theme order. */
export function filterFamilies(q: string, fams: readonly Family[] = FAMILIES): FamilyHit[] {
  const needle = q.trim()
  const scored: { hit: FamilyHit; score: number; i: number }[] = []
  fams.forEach((family, i) => {
    const hits = fuzzyHits(family.name, needle)
    if (!hits) return
    const score = hits.length ? (hits[hits.length - 1]! - hits[0]!) * 2 + hits[0]! : 0
    scored.push({ hit: { family, hits }, score, i })
  })
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.hit)
}

/** The picker's state: what is typed, the highlighted family and the mode it is shown in. */
export interface ThemePick {
  q: string
  family: string
  /** the mode asked for; a single-mode family shows its own mode instead and leaves this alone (`pickShown`) */
  mode: ThemeMode
  /** the theme in use when the picker opened (`current` on its row) */
  orig: string
  /** the list's first row, held while the pointer moves the highlight; null: centred on it (keys, wheel, typing) */
  top: number | null
}

export function pickStart(t: Theme): ThemePick {
  return { q: "", family: familyOf(t)?.name ?? FAMILIES[0]!.name, mode: t.mode, orig: t.name, top: null }
}

/** The highlighted row in `rows`, -1 when the family is filtered out (no rows). */
export const pickIndex = (p: ThemePick, rows: readonly FamilyHit[]) => rows.findIndex((r) => r.family.name === p.family)

const pickFamily = (p: ThemePick, fams: readonly Family[]) => fams.find((x) => x.name === p.family) ?? fams[0]!

/** The candidate: the highlighted family in the picker's mode, or in its only mode. */
export const pickTheme = (p: ThemePick, fams: readonly Family[] = FAMILIES): Theme => familyTheme(pickFamily(p, fams), p.mode)

/** The mode the switch shows as active: the candidate's. */
export const pickShown = (p: ThemePick, fams: readonly Family[] = FAMILIES): ThemeMode => pickTheme(p, fams).mode

/** One row down or up among the filtered families, wrapping. */
export function pickMove(p: ThemePick, dir: 1 | -1, fams: readonly Family[] = FAMILIES): ThemePick {
  const rows = filterFamilies(p.q, fams)
  if (!rows.length) return p
  const i = pickIndex(p, rows)
  return { ...p, family: rows[i < 0 ? 0 : (i + dir + rows.length) % rows.length]!.family.name, top: null }
}

/** A new query: the highlight stays on its family while that is still listed, else goes to the first row. */
export function pickQuery(p: ThemePick, q: string, fams: readonly Family[] = FAMILIES): ThemePick {
  const rows = filterFamilies(q, fams)
  const keep = rows.length === 0 || rows.some((r) => r.family.name === p.family)
  return { ...p, q, family: keep ? p.family : rows[0]!.family.name, top: null }
}

/** Set the mode, or flip it when none is given (`tab`); on a single-mode family nothing changes. */
export const pickMode = (p: ThemePick, mode?: ThemeMode, fams: readonly Family[] = FAMILIES): ThemePick =>
  onlyMode(pickFamily(p, fams)) ? p : { ...p, mode: mode ?? (p.mode === "dark" ? "light" : "dark") }

/** Name column: the longest family name plus a 2-cell gap before the board's cells. */
export const NAME_W = Math.max(...FAMILIES.map((f) => width(f.name))) + 2
/** List width with the pane: board text 33 = name 12 + a 10-cell slot + a gap + a slot (`boardLayout`). */
export const THEME_LIST_W = 41
/** Popup width without the pane. */
export const THEME_NARROW_W = 48

/**
 * Picker geometry for a W×H terminal; `ph` is App's popup list height (L.PH). From PEEK_MIN_W the
 * popup is the switcher's `min(W − 12, 116)` and splits into the list (`listW`), a `│` and the
 * pane (padded 2 left and 4 right around `peekW`), with `max(ph, H − 10)` rows so the sample fits.
 * Below that it is THEME_NARROW_W wide with `ph` rows and no pane.
 */
export function themeSplit(W: number, H: number, ph: number): { split: boolean; width: number; listW: number; peekW: number; rows: number } {
  if (W < PEEK_MIN_W) {
    const popupW = Math.min(THEME_NARROW_W, W - 2)
    return { split: false, width: popupW, listW: popupW - 2, peekW: 0, rows: ph }
  }
  const popupW = Math.min(W - 12, 116)
  return { split: true, width: popupW, listW: THEME_LIST_W, peekW: popupW - 2 - THEME_LIST_W - 1 - 6, rows: Math.max(ph, H - 10) }
}

/** The board's modes, left to right (the switch's order too). */
export const BOARD_MODES = ["dark", "light"] as const satisfies readonly ThemeMode[]
/** A specimen, ` Aa ●●● `. */
export const CELL_W = 8
/** A slot: the specimen between its two frame cells. */
export const SLOT_W = CELL_W + 2

export interface BoardLayout {
  /** the name column, gap included */
  nameW: number
  /** cells between the two slots */
  gap: number
  /** each slot's first column in the row's text, in BOARD_MODES order */
  x: [number, number]
}

/**
 * The board inside `textW` text columns (PickerList's row: list width − 8): the name column is NAME_W,
 * one cell less when the slots and a 2-cell gap don't fit (33 with the pane: 12 + 10 + 1 + 10; 38 without: 13 + 10 + 2 + 10).
 */
export function boardLayout(textW: number): BoardLayout {
  const gap = textW >= NAME_W + 2 * SLOT_W + 2 ? 2 : 1
  const nameW = Math.max(1, Math.min(NAME_W, textW - 2 * SLOT_W - gap))
  return { nameW, gap, x: [nameW, nameW + SLOT_W + gap] }
}

/** A theme's specimen in its own roles on its own background: `Aa` in text (bold), then primary, secondary and accent dots. */
export function specimen(x: Theme): Span[] {
  const bg = x.background
  return [
    { text: " ", bg },
    { text: "Aa", fg: x.text, bg, attr: A.BOLD },
    { text: " ", bg },
    { text: "●", fg: x.primary, bg },
    { text: "●", fg: x.secondary, bg },
    { text: "●", fg: x.accent, bg },
    { text: " ", bg },
  ]
}

/** How a slot is framed: the cursor (primary half blocks), the theme in use (thin muted bars) or nothing. */
export type SlotFrame = "cursor" | "current" | undefined

/**
 * Each mode's frame on a row: the cursor on the highlighted row's shown theme (the asked mode, or a
 * single-mode family's only one), else `current` on the theme in use.
 */
export function boardFrames(f: Family, mode: ThemeMode, orig: string, sel: boolean): Record<ThemeMode, SlotFrame> {
  const shown = familyTheme(f, mode)
  const frame = (x: Theme | undefined): SlotFrame => (!x ? undefined : sel && x === shown ? "cursor" : x.name === orig ? "current" : undefined)
  return { dark: frame(f.dark), light: frame(f.light) }
}

/** `word` centred in `w` cells, struck through in `fg`. */
const struckWord = (word: string, w: number, fg: string): Span[] => {
  const l = (w - width(word)) >> 1
  return [{ text: " ".repeat(l) }, { text: word, fg, attr: A.STRIKE }, { text: " ".repeat(w - l - width(word)) }]
}

/**
 * One slot, SLOT_W cells: the frame, the specimen of `x`, the frame; the chrome is `t`'s. A mode the family
 * lacks is its name, muted and struck through, as the input row's switch draws it.
 */
export function boardSlot(t: Theme, x: Theme | undefined, mode: ThemeMode, frame: SlotFrame): Span[] {
  if (!x) return [{ text: " " }, ...struckWord(mode, CELL_W, t.textMuted), { text: " " }]
  const [l, r]: [Span, Span] =
    frame === "cursor" ? [{ text: "▐", fg: t.primary }, { text: "▌", fg: t.primary }]
    : frame === "current" ? [{ text: "▕", fg: t.textMuted }, { text: "▏", fg: t.textMuted }]
    : [{ text: " " }, { text: " " }]
  return [l, ...specimen(x), r]
}

/** The header row: `dark` and `light` centred over their slots, bold, the shown mode in primary and the other muted. */
export function boardHeader(t: Theme, shown: ThemeMode, L: BoardLayout): Span[] {
  const out: Span[] = [{ text: " ".repeat(L.nameW) }]
  BOARD_MODES.forEach((m, i) => {
    if (i) out.push({ text: " ".repeat(L.gap) })
    const l = (SLOT_W - width(m)) >> 1
    out.push({ text: " ".repeat(l) }, { text: m, fg: m === shown ? t.primary : t.textMuted, attr: A.BOLD }, { text: " ".repeat(SLOT_W - l - width(m)) })
  })
  return out
}

/** First list row shown: the highlight kept centred, as the picker always has. */
export const listTop = (hl: number, rows: number, n: number) => clamp(hl - (rows >> 1), 0, n - rows)

/** The board's first row on screen: the held `top` (clamped), else centred on the highlight `hl`. */
export const pickTop = (p: ThemePick, hl: number, rows: number, n: number) =>
  p.top === null ? listTop(Math.max(0, hl), rows, n) : clamp(p.top, 0, n - rows)

/** The pane's note: one of each thing a theme colours (marks, links, code, callout, tasks, table). */
export const SAMPLE = [
  "# Simmering notes",
  "",
  "Stock wants **patience**, a little *salt* and time; see [[getting-started]] or the [manual](https://example.com). Keep ==the lid on== and run `bun src/cli.tsx ~/notes` to read along slowly.",
  "",
  "> [!tip] Callouts keep their colour, nothing shouts",
  "",
  "```ts",
  "let stock = (bones: number) => bones * 2 // simmer",
  "```",
  "",
  "- [x] skim the foam",
  "- [ ] taste, then *salt*",
  "",
  "| Level | Use it for | Time |",
  "| ----- | ---------- | ---: |",
  "| low   | reading    | 8 min |",
  "",
].join("\n")

/** The sample in theme `t` at `w` columns, as Preview renders it. */
export const sampleView = (t: Theme, w: number, headings?: HeadingStyle): Rendered => render(SAMPLE, w, t, { headings })

const ROLES = ["text", "textMuted", "primary", "secondary", "accent", "error", "warning", "success", "info"] as const
const LABEL: Partial<Record<(typeof ROLES)[number], string>> = { textMuted: "muted" }
const SHORT: Partial<Record<(typeof ROLES)[number], string>> = { textMuted: "muted", secondary: "second", warning: "warn" }

/** The nine content roles as words, each in its own colour: two-cell gaps, then one, then short labels, then the first six. */
export function roleWords(t: Theme, w: number): Span[] {
  const line = (roles: readonly (typeof ROLES)[number][], labels: typeof LABEL, gap: string): Span[] =>
    roles.flatMap((r, i) => [...(i ? [{ text: gap }] : []), { text: labels[r] ?? r, fg: t[r] }])
  for (const [labels, gap] of [[LABEL, "  "], [LABEL, " "], [SHORT, " "]] as const) {
    const sp = line(ROLES, labels, gap)
    if (spanWidth(sp) <= w) return sp
  }
  return line(ROLES.slice(0, 6), SHORT, " ")
}

/**
 * The pane's rows in theme `t` (drawn on `t.background`): the name with its text contrast, the
 * role words, a blank, then `view` (the sample at `w`) with its code rows filled
 * to the width; at most `h` rows.
 */
export function paneLines(t: Theme, view: Rendered, w: number, h: number): Span[][] {
  const right = `text ${contrast(t.text, t.background).toFixed(1)}:1`
  const head: Span[] = width(t.name) + 1 + width(right) <= w
    ? [{ text: t.name, fg: t.textMuted }, { text: " ".repeat(w - width(t.name) - width(right)) }, { text: right, fg: t.textMuted }]
    : [{ text: t.name, fg: t.textMuted }]
  const out: Span[][] = [head, roleWords(t, w), []]
  for (const l of view.lines) {
    if (!l.fill) {
      out.push(l.spans)
      continue
    }
    const used = spanWidth(l.spans)
    out.push([...l.spans.map((s) => ({ ...s, bg: s.bg ?? l.fill })), { text: " ".repeat(Math.max(0, w - used)), bg: l.fill }])
  }
  return out.slice(0, h)
}
