// The site's palettes, read from the app's own src/theme.ts at build time: nothing here is a copied hex, so a changed
// palette in theme.ts reaches the site on the next build. `siteThemesCss()` is one block of `--b-*` tokens per theme
// (written to src/generated/themes.css by the `brothyThemes` integration, see astro.config.mjs); `families` feeds the
// picker (ThemeSelect.astro, through src/generated/families.json so the page's script carries only the specimens, not
// every palette) and the pre-paint head script.
import { themes, type Theme } from "../../src/theme"

export type Mode = Theme["mode"]
/** The picker's row: a dark / light pair, or one of them (synthwave84, vesper); `x` or `x-dark` with `x-light`, as src/themepick.ts groups them. */
export interface Family {
  name: string
  dark?: Specimen
  light?: Specimen
}
/** What the picker draws for a theme: its own background and the roles of its ` Aa ●●● ` specimen. */
export interface Specimen {
  theme: string
  bg: string
  text: string
  primary: string
  secondary: string
  accent: string
}

const spec = (t: Theme): Specimen => ({ theme: t.name, bg: t.background, text: t.text, primary: t.primary, secondary: t.secondary, accent: t.accent })

/** The palettes grouped by family name, in theme.ts order of each family's first palette (the picker's order). */
export const families: Family[] = (() => {
  const by = new Map<string, Family>()
  for (const t of themes) {
    const name = t.name.replace(/-(dark|light)$/, "")
    let f = by.get(name)
    if (!f) by.set(name, (f = { name }))
    f[t.mode] = spec(t)
  }
  return [...by.values()]
})()

/** The family's one mode, for the single-mode ones. */
export const onlyModes: Record<string, Mode> = Object.fromEntries(families.filter((f) => !(f.dark && f.light)).map((f) => [f.name, f.dark ? "dark" : "light"]))

/** What the picker's script imports (src/generated/families.json). */
export const pickerData = { families, only: onlyModes }

const rgba = (hex: string, a: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")}, ${a})`

/** The tokens brothy.css and the components use: the palette's roles, and the demo window's glass, edge, shadow and wallpaper wash derived from them. */
function tokens(t: Theme): string {
  const dark = t.mode === "dark"
  return [
    `  --b-primary: ${t.primary}; --b-secondary: ${t.secondary}; --b-accent: ${t.accent};`,
    `  --b-error: ${t.error}; --b-warning: ${t.warning}; --b-success: ${t.success}; --b-info: ${t.info};`,
    `  --b-text: ${t.text}; --b-muted: ${t.textMuted};`,
    `  --b-bg: ${t.background}; --b-element: ${t.backgroundElement};`,
    `  --b-border: ${t.border}; --b-subtle: ${t.borderSubtle};`,
    `  --b-glass: ${rgba(t.background, dark ? 0.74 : 0.8)}; --b-glass-edge: ${rgba(t.text, dark ? 0.1 : 0.12)}; --b-shadow: ${dark ? "rgba(0, 0, 0, 0.55)" : rgba(t.text, 0.22)};`,
    `  --b-wash: ${dark ? 30 : 22}%;`,
    `  color-scheme: ${t.mode};`,
  ].join("\n")
}

/** brothy, with nothing chosen, is the page's own palette: dark by default, light under `data-theme="light"`. Every theme (brothy included) also has `[data-family][data-theme]`. */
const BASE: Record<string, string> = { brothy: ":root", "brothy-light": ':root[data-theme="light"]' }

export function siteThemesCss(): string {
  const head = `/* Generated from src/theme.ts by src/themes.ts (the brothyThemes integration in astro.config.mjs). Do not edit. */\n`
  return (
    head +
    themes
      .map((t) => {
        const family = t.name.replace(/-(dark|light)$/, "")
        const sel = [BASE[t.name], `:root[data-family="${family}"][data-theme="${t.mode}"]`].filter(Boolean).join(",\n")
        return `\n/* ${t.name} */\n${sel} {\n${tokens(t)}\n}\n`
      })
      .join("")
  )
}

/** Runs in <head> before first paint: the stored family (else brothy), and the mode (stored, else the system's; a single-mode family's own). Starlight's ThemeProvider has set `data-theme` already. */
export const headScript = `(function(){try{var d=document.documentElement,s=localStorage,o=${JSON.stringify(onlyModes)},a=${JSON.stringify(families.map((f) => f.name))},f=s.getItem("brothy-family")||"",m=s.getItem("starlight-theme")||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");if(a.indexOf(f)<0)f="brothy";if(o[f])m=o[f];d.dataset.family=f;d.dataset.theme=m}catch(e){}})()`
