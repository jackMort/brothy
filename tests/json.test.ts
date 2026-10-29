import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { writeFileAtomic as fromConfig } from "../src/config"
import { cacheHome, configHome, isRecord, readJSON, writeFileAtomic } from "../src/json"

const base = mkdtempSync(join(tmpdir(), "brothy-json-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const file = (name: string, text: string) => {
  const f = join(base, name)
  writeFileSync(f, text)
  return f
}

describe("isRecord", () => {
  test("plain objects only", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    for (const v of [null, undefined, [], [1], "s", 1, true, () => 1]) expect(isRecord(v)).toBe(false)
  })
})

describe("readJSON", () => {
  test("a parsed value, whatever its type", () => {
    expect(readJSON(file("obj.json", '{"a":1}'))).toEqual({ kind: "ok", value: { a: 1 } })
    expect(readJSON(file("arr.json", "[1,2]"))).toEqual({ kind: "ok", value: [1, 2] })
    expect(readJSON(file("null.json", "null"))).toEqual({ kind: "ok", value: null })
  })
  test("no file is missing; bad JSON and an unreadable path are invalid", () => {
    expect(readJSON(join(base, "nope.json"))).toEqual({ kind: "missing" })
    expect(readJSON(file("bad.json", "{ nope"))).toEqual({ kind: "invalid" })
    expect(readJSON(base)).toEqual({ kind: "invalid" })
  })
  test("strict: a BOM or a blank file is invalid", () => {
    expect(readJSON(file("bom.json", '﻿{"a":1}'))).toEqual({ kind: "invalid" })
    expect(readJSON(file("blank.json", "  \n"))).toEqual({ kind: "invalid" })
  })
  test("lenient: a BOM is dropped and a blank file is {}; bad JSON is still invalid", () => {
    expect(readJSON(file("bom2.json", '﻿{"a":1}'), { lenient: true })).toEqual({ kind: "ok", value: { a: 1 } })
    expect(readJSON(file("blank2.json", "  \n"), { lenient: true })).toEqual({ kind: "ok", value: {} })
    expect(readJSON(file("bad2.json", "{ nope"), { lenient: true })).toEqual({ kind: "invalid" })
    expect(readJSON(join(base, "nope.json"), { lenient: true })).toEqual({ kind: "missing" })
  })
})

describe("XDG base folders", () => {
  const saved = { config: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME }
  afterEach(() => {
    for (const [k, v] of [["XDG_CONFIG_HOME", saved.config], ["XDG_CACHE_HOME", saved.cache]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  test("an absolute path wins and is read on every call", () => {
    process.env.XDG_CONFIG_HOME = "/x/config"
    process.env.XDG_CACHE_HOME = "/x/cache"
    expect(configHome()).toBe("/x/config")
    expect(cacheHome()).toBe("/x/cache")
    process.env.XDG_CONFIG_HOME = "/y/config"
    expect(configHome()).toBe("/y/config")
  })
  test("relative, empty or unset falls back to the home folder", () => {
    process.env.XDG_CONFIG_HOME = "rel"
    process.env.XDG_CACHE_HOME = ""
    expect(configHome()).toBe(join(homedir(), ".config"))
    expect(cacheHome()).toBe(join(homedir(), ".cache"))
    delete process.env.XDG_CONFIG_HOME
    expect(configHome()).toBe(join(homedir(), ".config"))
  })
})

describe("writeFileAtomic", () => {
  test("creates the folders, gives a new file its mode, keeps an existing file's mode", () => {
    const f = join(base, "deep", "er", "new.json")
    writeFileAtomic(f, "{}\n", 0o600)
    expect(readFileSync(f, "utf8")).toBe("{}\n")
    expect(statSync(f).mode & 0o777).toBe(0o600)
    chmodSync(f, 0o640)
    writeFileAtomic(f, "[]\n", 0o600)
    expect(statSync(f).mode & 0o777).toBe(0o640)
  })
  test("config.ts still exports it", () => expect(fromConfig).toBe(writeFileAtomic))
})
