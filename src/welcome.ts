// The welcome page's pure side (no Markdown files in the folder): the wordmark over a bowl of broth drawn in
// quadrant blocks, braille steam rising off it, and which blocks fit the document area.
import { WORDMARK, WORDMARK_W } from "./status"

/** steam frame interval */
export const STEAM_MS = 150
/** the steam frame drawn still (motion off, tests, snapshots) */
export const STILL_TICK = 12
/** recent projects listed under the actions */
export const WELCOME_RECENTS = 5

export interface WelcomeSize {
  steamW: number
  steamH: number
  bowlW: number
  bowlH: number
  foot: boolean
  sticks: boolean
}
/** The bowl at 120×34: a 30-cell rim, five body rows, a foot and chopsticks, 22×4 cells of steam. */
export const BIG: WelcomeSize = { steamW: 22, steamH: 4, bowlW: 28, bowlH: 5, foot: true, sticks: true }
/** The bowl at 80×24: a 20-cell rim, three body rows, 16×2 cells of steam, no foot and no chopsticks. */
export const SMALL: WelcomeSize = { steamW: 16, steamH: 2, bowlW: 18, bowlH: 3, foot: false, sticks: false }

/** Cells the art spans: the bowl's rim, or the wordmark when that is wider (it is, for both bowls: 36). */
export const artWidth = (size: WelcomeSize) => Math.max(size.bowlW + 2, WORDMARK_W)

/** braille dot bits by [row][column] inside a cell */
const BRAILLE = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const
/** quadrant blocks by bits: 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right */
const QUAD = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"]

/** Steam at `tick`: 26 particles on a `w`×`h` braille field, born on the bottom row (the broth), drifting up and out. */
export function steamRows(tick: number, w: number, h: number): string[] {
  const W = w * 2
  const H = h * 4
  const dots = new Uint8Array(W * H)
  const per = H + 8
  for (let i = 0; i < 26; i++) {
    const life = (tick * 0.55 + (i * per) / 26) % per
    const py = Math.round(H - 1 - life)
    if (py < 0 || py >= H) continue
    const px = Math.round(W / 2 + Math.sin(tick * 0.11 + i * 1.9 + life * 0.2) * (1.5 + life * 0.3) + (((i * 7) % 11) - 5) * 1.1)
    if (px >= 0 && px < W) dots[py * W + px] = 1
    if (life < H * 0.5 && px + 1 >= 0 && px + 1 < W) dots[py * W + px + 1] = 1
  }
  const rows: string[] = []
  for (let cy = 0; cy < h; cy++) {
    let s = ""
    for (let cx = 0; cx < w; cx++) {
      let b = 0
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) if (dots[(cy * 4 + dy) * W + cx * 2 + dx]) b |= BRAILLE[dy]![dx]!
      s += b ? String.fromCharCode(0x2800 + b) : " "
    }
    rows.push(s)
  }
  return rows
}

/**
 * One cell of the art. Roles map to theme colours in the component: `mark` and `body` primary, `edge` (rim and
 * chopsticks) text, `steam` its row's steam colour (`row`, 0–4 from the top). A `broth` cell has the broth
 * (secondary) behind it: the top half of the rim's inner cells.
 */
export interface ArtCell {
  ch: string
  role: "none" | "mark" | "body" | "edge" | "steam"
  row?: number
  broth?: boolean
}

/** The art, `artWidth` cells wide: the wordmark, then (with `bowl`) the steam field over the bowl. */
export function welcomeArt(size: WelcomeSize, tick: number, o: { steam?: boolean; bowl?: boolean } = {}): ArtCell[][] {
  const { steam = true, bowl = true } = o
  const w = size.bowlW
  const AW = artWidth(size)
  const ox = (AW - (w + 2)) >> 1 // the bowl centred under a wider wordmark
  const cx = AW >> 1
  // the big bowl keeps its steam rows (the chopsticks stand in them); the small one gives them up
  const steamH = steam || size.sticks ? size.steamH : 0
  const gap = size.sticks ? 1 : 0
  const rim = WORDMARK.length + gap + steamH
  const height = bowl ? rim + 1 + size.bowlH + (size.foot ? 1 : 0) : WORDMARK.length
  const g: ArtCell[][] = Array.from({ length: height }, () => Array.from({ length: AW }, () => ({ ch: " ", role: "none" as const })))
  const put = (x: number, y: number, c: ArtCell) => {
    if (y >= 0 && y < height && x >= 0 && x < AW) g[y]![x] = c
  }
  WORDMARK.forEach((l, y) => [...l].forEach((ch, i) => ch !== " " && put(cx - (WORDMARK_W >> 1) + i, y, { ch, role: "mark" })))
  if (!bowl) return g
  if (steam)
    steamRows(tick, size.steamW, size.steamH).forEach((r, cy) =>
      [...r].forEach((ch, i) => ch !== " " && put(cx - (size.steamW >> 1) + i, rim - size.steamH + cy, { ch, role: "steam", row: cy + 5 - size.steamH })),
    )
  // rim: one cell wider than the body each side, rounded at the ends; the broth fills the top half of its inner cells
  for (let i = 0; i < w + 2; i++) put(ox + i, rim, { ch: i === 0 ? "▗" : i === w + 1 ? "▖" : "▄", role: "edge", broth: i >= 2 && i < w })
  // body: a quarter ellipse at 2×2 pixels per cell, so the last row is still about half the rim
  const PH = size.bowlH * 2
  const px = (r: number, c: number) => (Math.abs(c + 0.5 - w) <= w * Math.sqrt(1 - ((r + 0.5) / (PH * 1.12)) ** 2) ? 1 : 0)
  for (let cy = 0; cy < size.bowlH; cy++)
    for (let c = 0; c < w; c++) {
      const [r, p] = [cy * 2, c * 2]
      const ch = QUAD[px(r, p) | (px(r, p + 1) << 1) | (px(r + 1, p) << 2) | (px(r + 1, p + 1) << 3)]!
      if (ch !== " ") put(ox + 1 + c, rim + 1 + cy, { ch, role: "body" })
    }
  if (size.foot) {
    const fw = Math.round(w * 0.4)
    ;[..."▝" + "▀".repeat(fw - 2) + "▘"].forEach((ch, i) => put(cx - (fw >> 1) + i, rim + 1 + size.bowlH, { ch, role: "body" }))
  }
  // chopsticks: two steep diagonals resting in the broth, right of the steam
  if (size.sticks) {
    const sx = cx + (w >> 1) - 5
    for (let j = 0; j < 5; j++) put(sx + j, rim - 1 - j, { ch: "▞", role: "edge" })
    for (let j = 0; j < 4; j++) put(sx + 2 + j, rim - 1 - j, { ch: "▞", role: "edge" })
  }
  return g
}

export interface WelcomeFit {
  size: WelcomeSize
  steam: boolean
  bowl: boolean
  mark: boolean
  /** recent rows listed (0 leaves out the header too) */
  recents: number
  /** the hint row under the list */
  hint: boolean
  /** blank rows above the first block */
  top: number
  /** rows of the whole page */
  height: number
}

const artHeight = (f: Pick<WelcomeFit, "size" | "steam" | "bowl" | "mark">) =>
  !f.mark ? 0 : !f.bowl ? WORDMARK.length : welcomeArt(f.size, 0, { steam: f.steam }).length

/**
 * The page's height: art, a blank, the message, a blank, the keycaps; then a blank, the `Recent` header and its
 * rows; then the hint row, after a blank when the page is roomy (the big bowl) or there is no list above it.
 */
function pageHeight(f: Omit<WelcomeFit, "top" | "height" | "hint">, hint: boolean) {
  const art = artHeight(f)
  const list = f.recents ? 2 + f.recents : 0
  return art + (art ? 1 : 0) + 3 + list + (hint ? (f.size === BIG && f.mark && f.bowl) || !f.recents ? 2 : 1 : 0)
}

/** What fits a `CW`×`CH` area. In order the page gives up: the big bowl, the steam, recent rows, the bowl, the wordmark, the hint. */
export function welcomeFit(CW: number, CH: number, recents: number): WelcomeFit {
  const n = Math.min(recents, WELCOME_RECENTS)
  const tries: [Omit<WelcomeFit, "top" | "height" | "hint">, boolean][] = []
  if (CW >= artWidth(BIG)) tries.push([{ size: BIG, steam: true, bowl: true, mark: true, recents: n }, true])
  if (CW >= artWidth(SMALL)) {
    tries.push([{ size: SMALL, steam: true, bowl: true, mark: true, recents: n }, true])
    for (let k = n; k >= 0; k--) tries.push([{ size: SMALL, steam: false, bowl: true, mark: true, recents: k }, true])
  }
  if (CW >= WORDMARK_W) tries.push([{ size: SMALL, steam: false, bowl: false, mark: true, recents: 0 }, true])
  tries.push([{ size: SMALL, steam: false, bowl: false, mark: false, recents: 0 }, true])
  tries.push([{ size: SMALL, steam: false, bowl: false, mark: false, recents: 0 }, false])
  const [f, hint] = tries.find(([f, hint]) => pageHeight(f, hint) <= CH) ?? tries.at(-1)!
  const height = pageHeight(f, hint)
  return { ...f, hint, top: Math.max(0, Math.floor((CH - height) / 2)), height }
}
