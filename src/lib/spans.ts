// Styled text: the `Span` every renderer returns, its attribute flags `A`, and `safe`/`safeLine`, which keep
// what reaches the terminal from injecting escapes or hiding text. Pure; a leaf (markdown, highlight and text build on it).

export const A = {
  NONE: 0,
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  STRIKE: 1 << 7,
} as const

export interface Span {
  text: string
  fg?: string
  bg?: string
  attr?: number
  /** index into `Rendered.links` when this text belongs to a link */
  link?: number
}

/**
 * Characters that must not reach the terminal as themselves: C0 (but tab and newline), DEL, C1;
 * bidi overrides, embeddings and isolates (U+202A–202E, U+2066–2069), which reorder what is
 * shown; zero-width space/joiner/marks (U+200B–200F) and a BOM (U+FEFF), which hide text.
 * A ZWJ (U+200D) is kept when it joins two emoji (👨‍👩‍👧, 👩🏽‍💻, 🏳️‍🌈), where it is part of
 * one grapheme and dropping it would change the width, and after a letter or combining mark, where
 * Indic scripts need it (Sinhala ශ්‍රී, Malayalam chillu, Devanagari half-forms); anywhere else it
 * is mapped. A ZWNJ (U+200C) is kept between letters or combining marks (Persian, Arabic, Indic
 * orthography), else mapped.
 */
const UNSAFE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: the combining marks and ZWJ are matched on purpose (see above)
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]|(?<![\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f])\u200d|(?<![\p{L}\p{M}])\u200d(?!\p{Extended_Pictographic})|(?<![\p{L}\p{M}])\u200c|\u200c(?![\p{L}\p{M}])/gu

/** Replace the characters above with U+FFFD so text can never inject escape sequences, reorder or hide itself. */
export const safe = (s: string) => s.replace(UNSAFE, "�")

/** `safe` for one-row text (names, titles, toasts): tab and newline become spaces. */
export const safeLine = (s: string) => safe(s).replace(/[\t\n]/g, " ")

/** The text of a rendered line (its spans joined); "" for a missing one. */
export const lineText = (l: { spans: Span[] } | undefined) => (l?.spans ?? []).map((s) => s.text).join("")
