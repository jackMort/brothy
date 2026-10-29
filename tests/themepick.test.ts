import { afterAll, expect, test } from "bun:test"
import { cachedHighlight, ensureHighlights, shutdownHighlighter } from "../src/highlight"
import { pendingHighlights } from "../src/markdown"
import { PEEK_MIN_W } from "../src/geometry"
import { A, type Span } from "../src/spans"
import { width as sw } from "../src/text"
import { contrast, themeByName, themes, type Theme } from "../src/theme"
import { brothy } from "./helpers/theme"
import {
  BOARD_MODES,
  CELL_W,
  FAMILIES,
  NAME_W,
  SLOT_W,
  SAMPLE,
  THEME_LIST_W,
  boardFrames,
  boardHeader,
  boardLayout,
  boardSlot,
  familyOf,
  familyTheme,
  filterFamilies,
  listTop,
  paneLines,
  pickIndex,
  pickMode,
  pickMove,
  pickQuery,
  pickShown,
  pickStart,
  pickTheme,
  resolveTheme,
  pickTop,
  onlyMode,
  roleWords,
  sampleView,
  specimen,
  themeFamilies,
  themeSplit,
} from "../src/themepick"

afterAll(() => shutdownHighlighter())

const text = (r: Span[]) => r.map((s) => s.text).join("")
/**
 * The sample with its code block highlighted. The highlighter's worker and cache are shared by
 * every test file in the run, so a request another file left in flight may be dropped when its
 * renderer is destroyed; that leaves the block uncached and the next round asks again.
 */
async function highlighted(t: Theme, w: number) {
  let view = sampleView(t, w)
  for (let i = 0; i < 3 && pendingHighlights(view).length; i++) {
    await ensureHighlights(pendingHighlights(view))
    view = sampleView(t, w)
  }
  expect(pendingHighlights(view)).toEqual([])
  const code = SAMPLE.split("\n").find((l) => l.startsWith("let stock"))!
  expect(cachedHighlight("typescript", code)).toBeTruthy() // parsed, not pinned to the fallback
  return view
}
const names = (q: string) => filterFamilies(q).map((h) => h.family.name)

test("themeFamilies: 22 families in the darks' order, one-dark and one-light as one, synthwave84 and vesper dark-only", () => {
  expect(FAMILIES).toHaveLength(22)
  expect(FAMILIES.map((f) => f.name)).toEqual(themes.filter((t) => t.mode === "dark").map((t) => t.name.replace(/-dark$/, "")))
  for (const f of FAMILIES) {
    expect(f.dark?.mode ?? "dark").toBe("dark")
    expect(f.light?.mode ?? "light").toBe("light")
  }
  expect(FAMILIES.find((f) => f.name === "one")).toMatchObject({ dark: { name: "one-dark" }, light: { name: "one-light" } })
  expect(familyOf(themeByName("gruvbox-light"))?.name).toBe("gruvbox")
  expect(FAMILIES.filter((f) => onlyMode(f)).map((f) => [f.name, onlyMode(f)])).toEqual([["synthwave84", "dark"], ["vesper", "dark"]])
  expect(familyOf(themeByName("vesper"))).toEqual({ name: "vesper", dark: themeByName("vesper") })
  // a palette without its twin is a single-mode family of its own, light-only too
  const fams = themeFamilies([themeByName("nord"), themeByName("dracula-light"), themeByName("nord-light")])
  expect(fams.map((f) => [f.name, onlyMode(f)])).toEqual([["nord", undefined], ["dracula", "light"]])
  expect(familyTheme(fams[1]!, "dark").name).toBe("dracula-light")
  expect(familyTheme(fams[0]!, "light").name).toBe("nord-light")
  expect(NAME_W).toBe(13) // synthwave84
})

test("filterFamilies: fuzzy on the name, tightest and earliest first, hits marked; empty keeps theme order", () => {
  expect(names("")).toEqual(FAMILIES.map((f) => f.name))
  expect(names("  ")).toHaveLength(FAMILIES.length)
  expect(names("gru")).toEqual(["gruvbox"])
  expect(filterFamilies("gru")[0]!.hits).toEqual([0, 1, 2])
  expect(names("GRU")).toEqual(["gruvbox"]) // case-folded
  expect(names("o")[0]).toBe("one") // a hit at the start beats one later in the name
  expect(names("light")).toEqual([]) // the mode isn't part of the name
  expect(names("zz")).toEqual([])
})

test("pickStart opens on the current theme's family and mode", () => {
  expect(pickStart(themeByName("brothy"))).toEqual({ q: "", family: "brothy", mode: "dark", orig: "brothy", top: null })
  expect(pickStart(themeByName("one-light"))).toEqual({ q: "", family: "one", mode: "light", orig: "one-light", top: null })
  expect(pickTheme(pickStart(themeByName("kanagawa-light"))).name).toBe("kanagawa-light")
})

test("pickMove wraps among the filtered rows; pickQuery keeps the highlight while its family is listed", () => {
  const p = pickStart(themeByName("brothy"))
  expect(pickMove(p, 1).family).toBe("catppuccin")
  expect(pickMove(p, -1).family).toBe("vesper")
  const q = pickQuery(p, "r") // brothy has an r, so it stays
  expect(q.family).toBe("brothy")
  const g = pickQuery(q, "gru")
  expect(g.family).toBe("gruvbox")
  expect(pickMove(g, 1).family).toBe("gruvbox") // one row: moving stays
  // nothing matches: the highlight and the candidate stay, there is no row
  const none = pickQuery(g, "zz")
  expect(none.family).toBe("gruvbox")
  expect(pickIndex(none, filterFamilies(none.q))).toBe(-1)
  expect(pickMove(none, 1)).toBe(none)
})

test("pickMode flips, or sets: the candidate is the family in that mode", () => {
  const p = pickStart(themeByName("nord"))
  expect(pickTheme(pickMode(p)).name).toBe("nord-light")
  expect(pickTheme(pickMode(pickMode(p))).name).toBe("nord")
  expect(pickMode(p, "dark")).toEqual(p)
  expect(pickTheme(pickMode(p, "light")).name).toBe("nord-light")
  expect(pickShown(pickMode(p))).toBe("light")
})

test("a single-mode family: the candidate is its only theme, the mode keys do nothing, the asked mode comes back on the next pair", () => {
  const light = pickStart(themeByName("nord-light"))
  const syn = pickQuery(light, "synth")
  expect(syn.family).toBe("synthwave84")
  expect(syn.mode).toBe("light") // still asked for
  expect(pickTheme(syn).name).toBe("synthwave84") // the pane previews the dark theme
  expect(pickShown(syn)).toBe("dark") // and the switch shows dark active
  expect(pickMode(syn)).toBe(syn) // tab
  expect(pickMode(syn, "light")).toBe(syn) // → or a chip click
  expect(pickMode(syn, "dark")).toBe(syn) // ←
  // back on a pair the light theme returns
  const back = pickQuery(syn, "")
  expect(pickTheme(pickMove({ ...back, family: "github" }, -1)).name).toBe("nord-light")
  const theme = pickStart(themeByName("vesper"))
  expect(theme).toEqual({ q: "", family: "vesper", mode: "dark", orig: "vesper", top: null })
})

test("themeSplit: no pane below PEEK_MIN_W; from there a 41-wide list, a 58-wide pane at 120, taller rows", () => {
  expect(themeSplit(PEEK_MIN_W - 1, 24, 16)).toEqual({ split: false, width: 48, listW: 46, peekW: 0, rows: 16 })
  expect(themeSplit(60, 14, 6)).toEqual({ split: false, width: 48, listW: 46, peekW: 0, rows: 6 })
  expect(themeSplit(40, 14, 6).width).toBe(38) // never wider than the screen
  const g = themeSplit(120, 34, 16)
  expect(g).toEqual({ split: true, width: 108, listW: THEME_LIST_W, peekW: 58, rows: 24 })
  expect(THEME_LIST_W).toBe(41)
  expect(g.listW + 1 + g.peekW + 6).toBe(g.width - 2) // list, divider, pane (padding 2 left, 4 right)
  expect(themeSplit(100, 24, 16).rows).toBe(16) // H − 10 below the popup height keeps L.PH
  expect(themeSplit(200, 50, 16).width).toBe(116)
})

test("boardLayout: two slots after the name; with the pane the name gives up a cell and the gap is 1", () => {
  expect(BOARD_MODES).toEqual(["dark", "light"])
  expect(SLOT_W).toBe(CELL_W + 2)
  const split = boardLayout(THEME_LIST_W - 8) // PickerList's text width
  expect(split).toEqual({ nameW: NAME_W - 1, gap: 1, x: [12, 23] })
  expect(split.x[1] + SLOT_W).toBe(THEME_LIST_W - 8) // exactly full
  expect(boardLayout(themeSplit(80, 24, 16).listW - 8)).toEqual({ nameW: NAME_W, gap: 2, x: [13, 25] })
  expect(boardLayout(10).nameW).toBe(1) // never below one cell
})

test("specimen: ` Aa ●●● ` in the theme's own text, primary, secondary and accent, all on its background", () => {
  const x = themeByName("gruvbox-light")
  const sp = specimen(x)
  expect(text(sp)).toBe(" Aa ●●● ")
  expect(sw(text(sp))).toBe(CELL_W)
  expect(sp.every((s) => s.bg === x.background)).toBe(true)
  expect(sp.find((s) => s.text === "Aa")).toMatchObject({ fg: x.text, attr: A.BOLD })
  expect(sp.filter((s) => s.text === "●").map((s) => s.fg)).toEqual([x.primary, x.secondary, x.accent])
})

test("boardFrames: the cursor on the highlighted row's shown theme, current on the theme in use, nothing else", () => {
  const fam = (n: string) => FAMILIES.find((f) => f.name === n)!
  expect(boardFrames(fam("nord"), "light", "brothy", true)).toEqual({ dark: undefined, light: "cursor" })
  expect(boardFrames(fam("nord"), "light", "nord", true)).toEqual({ dark: "current", light: "cursor" })
  expect(boardFrames(fam("nord"), "dark", "nord", true)).toEqual({ dark: "cursor", light: undefined }) // the cursor wins
  expect(boardFrames(fam("nord"), "light", "nord", false)).toEqual({ dark: "current", light: undefined })
  // a dark-only family: the cursor sits on its only theme whatever the asked mode; the missing side has no frame
  expect(boardFrames(fam("vesper"), "light", "brothy", true)).toEqual({ dark: "cursor", light: undefined })
  expect(boardFrames(fam("synthwave84"), "light", "synthwave84", false)).toEqual({ dark: "current", light: undefined })
})

test("boardSlot: frame, specimen, frame in SLOT_W cells; the frames in the chrome's roles; a missing mode struck through", () => {
  const t = themeByName("brothy")
  const x = themeByName("nord")
  const cur = boardSlot(t, x, "dark", "cursor")
  expect(text(cur)).toBe("▐ Aa ●●● ▌")
  expect(sw(text(cur))).toBe(SLOT_W)
  expect([cur[0]!.fg, cur.at(-1)!.fg]).toEqual([t.primary, t.primary])
  expect(cur[0]!.bg).toBeUndefined() // the frame sits on the row, not on the specimen
  const mine = boardSlot(t, x, "dark", "current")
  expect(text(mine)).toBe("▕ Aa ●●● ▏")
  expect([mine[0]!.fg, mine.at(-1)!.fg]).toEqual([t.textMuted, t.textMuted])
  expect(text(boardSlot(t, x, "dark", undefined))).toBe("  Aa ●●●  ")
  const none = boardSlot(t, undefined, "light", undefined)
  expect(text(none)).toBe("  light   ")
  expect(none.find((s) => s.text === "light")).toEqual({ text: "light", fg: t.textMuted, attr: A.STRIKE })
  expect(none.every((s) => !s.bg)).toBe(true)
})

test("boardHeader: dark and light centred over their slots, bold, the shown mode in primary", () => {
  const t = themeByName("brothy")
  const L = boardLayout(THEME_LIST_W - 8)
  const h = boardHeader(t, "light", L)
  expect(text(h)).toBe(" ".repeat(12) + "   dark   " + " " + "  light   ")
  expect([...text(h)].indexOf("d")).toBe(L.x[0] + 3)
  expect(h.find((s) => s.text === "light")).toEqual({ text: "light", fg: t.primary, attr: A.BOLD })
  expect(h.find((s) => s.text === "dark")).toEqual({ text: "dark", fg: t.textMuted, attr: A.BOLD })
})

test("listTop keeps the highlight centred inside the list", () => {
  expect(listTop(0, 6, 13)).toBe(0)
  expect(listTop(6, 6, 13)).toBe(3)
  expect(listTop(12, 6, 13)).toBe(7)
  expect(listTop(5, 16, 13)).toBe(0)
})

test("roleWords: every content role in its own colour, shortened to fit", () => {
  const t = themeByName("dracula")
  const full = roleWords(t, 63)
  expect(full.filter((s) => s.text.trim()).map((s) => s.fg)).toEqual([t.text, t.textMuted, t.primary, t.secondary, t.accent, t.error, t.warning, t.success, t.info])
  expect(text(roleWords(t, 63))).toBe("text muted primary secondary accent error warning success info")
  expect(text(roleWords(t, 80))).toBe("text  muted  primary  secondary  accent  error  warning  success  info")
  expect(text(roleWords(t, 57))).toBe("text muted primary second accent error warn success info")
  expect(text(roleWords(t, 20)).split(" ")).toHaveLength(6)
})

test("paneLines: name and text contrast, the role words, then the sample as written and filled code rows", async () => {
  for (const t of [themeByName("brothy"), themeByName("catppuccin-light")]) {
    const view = await highlighted(t, 63)
    const rs = paneLines(t, view, 63, 24)
    expect(rs).toHaveLength(24) // the whole sample fits the 34-row list
    const right = `text ${contrast(t.text, t.background).toFixed(1)}:1`
    expect(text(rs[0]!)).toBe(t.name + " ".repeat(63 - t.name.length - right.length) + right)
    expect(rs[0]!.every((s) => !s.text.trim() || s.fg === t.textMuted)).toBe(true)
    expect(rs[1]).toEqual(roleWords(t, 63))
    expect(rs[2]).toEqual([])
    expect(text(rs[3]!)).toBe("Simmering notes")
    // the opening paragraph keeps its letters
    expect(text(rs[6]!)).toMatch(/^Stock wants patience/)
    // code rows run to the pane's edge on the code fill; the highlighter coloured the line
    const code = rs.find((r) => text(r).includes("let stock"))!
    expect(text(code)).toHaveLength(63)
    expect(code.every((s) => s.bg === t.backgroundElement)).toBe(true)
    expect(new Set(code.map((s) => s.fg)).size).toBeGreaterThan(2)
    expect(rs.some((r) => text(r).includes("│ low   │ reading"))).toBe(true)
  }
  expect(paneLines(brothy, sampleView(brothy, 63), 63, 5)).toHaveLength(5)
  expect(SAMPLE).toContain("==the lid on==")
})

test("pickTop: centred on the highlight until the pointer holds it; keys and typing let go, a mode change keeps it", () => {
  const p = pickStart(themeByName("brothy"))
  expect(pickTop(p, 14, 13, 22)).toBe(listTop(14, 13, 22))
  const held = { ...p, top: 2 }
  expect(pickTop(held, 14, 13, 22)).toBe(2)
  expect(pickTop({ ...p, top: 40 }, 0, 13, 22)).toBe(9) // clamped to the last full window
  expect(pickMove(held, 1).top).toBeNull()
  expect(pickQuery(held, "n").top).toBeNull()
  expect(pickMode(held, "light").top).toBe(2)
})

test("resolveTheme: a theme name, else a family name in its dark theme (light when that is all it has), else nothing", () => {
  expect(resolveTheme("one-light")!.name).toBe("one-light")
  expect(resolveTheme("one")!.name).toBe("one-dark")
  expect(resolveTheme("ayu")!.name).toBe("ayu")
  expect(resolveTheme("vesper")!.name).toBe("vesper")
  const lightOnly = [{ name: "paper", light: themeByName("one-light") }]
  expect(resolveTheme("paper", lightOnly)!.name).toBe("one-light")
  expect(resolveTheme("nope")).toBeUndefined()
  expect(resolveTheme(undefined)).toBeUndefined()
})
