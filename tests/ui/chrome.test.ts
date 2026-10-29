import { expect, test } from "bun:test"
import { HELP_GROUP_TITLES, INK_STEPS, STEAM_FLOOR, chip, fade, fadeSpans, groupColor, inkAt, keycap, keycaps, steamColors } from "../../src/ui/chrome"
import { contrast, themes } from "../../src/theme/theme"
import { brothy } from "../helpers/theme"

test("groupColor: Global primary, Document secondary, Zen info, Panel success, AI accent", () => {
  expect(HELP_GROUP_TITLES).toEqual(["Global", "Document", "Zen", "Panel", "AI"])
  expect(HELP_GROUP_TITLES.map((g) => groupColor(brothy, g))).toEqual([brothy.primary, brothy.secondary, brothy.info, brothy.success, brothy.accent])
  expect(groupColor(brothy, "Other")).toBe(brothy.textMuted)
})

test("chip: the group's role in bold on backgroundElement, one cell of padding, 3:1 in every theme", () => {
  const c = chip(brothy, "Global", brothy.primary)
  expect(c.map((s) => s.text).join("")).toBe(" Global ")
  for (const s of c) expect(s.bg).toBe(brothy.backgroundElement)
  expect(c[1]).toMatchObject({ fg: brothy.primary, attr: 1 })
  for (const t of themes) for (const g of HELP_GROUP_TITLES) expect(contrast(groupColor(t, g), t.backgroundElement), `${t.name} ${g}`).toBeGreaterThanOrEqual(3)
})

test("keycap: markdown's <kbd> style (accent on backgroundElement), padded by one cell", () => {
  expect(keycap(brothy, "o")).toEqual([{ text: " o ", fg: brothy.accent, bg: brothy.backgroundElement }])
  expect(
    keycaps(brothy, [
      ["o", "open"],
      ["q", "quit"],
    ])
      .map((s) => s.text)
      .join(""),
  ).toBe(" o  open    q  quit")
  for (const t of themes) expect(contrast(t.accent, t.backgroundElement), t.name).toBeGreaterThanOrEqual(3)
})

test("inkAt: border, then the role faded 2/5 and 1/5, then the role itself", () => {
  const c = brothy.primary
  expect(INK_STEPS).toBe(4)
  expect([0, 1, 2, 3].map((k) => inkAt(brothy, k, c))).toEqual([brothy.border, fade(brothy, c, 2 / 5), fade(brothy, c, 1 / 5), c])
  expect(inkAt(brothy, 9, c)).toBe(c)
  expect(inkAt(brothy, -1, c)).toBe(brothy.border)
})

test("steamColors: textMuted by the bowl, faded 1/5 and 2/5 going up, borderSubtle on top (or textMuted 3/5 where it barely shows)", () => {
  const rows = steamColors(brothy)
  expect(rows).toHaveLength(5)
  expect(rows.slice(2)).toEqual([fade(brothy, brothy.textMuted, 2 / 5), fade(brothy, brothy.textMuted, 1 / 5), brothy.textMuted])
  expect(rows[0]).toBe(brothy.borderSubtle)
  const gruv = themes.find((t) => t.name === "gruvbox")!
  expect(steamColors(gruv)[0]).toBe(fade(gruv, gruv.textMuted, 3 / 5))
  for (const t of themes) for (const c of steamColors(t)) expect(contrast(c, t.background), t.name).toBeGreaterThanOrEqual(STEAM_FLOOR)
})

test("fadeSpans fades every span's colour toward the background, text where none is set", () => {
  const spans = [{ text: "a", fg: brothy.primary, attr: 1 }, { text: "b" }]
  expect(fadeSpans(brothy, spans, 2 / 5)).toEqual([
    { text: "a", fg: fade(brothy, brothy.primary, 2 / 5), attr: 1 },
    { text: "b", fg: fade(brothy, brothy.text, 2 / 5) },
  ])
  expect(fadeSpans(brothy, spans, 1).map((s) => s.fg)).toEqual([brothy.background, brothy.background])
  expect(spans[1]).toEqual({ text: "b" }) // the input is left as it was
})
