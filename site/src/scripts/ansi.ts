// The terminal side of the demo player, without the DOM: the screen model the casts are replayed into and the glyphs
// the player draws itself. It understands exactly what brothy-studio's cast tool writes: cursor position (CUP), clear screen
// (ED 2), the cursor-visibility toggle (ignored) and SGR 0/1/3/4/9 with truecolor 38;2 / 48;2. tests/site/casts.test.ts
// fails when a committed cast uses anything else, or a box/block glyph the player has no drawing for.

/** box-drawing arms: l r u d; upper case for heavy; "dash" for the light quadruple-dash rule */
export const BOX: Record<string, string> = {
  "─": "lr", "│": "ud", "┌": "dr", "┐": "dl", "└": "ur", "┘": "ul", "├": "udr", "┤": "udl", "┬": "dlr", "┴": "ulr", "┼": "udlr",
  "━": "LR", "┈": "dash",
}
/** block elements as [left, right] fractions of the cell */
export const BLOCK: Record<string, [number, number]> = { "▌": [0, 0.5], "▐": [0.5, 1], "▎": [0, 0.25], "▏": [0, 0.125], "▕": [0.875, 1], "█": [0, 1] }

const CSI = /\x1b\[([?0-9;]*)([A-Za-z])|([^\x1b])|(\x1b)/gsu
const SGR_FLAGS: Record<number, number> = { 1: 1, 3: 2, 4: 4, 9: 8 }

/** The escape sequences in `d` the screen model does not handle (each as written). */
export function unsupported(d: string): string[] {
  const out: string[] = []
  for (let m; (m = CSI.exec(d)); ) {
    if (m[4]) { out.push(d.slice(m.index, m.index + 2)); continue }
    if (m[3] !== undefined) continue
    const p = m[1]!, f = m[2]!
    const ok =
      f === "H" ? /^\d*(;\d*)?$/.test(p)
      : f === "J" ? p === "2"
      : f === "l" || f === "h" ? p === "?25"
      : f === "m" ? sgrOk(p)
      : false
    if (!ok) out.push(m[0])
  }
  CSI.lastIndex = 0
  return out
}

function sgrOk(p: string) {
  const v = p.split(";").map((x) => (x === "" ? 0 : Number(x)))
  for (let k = 0; k < v.length; k++) {
    if (v[k] === 0 || SGR_FLAGS[v[k]!]) continue
    if ((v[k] === 38 || v[k] === 48) && v[k + 1] === 2 && v.slice(k + 2, k + 5).length === 3) { k += 4; continue }
    return false
  }
  return true
}

/** Box-drawing and block glyphs (U+2500–259F) in `d` that the player would have to take from a font. */
export function undrawn(d: string): string[] {
  const text = d.replace(/\x1b\[[?0-9;]*[A-Za-z]/g, "")
  return [...new Set([...text].filter((c) => c >= "─" && c <= "▟" && !BOX[c] && !BLOCK[c]))]
}

export class Screen {
  ch: string[]; fg: (string | null)[]; bg: (string | null)[]; at: Uint8Array
  x = 0; y = 0
  cur = { fg: null as string | null, bg: null as string | null, at: 0 }
  constructor(readonly cols: number, readonly rows: number) {
    const n = cols * rows
    this.ch = new Array(n).fill(" "); this.fg = new Array(n).fill(null); this.bg = new Array(n).fill(null); this.at = new Uint8Array(n)
  }
  clear() { this.ch.fill(" "); this.fg.fill(null); this.bg.fill(null); this.at.fill(0) }
  write(d: string) {
    for (let m; (m = CSI.exec(d)); ) {
      const c = m[3]
      if (m[4]) continue
      if (c !== undefined) {
        if (c === "\n") { this.y++; continue }
        if (c === "\r") { this.x = 0; continue }
        if (this.x < this.cols && this.y < this.rows) {
          const i = this.y * this.cols + this.x
          this.ch[i] = c; this.fg[i] = this.cur.fg; this.bg[i] = this.cur.bg; this.at[i] = this.cur.at
        }
        this.x++
        continue
      }
      const p = m[1]!.split(";").map(Number), f = m[2]
      if (f === "H") { this.y = (p[0] || 1) - 1; this.x = (p[1] || 1) - 1 }
      else if (f === "J" && p[0] === 2) this.clear()
      else if (f === "m")
        for (let k = 0; k < p.length; k++) {
          const v = p[k] || 0
          if (v === 0) this.cur = { fg: null, bg: null, at: 0 }
          else if (SGR_FLAGS[v]) this.cur.at |= SGR_FLAGS[v]!
          else if ((v === 38 || v === 48) && p[k + 1] === 2) {
            const rgb = `${p[k + 2]},${p[k + 3]},${p[k + 4]}`
            if (v === 38) this.cur.fg = rgb
            else this.cur.bg = rgb
            k += 4
          }
        }
    }
    CSI.lastIndex = 0
  }
}
