// The docs site's art, drawn from the app's own source: bun scripts/site-art.ts writes site/src/art.json.
//   wordmark: WORDMARK (src/ui/status.ts) as SVG, each half-block glyph turned into rectangles, so no font is needed
//   bowl:     welcomeArt(BIG) (src/ui/welcome.ts) as SVG, quadrant blocks as rectangles, one path per role
//   steam:    STEAM_FRAMES ticks of steamRows over the bowl, played back by the site (motion allowed only)
// The site build runs without the root's dependencies, so the output is committed; tests/site/site-art.test.ts keeps it current.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { WORDMARK } from "../src/ui/status"
import { BIG, STILL_TICK, artWidth, steamRows, welcomeArt } from "../src/ui/welcome"

/** a cell in SVG units: the terminal's 1:2 cell */
const CW = 10,
  CH = 20
export const STEAM_FRAMES = 120

/** the half-block glyphs the wordmark uses: which halves of the cell are ink (top, bottom) */
const HALVES: Record<string, [boolean, boolean]> = { "▀": [true, false], "▄": [false, true], "█": [true, true] }
const QUAD = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"]

const n = (v: number) => +v.toFixed(2)
const rect = (x: number, y: number, w: number, h: number) => `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}z`

export function siteArt() {
  let mark = ""
  WORDMARK.forEach((line, row) =>
    [...line].forEach((ch, col) => {
      const h = HALVES[ch]
      if (!h) {
        if (ch !== " ") throw new Error(`site-art: no halves for ${ch}`)
        return
      }
      if (h[0]) mark += rect(col * CW, row * CH, CW, CH / 2)
      if (h[1]) mark += rect(col * CW, row * CH + CH / 2, CW, CH / 2)
    }),
  )
  // the bowl alone: the art is as wide as the wordmark, the bowl sits centred in it
  const ox = (artWidth(BIG) - (BIG.bowlW + 2)) >> 1
  const art = welcomeArt(BIG, STILL_TICK, { steam: false })
    .slice(WORDMARK.length)
    .map((r) => r.slice(ox, ox + BIG.bowlW + 2))
  const paths = { body: "", edge: "", broth: "" }
  art.forEach((row, y) =>
    row.forEach((c, x) => {
      if (c.role !== "body" && c.role !== "edge") return
      const bits = QUAD.indexOf(c.ch)
      for (const [dx, dy, b] of [
        [0, 0, 1],
        [1, 0, 2],
        [0, 1, 4],
        [1, 1, 8],
      ] as const)
        if (bits & b) paths[c.role] += rect(x * CW + (dx * CW) / 2, y * CH + (dy * CH) / 2, CW / 2, CH / 2)
      if (c.broth) paths.broth += rect(x * CW, y * CH, CW, CH / 2)
    }),
  )
  // the steam field sits on the rim, centred, as welcomeArt places it
  const rim = art.findIndex((row) => row.some((c) => c.role === "edge" && c.ch === "▄"))
  const cx = art[0]!.length >> 1
  return {
    cell: { w: CW, h: CH },
    wordmark: { w: Math.max(...WORDMARK.map((l) => [...l].length)) * CW, h: WORDMARK.length * CH, d: mark },
    bowl: { w: art[0]!.length * CW, h: art.length * CH, ...paths },
    steam: {
      x: (cx - (BIG.steamW >> 1)) * CW,
      y: (rim - BIG.steamH) * CH,
      still: STILL_TICK,
      frames: Array.from({ length: STEAM_FRAMES }, (_, t) => steamRows(t, BIG.steamW, BIG.steamH)),
    },
  }
}

export const ART_PATH = join(import.meta.dir, "../site/src/art.json")

if (import.meta.main) {
  writeFileSync(ART_PATH, JSON.stringify(siteArt()) + "\n")
  console.log(`wrote ${ART_PATH}`)
}
