import { expect, test } from "bun:test"
import { createTerminalCapabilities } from "@opentui/core/testing"
import { egoGraph } from "../../src/graph/ego"
import { buildLinks } from "../../src/graph/links"
import {
  firstStop,
  type GraphRow,
  graphFoot,
  graphHead,
  graphMode,
  graphNote,
  graphRowSpans,
  graphRows,
  graphTerm,
  isGraphStop,
  nextStop,
  sheetGeo,
} from "../../src/graph/sheet"
import { A } from "../../src/lib/spans"
import { spanWidth } from "../../src/lib/text"
import { brothy as t } from "../helpers/theme"
import { hubVault, KITCHEN, vaultOf } from "../helpers/vault"

const { ix, tree } = vaultOf(KITCHEN)
const g = buildLinks(ix, tree)
const ego = egoGraph(g, "/v/Broth.md", 2)
const show = (r: GraphRow) => {
  if (r.kind === "node") return `${r.depth === 2 ? "  " : ""}${r.arrow} ${r.name}`
  return r.kind === "more" ? `+${r.n}` : r.text
}

test("graphRows: each neighbour with the depth-2 notes it brought in under it, then the unresolved", () => {
  expect(graphRows(ego, "", false).map(show)).toEqual(["↔ Stock", "  → Bones", "← Garnish", "→ Simmering", "→ Nowhere"])
})

test("graphRows: an orphan says so; the filter keeps what matches; nothing matching says so", () => {
  expect(graphRows(egoGraph(g, "/v/Lonely.md", 2), "", false).map(show)).toEqual(["no links to or from this note"])
  expect(graphRows(ego, "sim", false).map(show)).toEqual(["→ Simmering"])
  expect(graphRows(ego, "zz", false).map(show)).toEqual(["no match"])
})

test("graphRows: past the cap `+ n more`; open, the rest listed before it with no picture index", () => {
  const hub = hubVault()
  const e = egoGraph(buildLinks(hub.ix, hub.tree), "/v/Hub.md", 1)
  expect(graphRows(e, "", false).at(-1)).toEqual({ kind: "more", n: 7, open: false })
  const open = graphRows(e, "", true)
  expect(open.at(-1)).toEqual({ kind: "more", n: 7, open: true })
  expect(open.at(-2)).toMatchObject({ kind: "node", name: "n24", i: null })
})

test("stops: unresolved rows and notes are passed over; the ends hold", () => {
  const rows = graphRows(ego, "", false)
  expect(rows.map(isGraphStop)).toEqual([true, true, true, true, false])
  expect(nextStop(rows, 3, 1)).toBe(3)
  expect(nextStop(rows, 0, -1)).toBe(0)
  expect(nextStop(rows, 1, 1)).toBe(2)
  expect(firstStop([{ kind: "note", text: "x" }])).toBe(0)
  expect(isGraphStop(undefined)).toBe(false)
})

test("graphNote and graphFoot", () => {
  expect(graphNote(ego, 2)).toBe("← 2 · → 2 · 1 unresolved · depth 2")
  expect(graphNote(egoGraph(g, "/v/Lonely.md", 1), 1)).toBe("← 0 · → 0 · depth 1")
  expect(graphFoot(ego, 2, 6, null)).toBe("depth 2 · 5 of 6 notes")
  expect(graphFoot(egoGraph(g, "/v/Lonely.md", 2), 2, 6, null)).toBe("depth 2 · 1 of 6 notes")
  expect(graphFoot(ego, 2, 6, [25, 900])).toBe("▍ indexing notes · 25 of 900")
})

test("graphHead: the title row fits beside esc: the note drops unresolved, then the counts, then itself; the title is cut last", () => {
  expect(graphHead("Broth", ego, 2, 108)).toEqual({
    title: "Graph · Broth",
    note: "← 2 · → 2 · 1 unresolved · depth 2",
  })
  expect(graphHead("Broth", ego, 2, 58)).toEqual({ title: "Graph · Broth", note: "← 2 · → 2 · depth 2" })
  expect(graphHead("Broth", ego, 2, 40)).toEqual({ title: "Graph · Broth", note: "depth 2" })
  expect(graphHead("Broth", ego, 2, 28)).toEqual({ title: "Graph · Broth", note: "" })
  const long = graphHead("A very long note name indeed", ego, 2, 30)
  expect(long).toEqual({ title: "Graph · A very…", note: "" })
})

test("graphRowSpans: the bar and the element background across a focused row; unresolved muted and struck; never wider than the room", () => {
  const rows = graphRows(ego, "", false)
  const sel = graphRowSpans(rows[0]!, t, 30, true)
  expect(spanWidth(sel)).toBe(30)
  expect(sel[0]).toMatchObject({ text: "▌", fg: t.primary })
  expect(sel.every((s) => s.bg === t.backgroundElement)).toBe(true)
  const gone = graphRowSpans(rows[4]!, t, 30, false)
  expect(gone.find((s) => s.text.includes("Nowhere"))).toMatchObject({ fg: t.textMuted, attr: A.STRIKE })
  const wide: GraphRow = {
    kind: "node",
    path: "/v/x.md",
    i: 1,
    name: "鍋".repeat(40),
    arrow: "→",
    dir: "out",
    depth: 1,
  }
  expect(spanWidth(graphRowSpans(wide, t, 20, true))).toBe(20)
  expect(spanWidth(graphRowSpans({ kind: "more", n: 12, open: false }, t, 30, false))).toBeLessThanOrEqual(30)
})

test("sheetGeo: picture │ list from 100 columns, else the picture and one row; positive at 60×14", () => {
  expect(sheetGeo(120, 34)).toEqual({ width: 108, height: 28, split: true, cols: 71, rows: 28, listW: 34, listH: 26 })
  expect(sheetGeo(80, 24)).toEqual({ width: 78, height: 18, split: false, cols: 76, rows: 17, listW: 0, listH: 0 })
  expect(sheetGeo(60, 14)).toMatchObject({ split: false, cols: 56, rows: 7 })
})

test("graphTerm: pixels where OpenTUI would draw kitty or sixel (not under tmux); a multiplexer or remote noted", () => {
  const plain = graphTerm(createTerminalCapabilities(), null, 100, 30)
  expect(plain).toEqual({ pixels: false, mux: false, cellW: 8, cellH: 16 })
  const kitty = graphTerm(createTerminalCapabilities({ kitty_graphics: true }), { width: 900, height: 600 }, 100, 30)
  expect(kitty).toEqual({ pixels: true, mux: false, cellW: 9, cellH: 20 })
  expect(
    graphTerm(createTerminalCapabilities({ kitty_graphics: true, multiplexer: "tmux" }), null, 100, 30).pixels,
  ).toBe(false)
  expect(
    graphTerm(createTerminalCapabilities({ kitty_graphics: true, multiplexer: "zellij" }), null, 100, 30).mux,
  ).toBe(true)
  expect(graphTerm(null, null, 100, 30).pixels).toBe(false)
  expect([graphMode("auto", kitty, false), graphMode("pixels", kitty, false)]).toEqual(["pixels", "pixels"])
  expect([
    graphMode("braille", kitty, false),
    graphMode("auto", kitty, true),
    graphMode("pixels", plain, false),
  ]).toEqual(["braille", "braille", "braille"])
})

test("graphRowSpans: no row passes its column at any room, wide names and emoji included; sheetGeo is positive from 60×14", () => {
  const names = ["鍋".repeat(9), "🍜 soup 🍲🍲🍲", "a-very-long-note-name-indeed"]
  for (const name of names)
    for (const depth of [1, 2] as const)
      for (let room = 2; room <= 40; room++)
        for (const sel of [true, false]) {
          const r: GraphRow = { kind: "node", path: "/v/x.md", i: 1, name, arrow: "↔", dir: "both", depth }
          expect(spanWidth(graphRowSpans(r, t, room, sel))).toBeLessThanOrEqual(room)
        }
  for (const [W, H] of [
    [60, 14],
    [99, 14],
    [100, 14],
    [140, 50],
  ] as const) {
    const g = sheetGeo(W, H)
    expect(Math.min(g.width, g.height, g.cols, g.rows)).toBeGreaterThan(0)
    expect(g.split ? Math.min(g.listW, g.listH) : 1).toBeGreaterThan(0)
  }
})
