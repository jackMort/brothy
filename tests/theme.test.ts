import { expect, test } from "bun:test"
import { CLEAR, contrast, contrastOn, mix, surface, themeByName, themes } from "../src/theme"

test("contrastOn picks dark text on light backgrounds and light on dark", () => {
  expect(contrastOn("#ffffff")).toBe("#1a1a1a")
  expect(contrastOn("#f2c65a")).toBe("#1a1a1a")
  expect(contrastOn("#000000")).toBe("#f0f0f0")
  expect(contrastOn("#181714")).toBe("#f0f0f0")
})

test("contrastOn gives every theme's primary a readable foreground", () => {
  for (const t of themes) expect(["#1a1a1a", "#f0f0f0"]).toContain(contrastOn(t.primary))
})

test("mix blends two colors channel by channel", () => {
  expect(mix("#000000", "#ffffff", 0)).toBe("#000000")
  expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff")
  expect(mix("#181714", "#24211d", 0.6)).toBe("#1f1d19")
})

const SLOTS = [
  "primary", "secondary", "accent", "error", "warning", "success", "info", "text", "textMuted",
  "background", "backgroundPanel", "backgroundElement", "border", "borderActive", "borderSubtle",
] as const

test("themes: 22 families: 20 a dark theme plus a '-light' twin, 2 dark-only, darks listed first", () => {
  expect(themes).toHaveLength(42)
  const names = themes.map((t) => t.name)
  expect(new Set(names).size).toBe(42)
  const dark = themes.filter((t) => t.mode === "dark")
  const light = themes.filter((t) => t.mode === "light")
  expect(dark).toHaveLength(22)
  expect(light).toHaveLength(20)
  expect(themes.slice(0, 22)).toEqual(dark)
  const twin = (d: string) => (d === "one-dark" ? "one-light" : d + "-light")
  // a light theme always has its dark twin; the darks without one are the single-mode families
  for (const l of light) expect(dark.map((d) => twin(d.name))).toContain(l.name)
  expect(dark.filter((d) => !names.includes(twin(d.name))).map((d) => d.name)).toEqual(["synthwave84", "vesper"])
  expect(names.slice(0, 5)).toEqual(["brothy", "catppuccin", "dracula", "tokyonight", "gruvbox"])
})

test("themes: every slot is a #rrggbb color", () => {
  for (const t of themes) for (const k of SLOTS) expect(t[k], `${t.name}.${k}`).toMatch(/^#[0-9a-f]{6}$/)
})

test("themes: light themes have a lighter background than text, dark the opposite", () => {
  for (const t of themes) {
    const dBg = contrast(t.background, "#000000")
    const dTx = contrast(t.text, "#000000")
    if (t.mode === "light") expect(dBg, t.name).toBeGreaterThan(dTx)
    else expect(dBg, t.name).toBeLessThan(dTx)
  }
})

test("themes: contrast floors on background and backgroundPanel", () => {
  const floors: [(typeof SLOTS)[number], number][] = [
    ["text", 4.5], ["textMuted", 4.5], ["primary", 4.5], ["secondary", 4.5], ["accent", 4.5],
    ["error", 3], ["warning", 3], ["success", 3], ["info", 3],
  ]
  for (const t of themes)
    for (const [k, min] of floors)
      for (const bg of ["background", "backgroundPanel"] as const)
        expect(contrast(t[k], t[bg]), `${t.name} ${k} on ${bg}`).toBeGreaterThanOrEqual(min)
})

test("themeByName falls back to brothy", () => {
  expect(themeByName("nord-light").mode).toBe("light")
  expect(themeByName("nope").name).toBe("brothy")
})

test("themes: content colors stay readable on backgroundElement (code blocks, find match)", () => {
  const floors: [(typeof SLOTS)[number], number][] = [
    ["text", 4.5], ["textMuted", 3], ["primary", 3], ["secondary", 3], ["accent", 3],
    ["error", 3], ["warning", 3], ["success", 3], ["info", 3],
  ]
  for (const t of themes)
    for (const [k, min] of floors) expect(contrast(t[k], t.backgroundElement), `${t.name} ${k} on backgroundElement`).toBeGreaterThanOrEqual(min)
})

test("themes: the picker/selection fill (primary) carries readable text", () => {
  for (const t of themes) expect(contrast(t.primary, contrastOn(t.primary)), t.name).toBeGreaterThanOrEqual(4.5)
})

test("surface: opaque keeps the theme fills, transparent clears them all", () => {
  const t = themes[0]!
  expect(surface(t, false)).toEqual({ main: t.background, side: mix(t.background, t.backgroundElement, 0.6) })
  expect(surface(t, true)).toEqual({ main: CLEAR, side: CLEAR })
})
