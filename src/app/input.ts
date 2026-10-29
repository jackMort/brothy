// Text input in the popups and the panel filter: which keys type, and how ⌫ erases. Pure.
import type { KeyEvent } from "@opentui/core"

/** The text key `k` types into a query: its sequence when printable and pressed without ctrl or meta, else null. */
export function typed(k: Pick<KeyEvent, "sequence" | "ctrl" | "meta">): string | null {
  return k.sequence && !k.ctrl && !k.meta && /^[^\x00-\x1f\x7f]+$/.test(k.sequence) ? k.sequence : null
}

/** `s` without its last code point: ⌫ never leaves half a surrogate pair. */
export const erase = (s: string) => [...s].slice(0, -1).join("")
