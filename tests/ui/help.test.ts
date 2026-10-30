import { expect, test } from "bun:test"
import { HELP_COLUMNS, HELP_KEY_W, type HelpGroup, type HelpLine, helpLayout } from "../../src/ui/help"

const g = (title: string, n: number, desc = "does a thing"): HelpGroup => ({
  title,
  entries: Array.from({ length: n }, (_, i) => ({ keys: `k${i}`, desc })),
})
const GROUPS = [g("Global", 20), g("Document", 8), g("Zen", 8), g("Panel", 15), g("AI", 3)]
const chips = (col: HelpLine[]) => col.flatMap((x) => (x?.kind === "chip" ? [x.title] : []))

test("helpLayout: one column below 100 columns, 70 wide, groups in their order with a gap row between", () => {
  const l = helpLayout(GROUPS, 99, 40)
  expect(l.cols).toHaveLength(1)
  expect(l.width).toBe(70)
  expect(l.colW).toBe(60)
  expect(chips(l.cols[0]!)).toEqual(["Global", "Document", "Zen", "Panel", "AI"])
  expect(l.rows).toBe(5 + 54 + 4)
  expect(l.cols[0]![21]).toBeNull()
  expect(l.cols[0]![22]).toEqual({ kind: "chip", title: "Document" })
})

test("helpLayout: two columns from 100 columns: Global and Panel left, Document, AI and Zen right", () => {
  expect(HELP_COLUMNS).toEqual([
    ["Global", "Panel"],
    ["Document", "AI", "Zen"],
  ])
  const l = helpLayout(GROUPS, 120, 34)
  expect(l.width).toBe(112)
  expect(l.colW).toBe(49)
  expect(l.cols.map(chips)).toEqual([
    ["Global", "Panel"],
    ["Document", "AI", "Zen"],
  ])
  expect(l.rows).toBe(21 + 1 + 16)
  expect(l.cols[1]!.length).toBe(9 + 1 + 4 + 1 + 9)
  const narrow = helpLayout(GROUPS, 100, 30)
  expect(narrow.cols).toHaveLength(2)
  expect(narrow.width).toBe(92)
  expect(narrow.colW).toBe(39)
  // a narrow column shrinks the key padding (to 9 cells at most 7 off) before the descriptions
  expect([l.keyW, narrow.keyW, helpLayout(GROUPS, 99, 40).keyW]).toEqual([HELP_KEY_W, 9, HELP_KEY_W])
})

test("helpLayout: a group no column names goes to the shorter one; an empty group is left out", () => {
  const l = helpLayout([...GROUPS, g("Extra", 2), g("Empty", 0)], 120, 34)
  expect(l.cols.map(chips)).toEqual([
    ["Global", "Panel"],
    ["Document", "AI", "Zen", "Extra"],
  ])
  expect(chips(helpLayout([g("Global", 1), g("Empty", 0)], 99, 34).cols[0]!)).toEqual(["Global"])
})

test("helpLayout: the wordmark only when the height can spare it; vis fits the popup and never exceeds rows", () => {
  const l = helpLayout(GROUPS, 120, 34)
  expect(l.mark).toBe(true)
  expect(l.vis).toBe(24) // 34 − footer 2 − padding 2 − title and gap 2 − wordmark and gap 4
  expect(helpLayout(GROUPS, 120, 12).mark).toBe(false)
  const small = helpLayout(GROUPS, 120, 9)
  expect(small.vis).toBeGreaterThanOrEqual(3)
  const short = helpLayout([g("Global", 2)], 120, 40)
  expect(short.vis).toBe(short.rows)
})

test("helpLayout: a long description wraps under the description column, keys only on its first row", () => {
  const long = "gloss: explain the section you're reading (AI) · again: more / less"
  const l = helpLayout([{ title: "Zen", entries: [{ keys: "a", desc: long }] }], 99, 40)
  const rows = l.cols[0]!.slice(1)
  expect(rows.length).toBeGreaterThan(1)
  expect(rows[0]).toMatchObject({ kind: "key", keys: "a" })
  for (const r of rows.slice(1)) expect(r).toMatchObject({ kind: "key", keys: "" })
  const descs = rows.map((r) => (r?.kind === "key" ? r.desc : ""))
  expect(descs.join(" ")).toBe(long)
  for (const d of descs) expect(Bun.stringWidth(d)).toBeLessThanOrEqual(l.colW - l.keyW)
})
