import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { configPath, loadConfig, saveConfig } from "../src/config"
import { ZEN_DEFAULTS } from "../src/zen"

const base = mkdtempSync(join(tmpdir(), "brothy-cfg-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const saved = process.env.XDG_CONFIG_HOME
let xdg: string
let n = 0
beforeEach(() => {
  xdg = join(base, String(n++))
  mkdirSync(join(xdg, "brothy"), { recursive: true })
  process.env.XDG_CONFIG_HOME = xdg
})
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = saved
})
const file = () => join(xdg, "brothy", "config.json")

describe("path", () => {
  test("honors an absolute XDG_CONFIG_HOME, resolved at call time", () => {
    expect(configPath()).toBe(file())
  })
  test("ignores a relative XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "relative/dir"
    expect(configPath()).toBe(join(homedir(), ".config", "brothy", "config.json"))
  })
  test("empty XDG_CONFIG_HOME falls back to ~/.config", () => {
    process.env.XDG_CONFIG_HOME = ""
    expect(configPath()).toBe(join(homedir(), ".config", "brothy", "config.json"))
  })
})

describe("loadConfig", () => {
  test("missing file is empty", () => expect(loadConfig()).toEqual({}))
  test("reads the theme", () => {
    writeFileSync(file(), '{"theme":"nord"}')
    expect(loadConfig()).toEqual({ theme: "nord" })
  })
  for (const bad of ["null", "[]", "42", '"str"', "{oops"]) {
    test(`tolerates ${bad}`, () => {
      writeFileSync(file(), bad)
      expect(loadConfig()).toEqual({})
    })
  }
  test("drops a non-string theme", () => {
    writeFileSync(file(), '{"theme":5}')
    expect(loadConfig().theme).toBeUndefined()
  })
})

describe("legacy folds", () => {
  test("are no longer returned, only migrated", () => {
    writeFileSync(file(), '{"folds":{"files":false,"outline":true,"info":true}}')
    expect(loadConfig()).toEqual({ sidebar: { view: "outline", hidden: false } })
  })
  test("saving the sidebar drops the legacy key and keeps the rest", () => {
    writeFileSync(file(), '{"theme":"nord","folds":{"files":false}}')
    saveConfig({ sidebar: { view: "outline", hidden: false }, folds: undefined })
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ theme: "nord", sidebar: { view: "outline", hidden: false } })
  })
  test("an unparsable file is still left alone", () => {
    writeFileSync(file(), "{oops")
    saveConfig({ sidebar: { view: "info", hidden: true }, folds: undefined })
    expect(readFileSync(file(), "utf8")).toBe("{oops")
  })
})

describe("sidebar", () => {
  test("loads view and hidden, field by field", () => {
    writeFileSync(file(), '{"sidebar":{"view":"outline","hidden":true}}')
    expect(loadConfig().sidebar).toEqual({ view: "outline", hidden: true })
    writeFileSync(file(), '{"sidebar":{"view":"tags","hidden":true}}')
    expect(loadConfig().sidebar).toEqual({ hidden: true })
  })
  for (const bad of ['{"sidebar":null}', '{"sidebar":[1]}', '{"sidebar":"files"}', '{"sidebar":{}}', '{"sidebar":{"view":3,"hidden":"no"}}']) {
    test(`ignores ${bad}`, () => {
      writeFileSync(file(), bad)
      expect(loadConfig().sidebar).toBeUndefined()
    })
  }
  const legacy: [string, object][] = [
    ['{"files":true,"outline":true,"info":false}', { view: "files", hidden: false }],
    ['{"files":false,"outline":true,"info":true}', { view: "outline", hidden: false }],
    ['{"files":false,"outline":false,"info":true}', { view: "info", hidden: false }],
    ['{"files":false,"outline":false,"info":false}', { hidden: true }],
    ['{"files":false}', { view: "outline", hidden: false }], // missing folds take the old defaults
  ]
  for (const [folds, want] of legacy) {
    test(`migrates legacy folds ${folds}`, () => {
      writeFileSync(file(), `{"folds":${folds}}`)
      expect(loadConfig().sidebar).toEqual(want)
    })
  }
  test("a present but invalid sidebar is not replaced by migrated folds", () => {
    writeFileSync(file(), '{"sidebar":5,"folds":{"files":false,"outline":false,"info":true}}')
    expect(loadConfig().sidebar).toBeUndefined()
  })
})

describe("saveConfig", () => {
  test("creates the file", () => {
    saveConfig({ theme: "brothy" })
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ theme: "brothy" })
  })
  test("keeps unknown keys", () => {
    writeFileSync(file(), '{"other":1,"theme":"a"}')
    saveConfig({ theme: "b" })
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ other: 1, theme: "b" })
  })
  for (const bad of ["{oops", "null", "[1]"]) {
    test(`does not overwrite an invalid config (${bad})`, () => {
      writeFileSync(file(), bad)
      saveConfig({ theme: "b" })
      expect(readFileSync(file(), "utf8")).toBe(bad)
    })
  }
})

describe("transparent", () => {
  test("loads a boolean, ignores other types", () => {
    writeFileSync(file(), '{"transparent":true}')
    expect(loadConfig().transparent).toBe(true)
    for (const bad of ['{"transparent":"yes"}', '{"transparent":1}', '{"transparent":null}']) {
      writeFileSync(file(), bad)
      expect(loadConfig().transparent).toBeUndefined()
    }
  })
  test("saving keeps the other keys", () => {
    saveConfig({ wide: true })
    saveConfig({ transparent: true })
    expect(loadConfig()).toMatchObject({ wide: true, transparent: true })
  })
})

describe("wide", () => {
  test("loads a boolean, ignores other types", () => {
    writeFileSync(file(), '{"wide":true}')
    expect(loadConfig().wide).toBe(true)
    for (const bad of ['{"wide":"yes"}', '{"wide":1}', '{"wide":null}']) {
      writeFileSync(file(), bad)
      expect(loadConfig().wide).toBeUndefined()
    }
  })
  test("saving wide keeps the other keys", () => {
    saveConfig({ theme: "brothy" })
    saveConfig({ wide: true })
    expect(loadConfig()).toEqual({ theme: "brothy", wide: true })
  })
  test('zen measure accepts "full", other strings fall back field-wise', () => {
    writeFileSync(file(), '{"zen":{"measure":"full","ghost":false}}')
    expect(loadConfig().zen).toEqual({ measure: "full", ghost: false })
    writeFileSync(file(), '{"zen":{"measure":"huge","ghost":false}}')
    expect(loadConfig().zen).toEqual({ ghost: false })
  })
})

describe("zen", () => {
  test("loads valid zen fields", () => {
    writeFileSync(file(), '{"zen":{"flow":"pages","measure":80,"ghost":false}}')
    expect(loadConfig().zen).toEqual({ flow: "pages", measure: 80, ghost: false })
  })
  test("drops invalid fields and clamps numbers, keeps the rest", () => {
    writeFileSync(file(), '{"zen":{"flow":"spiral","wpm":9999,"spotlight":"no","bogus":1}}')
    expect(loadConfig().zen).toEqual({ wpm: 400 })
  })
  for (const bad of ['{"zen":null}', '{"zen":[1]}', '{"zen":"pages"}', '{"zen":{}}', '{"zen":{"flow":3}}']) {
    test(`tolerates ${bad}`, () => {
      writeFileSync(file(), bad)
      expect(loadConfig().zen).toBeUndefined()
    })
  }
  test("saving zen keeps the theme and sidebar", () => {
    saveConfig({ theme: "brothy", sidebar: { view: "info", hidden: false } })
    saveConfig({ zen: { ...ZEN_DEFAULTS, measure: 64 } })
    expect(loadConfig()).toEqual({
      theme: "brothy",
      sidebar: { view: "info", hidden: false },
      zen: { ...ZEN_DEFAULTS, measure: 64 },
    })
  })
  test("never overwrites an invalid config", () => {
    writeFileSync(file(), "{oops")
    saveConfig({ zen: ZEN_DEFAULTS })
    expect(readFileSync(file(), "utf8")).toBe("{oops")
  })
})

describe("saveConfig file handling", () => {
  test("a symlinked config stays a symlink and its target is updated", () => {
    const real = join(base, `real-${n}.json`)
    writeFileSync(real, '{"theme":"old"}')
    symlinkSync(real, file())
    expect(saveConfig({ wide: true })).toBe(true)
    expect(lstatSync(file()).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ theme: "old", wide: true })
  })
  test("keeps the file mode", () => {
    writeFileSync(file(), "{}")
    chmodSync(file(), 0o600)
    saveConfig({ wide: true })
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })
  for (const [name, text] of [["empty", ""], ["whitespace", " \n\t"], ["BOM", '\uFEFF{"theme":"old"}']] as const) {
    test(`${name} file is saved over, not refused`, () => {
      writeFileSync(file(), text)
      expect(saveConfig({ wide: true })).toBe(true)
      expect(JSON.parse(readFileSync(file(), "utf8")).wide).toBe(true)
    })
  }
  test("BOM file still loads", () => {
    writeFileSync(file(), '\uFEFF{"theme":"old"}')
    expect(loadConfig().theme).toBe("old")
  })
  test("returns false when it refuses an invalid file", () => {
    writeFileSync(file(), "{oops")
    expect(saveConfig({ wide: true })).toBe(false)
  })
  test("merges sidebar and zen one level deep", () => {
    writeFileSync(file(), '{"sidebar":{"view":"info","hidden":false},"zen":{"wpm":200,"flow":"pages"}}')
    saveConfig({ sidebar: { hidden: true } })
    saveConfig({ zen: { wpm: 300 } })
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      sidebar: { view: "info", hidden: true },
      zen: { wpm: 300, flow: "pages" },
    })
  })
})
