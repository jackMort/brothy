// WCAG contrast of each theme role against the surfaces it is drawn on, plus the two accent roles that look most alike.
// Usage: bun scripts/contrast.ts [theme…]   (default: brothy brothy-light; ✗ marks a miss of the house floors in HOUSE)
import { contrast, surface, themeByName, themes, type Theme } from "../src/theme/theme"

/** role, what it draws (markdown/render.ts, markdown/highlight.ts), the house floor; borders are decorative and never sit on the code fill */
export const HOUSE: [keyof Theme, string, number][] = [
  ["text", "body text", 7],
  ["textMuted", "muted, comments, punctuation", 4.5],
  ["primary", "H1, bullets, functions", 4.5],
  ["secondary", "H2, keywords", 4.5],
  ["accent", "H3, escapes, kbd, tip callouts", 4.5],
  ["info", "links, types, note callouts", 4.5],
  ["success", "strings, done tasks", 4.5],
  ["warning", "inline code, numbers, ==mark==", 4.5],
  ["error", "failure/danger callouts, error toasts", 4.5],
  ["border", "panel edges (decorative)", 1.5],
  ["borderSubtle", "faint rules, steam (decorative)", 1.5],
]
/** the house body text on the page */
export const HOUSE_TEXT = 13.5
/** the closest two accent roles may come, in OKLab distance ×100 (below ~5 they read as one colour) */
export const HOUSE_APART = 5

/** the page, the side panel (`surface().side`) and the code-block fill */
const surfaces = (t: Theme) => ({ bg: t.background, side: surface(t, false).side, el: t.backgroundElement })

export function ratios(t: Theme, k: keyof Theme) {
  const s = surfaces(t)
  return { bg: contrast(t[k], s.bg), side: contrast(t[k], s.side), el: contrast(t[k], s.el) }
}

/** the lowest ratio `k` gets where it is drawn: borders on page and panel, content on all three surfaces */
export function worst(t: Theme, k: keyof Theme) {
  const r = ratios(t, k)
  return k.startsWith("border") ? Math.min(r.bg, r.side) : Math.min(r.bg, r.side, r.el)
}

function oklab(hex: string): [number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** the two accent roles that look most alike and their OKLab distance ×100 */
export function closestPair(t: Theme): { pair: [keyof Theme, keyof Theme]; dE: number } {
  const roles = ["primary", "secondary", "accent", "info", "success", "warning", "error"] as const
  let best = { pair: [roles[0], roles[1]] as [keyof Theme, keyof Theme], dE: Infinity }
  for (const [i, a] of roles.entries())
    for (const b of roles.slice(i + 1)) {
      const x = oklab(t[a]),
        y = oklab(t[b])
      const dE = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100
      if (dE < best.dE) best = { pair: [a, b], dE }
    }
  return best
}

if (import.meta.main) {
  const names = process.argv.slice(2)
  for (const name of names.length ? names : ["brothy", "brothy-light"]) {
    const t = themeByName(name)
    if (t.name !== name) {
      console.error(`contrast: unknown theme "${name}" (${themes.map((x) => x.name).join(", ")})`)
      process.exit(1)
    }
    const s = surfaces(t)
    console.log(`\n${t.name}  page ${s.bg}  panel ${s.side}  code ${s.el}`)
    for (const [k, use, floor] of HOUSE) {
      const r = ratios(t, k)
      const miss = worst(t, k) < floor || (k === "text" && r.bg < HOUSE_TEXT)
      const n = (x: number) => x.toFixed(2).padStart(6)
      console.log(`  ${k.padEnd(13)} ${t[k]}  page${n(r.bg)}  panel${n(r.side)}  code${n(r.el)}  ≥${floor}${miss ? " ✗" : "  "}  ${use}`)
    }
    const c = closestPair(t)
    console.log(`  closest pair  ${c.pair.join(" / ")}  ΔE ${c.dE.toFixed(1)}${c.dE < HOUSE_APART ? " ✗" : ""}`)
  }
}
