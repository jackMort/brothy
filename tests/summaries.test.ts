import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PROMPT_V } from "../src/ai"
import { CACHE_CAP, GLOSS_CAP, loadGlosses, saveGlosses, type Gloss, cacheFile, cachePath, isFresh, loadCache, loadSummaries, pruneSummaries, saveCache, saveSummaries, textHash, type Summary } from "../src/summaries"

const base = mkdtempSync(join(tmpdir(), "brothy-cache-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const saved = process.env.XDG_CACHE_HOME
let n = 0
beforeEach(() => void (process.env.XDG_CACHE_HOME = join(base, String(n++))))
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = saved
})
const entry = (at: number, over: Partial<Summary> = {}): Summary => ({ hash: "h", v: PROMPT_V, summary: "s", model: "m", at, ...over })

describe("path", () => {
  test("absolute XDG_CACHE_HOME, resolved per call", () => expect(cachePath()).toBe(join(process.env.XDG_CACHE_HOME!, "brothy", "summaries.json")))
  test("relative XDG_CACHE_HOME is ignored", () => {
    process.env.XDG_CACHE_HOME = "rel"
    expect(cachePath()).toBe(join(homedir(), ".cache", "brothy", "summaries.json"))
  })
})

describe("load / save", () => {
  test("missing or corrupt file is empty; bad entries are skipped", () => {
    expect(loadSummaries()).toEqual({})
    mkdirSync(dirname(cachePath()), { recursive: true })
    writeFileSync(cachePath(), "{not json")
    expect(loadSummaries()).toEqual({})
    writeFileSync(cachePath(), JSON.stringify({ "/a.md": entry(1), "rel.md": entry(2), "/b.md": { hash: 1 } }))
    expect(loadSummaries()).toEqual({ "/a.md": entry(1) })
  })
  test("a new file is 0600 in a 0700 folder", () => {
    expect(saveSummaries({ "/a.md": entry(1) })).toBe(true)
    expect(statSync(cachePath()).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(cachePath())).mode & 0o777).toBe(0o700)
    expect(loadSummaries()).toEqual({ "/a.md": entry(1) })
  })
  test("save merges with what another instance wrote; newest at wins per path", () => {
    saveSummaries({ "/a.md": entry(5) })
    writeFileSync(cachePath(), JSON.stringify({ ...JSON.parse(readFileSync(cachePath(), "utf8")), "/other.md": entry(6) })) // the other instance
    saveSummaries({ "/b.md": entry(7), "/a.md": entry(4, { summary: "older" }) })
    expect(loadSummaries()).toEqual({ "/a.md": entry(5), "/other.md": entry(6), "/b.md": entry(7) })
  })
  test("a corrupt file is replaced on save", () => {
    mkdirSync(dirname(cachePath()), { recursive: true })
    writeFileSync(cachePath(), "garbage")
    expect(saveSummaries({ "/a.md": entry(1) })).toBe(true)
    expect(loadSummaries()).toEqual({ "/a.md": entry(1) })
  })
  test.skipIf(process.getuid?.() === 0)("an unwritable folder returns false, no throw", () => {
    mkdirSync(dirname(cachePath()), { recursive: true })
    chmodSync(dirname(cachePath()), 0o500)
    try {
      expect(saveSummaries({ "/a.md": entry(1) })).toBe(false)
    } finally {
      chmodSync(dirname(cachePath()), 0o700)
    }
  })
})

describe("prune / freshness", () => {
  test("keeps the newest CACHE_CAP by at", () => {
    const all = Object.fromEntries(Array.from({ length: CACHE_CAP + 3 }, (_, i) => [`/n${i}.md`, entry(i)]))
    const kept = pruneSummaries(all)
    expect(Object.keys(kept).length).toBe(CACHE_CAP)
    expect(kept["/n0.md"]).toBeUndefined()
    expect(kept[`/n${CACHE_CAP + 2}.md`]).toBeDefined()
  })
  test("fresh needs the same hash and PROMPT_V; the model doesn't matter", () => {
    const h = textHash("body")
    expect(textHash("body")).toBe(h)
    expect(textHash("body!")).not.toBe(h)
    expect(isFresh(entry(1, { hash: h, model: "other/model" }), h)).toBe(true)
    expect(isFresh(entry(1, { hash: h, v: PROMPT_V + 1 }), h)).toBe(false)
    expect(isFresh(entry(1, { hash: "x" }), h)).toBe(false)
  })
})

describe("generic store", () => {
  type G = { hash: string; v: number; gloss: string; model: string; at: number }
  const isG = (e: unknown): e is G => !!e && typeof e === "object" && typeof (e as G).gloss === "string" && Number.isFinite((e as G).at)
  const g = (at: number, gloss = "g"): G => ({ hash: "h", v: 1, gloss, model: "m", at })
  const K = "/v/a.md#why#0#explain"

  test("two names don't mix: each lives in its own file", () => {
    expect(saveCache("glosses", { [K]: g(1) }, 10, isG)).toBe(true)
    expect(saveSummaries({ "/v/a.md": entry(2) })).toBe(true)
    expect(cacheFile("glosses")).toBe(join(process.env.XDG_CACHE_HOME!, "brothy", "glosses.json"))
    expect(cacheFile("summaries")).toBe(cachePath())
    expect(loadCache("glosses", isG)).toEqual({ [K]: g(1) })
    expect(loadSummaries()).toEqual({ "/v/a.md": entry(2) })
  })
  test("cap per call keeps the newest at; merge with the file, newest wins per key", () => {
    saveCache("glosses", { "/a#x#0#explain": g(1), "/b#x#0#explain": g(2) }, 10, isG)
    saveCache("glosses", { "/c#x#0#explain": g(3), "/a#x#0#explain": g(0, "older") }, 2, isG)
    expect(loadCache("glosses", isG)).toEqual({ "/b#x#0#explain": g(2), "/c#x#0#explain": g(3) })
  })
  test("modes: folder 0700, new file 0600", () => {
    saveCache("glosses", { [K]: g(1) }, 10, isG)
    expect(statSync(cacheFile("glosses")).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(cacheFile("glosses"))).mode & 0o777).toBe(0o700)
  })
  test("entries the predicate rejects and relative keys are dropped on load and on save", () => {
    mkdirSync(dirname(cacheFile("glosses")), { recursive: true })
    writeFileSync(cacheFile("glosses"), JSON.stringify({ [K]: g(1), "rel#x#0#explain": g(2), "/bad": { gloss: 3 } }))
    expect(loadCache("glosses", isG)).toEqual({ [K]: g(1) })
    saveCache("glosses", { "/new#x#0#explain": g(4) }, 10, isG)
    expect(Object.keys(JSON.parse(readFileSync(cacheFile("glosses"), "utf8"))).sort()).toEqual(["/new#x#0#explain", K])
  })
})

test("a summaries.json in today's format still loads, and its entries stay fresh", () => {
  const h = textHash("# A\n\nApples.")
  mkdirSync(dirname(cachePath()), { recursive: true })
  writeFileSync(cachePath(), JSON.stringify({ "/v/a.md": { hash: h, v: 1, summary: "About apples.", model: "llama3.2", at: 1 } }) + "\n")
  const e = loadSummaries()["/v/a.md"]!
  expect(e.summary).toBe("About apples.")
  expect(isFresh(e, h)).toBe(true)
})

test("isFresh takes the prompt version (PROMPT_V by default)", () => {
  expect(isFresh(entry(1, { hash: "h", v: 2 }), "h", 2)).toBe(true)
  expect(isFresh(entry(1, { hash: "h", v: 1 }), "h", 2)).toBe(false)
  expect(isFresh(entry(1, { hash: "h" }), "h")).toBe(true)
})

const gl = (gloss: string, at: number): Gloss => ({ hash: "h", v: 1, gloss, model: "m", at })
const K = "/n/a.md#apples#0#explain"

test("glosses: save then load; a separate file from summaries.json", () => {
  expect(saveGlosses({ [K]: gl("About apples.", 1) })).toBe(true)
  expect(loadGlosses()).toEqual({ [K]: gl("About apples.", 1) })
  expect(existsSync(join(process.env.XDG_CACHE_HOME!, "brothy", "glosses.json"))).toBe(true)
  expect(loadSummaries()[K]).toBeUndefined()
})

test("glosses: merge on save keeps the newest per key and other keys", () => {
  saveGlosses({ [K]: gl("new", 5), "/n/b.md#x#0#explain": gl("b", 2) })
  saveGlosses({ [K]: gl("old", 3) })
  expect(loadGlosses()[K]!.gloss).toBe("new")
  expect(loadGlosses()["/n/b.md#x#0#explain"]!.gloss).toBe("b")
})

test("glosses: pruned to the newest GLOSS_CAP", () => {
  const add = Object.fromEntries(Array.from({ length: GLOSS_CAP + 5 }, (_, i) => [`/n/a.md#h${i}#0#explain`, gl("g", i)]))
  saveGlosses(add)
  const all = loadGlosses()
  expect(Object.keys(all).length).toBe(GLOSS_CAP)
  expect(all["/n/a.md#h0#0#explain"]).toBeUndefined()
  expect(all[`/n/a.md#h${GLOSS_CAP + 4}#0#explain`]).toBeDefined()
})

test("glosses: entries of the wrong shape are skipped; a corrupt file is empty", () => {
  mkdirSync(join(process.env.XDG_CACHE_HOME!, "brothy"), { recursive: true })
  writeFileSync(join(process.env.XDG_CACHE_HOME!, "brothy", "glosses.json"), JSON.stringify({ [K]: { hash: "h", v: 1, summary: "x", model: "m", at: 1 } }))
  expect(loadGlosses()).toEqual({})
  writeFileSync(join(process.env.XDG_CACHE_HOME!, "brothy", "glosses.json"), "{ nope")
  expect(loadGlosses()).toEqual({})
})

test("glosses: file 0600, folder 0700", () => {
  rmSync(join(process.env.XDG_CACHE_HOME!, "brothy"), { recursive: true, force: true })
  saveGlosses({ [K]: gl("g", 1) })
  expect(statSync(join(process.env.XDG_CACHE_HOME!, "brothy")).mode & 0o777).toBe(0o700)
  expect(statSync(join(process.env.XDG_CACHE_HOME!, "brothy", "glosses.json")).mode & 0o777).toBe(0o600)
})

test("summaries.json and glosses.json: compact JSON with a newline, the fields as stored, and a stored file reads back", () => {
  const sum = { hash: "h", v: 1, summary: "s", model: "m", at: 1 }
  saveSummaries({ "/a.md": sum })
  expect(readFileSync(cachePath(), "utf8")).toBe(JSON.stringify({ "/a.md": sum }) + "\n")
  const g = { hash: "h", v: 1, gloss: "g", model: "m", at: 2 }
  saveGlosses({ [K]: g })
  const file = join(process.env.XDG_CACHE_HOME!, "brothy", "glosses.json")
  expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ [K]: g }) + "\n")
  writeFileSync(cachePath(), JSON.stringify({ "/b.md": sum }))
  expect(loadSummaries()).toEqual({ "/b.md": sum })
  expect(loadGlosses()).toEqual({ [K]: g })
})

test("a summary and a gloss are told apart by their own text field", () => {
  mkdirSync(join(process.env.XDG_CACHE_HOME!, "brothy"), { recursive: true })
  const both = { "/a.md": { hash: "h", v: 1, summary: "s", gloss: "g", model: "m", at: 1 }, "/b.md": { hash: "h", v: 1, summary: "s", model: "m", at: 1, extra: true } }
  writeFileSync(cachePath(), JSON.stringify(both))
  expect(Object.keys(loadSummaries())).toEqual(["/a.md", "/b.md"])
  writeFileSync(join(process.env.XDG_CACHE_HOME!, "brothy", "glosses.json"), JSON.stringify(both))
  expect(Object.keys(loadGlosses())).toEqual(["/a.md"])
  writeFileSync(cachePath(), JSON.stringify({ "/c.md": { hash: "h", v: 1, summary: "s", model: "m", at: "1" }, "/d.md": { hash: "h", v: 1, summary: "s", model: "m", at: null } }))
  expect(loadSummaries()).toEqual({})
})
