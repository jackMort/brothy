import { expect, test } from "bun:test"
import { HISTORY_CAP, drop, go, keep, startHistory, stepTo, visit, type History } from "../src/history"

const paths = (h: History<number>) => h.entries.map((e) => e.path)

test("starts on the open note, or empty without one", () => {
  expect(startHistory<number>("a")).toEqual({ entries: [{ path: "a", pos: null, peek: false }], at: 0 })
  expect(startHistory<number>(null)).toEqual({ entries: [], at: -1 })
  expect(paths(visit(startHistory<number>(null), "a", 0))).toEqual(["a"])
})

test("a visit pushes the note and records where the old one was left", () => {
  const h = visit(startHistory<number>("a"), "b", 7)
  expect(paths(h)).toEqual(["a", "b"])
  expect(h.at).toBe(1)
  expect(h.entries[0]!.pos).toBe(7)
  expect(h.entries[1]!.pos).toBeNull()
})

test("stepTo gives the neighbour index, null at either end", () => {
  const h = visit(visit(startHistory<number>("a"), "b", 0), "c", 0)
  expect(stepTo(h, -1)).toBe(1)
  expect(stepTo(h, 1)).toBeNull()
  expect(stepTo(go(h, 0, 0), -1)).toBeNull()
  expect(stepTo(go(h, 0, 0), 1)).toBe(1)
  expect(stepTo(startHistory<number>(null), -1)).toBeNull()
})

test("go moves to an entry and records the position being left", () => {
  const h = go(visit(startHistory<number>("a"), "b", 3), 0, 9)
  expect(h.at).toBe(0)
  expect(h.entries[0]!.pos).toBe(3) // its own remembered top, untouched
  expect(h.entries[1]!.pos).toBe(9)
  expect(go(h, 1, 4).entries[0]!.pos).toBe(4)
})

test("a new visit after going back truncates the forward part", () => {
  const h = visit(go(visit(visit(startHistory<number>("a"), "b", 0), "c", 0), 0, 0), "d", 5)
  expect(paths(h)).toEqual(["a", "d"])
  expect(h.at).toBe(1)
  expect(h.entries[0]!.pos).toBe(5)
})

test("no consecutive duplicates: visiting the current note changes nothing", () => {
  const h = visit(startHistory<number>("a"), "b", 0)
  expect(visit(h, "b", 3)).toBe(h)
})

test("the cap drops the oldest entries", () => {
  let h = startHistory<number>("n0")
  for (let i = 1; i <= HISTORY_CAP + 5; i++) h = visit(h, `n${i}`, i)
  expect(h.entries.length).toBe(HISTORY_CAP)
  expect(h.entries[0]!.path).toBe("n6")
  expect(h.at).toBe(HISTORY_CAP - 1)
  expect(h.entries.at(-1)!.path).toBe(`n${HISTORY_CAP + 5}`)
})

test("a run of previews replaces itself instead of piling up", () => {
  let h = startHistory<number>("a")
  h = visit(h, "b", 2, true)
  h = visit(h, "c", 0, true)
  h = visit(h, "d", 0, true)
  expect(paths(h)).toEqual(["a", "d"])
  expect(h.entries[0]!.pos).toBe(2)
  expect(h.entries[1]!.peek).toBe(true)
  // a non-preview open also replaces a preview
  expect(paths(visit(h, "e", 0))).toEqual(["a", "e"])
})

test("a previewed note that got focus stays", () => {
  const h = visit(keep(visit(startHistory<number>("a"), "b", 0, true)), "c", 1, true)
  expect(paths(h)).toEqual(["a", "b", "c"])
  expect(h.entries[1]!.pos).toBe(1)
  expect(h.entries[1]!.peek).toBe(false)
})

test("keep returns the same history when nothing changes", () => {
  const h = startHistory<number>("a")
  expect(keep(h)).toBe(h)
  expect(keep(startHistory<number>(null))).toEqual({ entries: [], at: -1 })
})

test("previewing back to the note before collapses instead of duplicating", () => {
  const h = visit(visit(startHistory<number>("a"), "b", 4, true), "a", 0, true)
  expect(paths(h)).toEqual(["a"])
  expect(h.at).toBe(0)
  expect(h.entries[0]!.pos).toBe(4)
})

test("drop removes an entry and keeps at on the same note", () => {
  const h = visit(visit(startHistory<number>("a"), "b", 0), "c", 0) // at c
  const d = drop(h, 1)
  expect(paths(d)).toEqual(["a", "c"])
  expect(d.at).toBe(1)
  expect(drop(go(h, 0, 0), 2).at).toBe(0)
})

test("drop merges neighbours that become duplicates", () => {
  const h = visit(visit(startHistory<number>("a"), "b", 0), "a", 0) // a b a, at 2
  const d = drop(h, 1)
  expect(paths(d)).toEqual(["a"])
  expect(d.at).toBe(0)
})
