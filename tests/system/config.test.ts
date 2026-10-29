import { beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeFileAtomic } from "../../src/lib/json"
import { configPath, loadConfig, saveConfig } from "../../src/system/config"
import { ZEN_DEFAULTS } from "../../src/ui/zen"
import { useXdgDir } from "../helpers/env"

const xdg = useXdgDir("XDG_CONFIG_HOME")
beforeEach(() => mkdirSync(join(xdg(), "brothy"), { recursive: true }))
const file = () => join(xdg(), "brothy", "config.json")

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

describe("headings", () => {
  test("loads a known style, drops anything else", () => {
    for (const h of ["classic", "bars", "ladder", "rules"] as const) {
      writeFileSync(file(), JSON.stringify({ headings: h }))
      expect(loadConfig().headings).toBe(h)
    }
    for (const bad of ['{"headings":"fancy"}', '{"headings":1}', '{"headings":null}', '{"headings":true}']) {
      writeFileSync(file(), bad)
      expect(loadConfig().headings).toBeUndefined()
    }
  })
  test("saving headings keeps the other keys", () => {
    saveConfig({ theme: "brothy" })
    saveConfig({ headings: "bars" })
    expect(loadConfig()).toEqual({ theme: "brothy", headings: "bars" })
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
    const real = join(xdg(), "real.json")
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
  for (const [name, text] of [
    ["empty", ""],
    ["whitespace", " \n\t"],
    ["BOM", '\uFEFF{"theme":"old"}'],
  ] as const) {
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

describe("ai", () => {
  test("a valid ai block is kept", () => {
    writeFileSync(file(), JSON.stringify({ ai: { provider: "ollama", model: "llama3.2", maxChars: 16000 } }))
    expect(loadConfig().ai).toEqual({ provider: "ollama", model: "llama3.2", maxChars: 16000 })
  })
  test("missing model or custom without baseURL turns AI off", () => {
    writeFileSync(file(), JSON.stringify({ ai: { provider: "openai" } }))
    expect(loadConfig().ai).toBeUndefined()
    writeFileSync(file(), JSON.stringify({ ai: { provider: "custom", model: "m" } }))
    expect(loadConfig().ai).toBeUndefined()
  })
  test("a bad optional field drops only that field", () => {
    writeFileSync(file(), JSON.stringify({ ai: { provider: "openai", model: "m", maxChars: 10 } }))
    expect(loadConfig().ai).toEqual({ provider: "openai", model: "m" })
  })
  test("saveConfig never rewrites the ai block", () => {
    const ai = { provider: "custom", model: "m", baseURL: "http://h/v1", headers: { "bad name": "kept as written" } }
    writeFileSync(file(), JSON.stringify({ ai }))
    expect(saveConfig({ theme: "dracula" })).toBe(true)
    expect(JSON.parse(readFileSync(file(), "utf8")).ai).toEqual(ai)
  })
})

describe("writeFileAtomic mode", () => {
  test("a new file gets the mode", () => {
    const f = join(xdg(), "new.json")
    writeFileAtomic(f, "{}", 0o600)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })
  test("an existing file keeps its own mode", () => {
    const f = join(xdg(), "old.json")
    writeFileSync(f, "{}")
    chmodSync(f, 0o644)
    writeFileAtomic(f, "{ }", 0o600)
    expect(statSync(f).mode & 0o777).toBe(0o644)
    expect(readFileSync(f, "utf8")).toBe("{ }")
  })
})

describe("motion", () => {
  test("reads a boolean motion, drops anything else", () => {
    writeFileSync(file(), '{"motion":false}')
    expect(loadConfig().motion).toBe(false)
    writeFileSync(file(), '{"motion":"no"}')
    expect(loadConfig().motion).toBeUndefined()
  })
})

describe("minimap", () => {
  test("reads a boolean minimap, drops anything else", () => {
    writeFileSync(file(), '{"minimap":false}')
    expect(loadConfig().minimap).toBe(false)
    for (const bad of ['{"minimap":1}', '{"minimap":"off"}', '{"minimap":null}']) {
      writeFileSync(file(), bad)
      expect(loadConfig().minimap).toBeUndefined()
    }
  })
})

describe("file format", () => {
  test("a hand-edited file round-trips byte for byte: unknown keys stay, a patch changes only its own key", () => {
    const text =
      JSON.stringify({ theme: "gruvbox", sidebar: { view: "outline", hidden: true }, zen: { measure: 60 }, wide: true, extra: { a: [1, 2] } }, null, 2) + "\n"
    writeFileSync(file(), text)
    expect(loadConfig()).toMatchObject({ theme: "gruvbox", sidebar: { view: "outline", hidden: true }, wide: true })
    expect(saveConfig({ theme: "gruvbox" })).toBe(true)
    expect(readFileSync(file(), "utf8")).toBe(text)
    expect(saveConfig({ wide: false, sidebar: { view: "info" } })).toBe(true)
    expect(readFileSync(file(), "utf8")).toBe(
      JSON.stringify({ theme: "gruvbox", sidebar: { view: "info", hidden: true }, zen: { measure: 60 }, wide: false, extra: { a: [1, 2] } }, null, 2) + "\n",
    )
  })
  test("a BOM file and a blank file are both saved as plain two-space JSON", () => {
    writeFileSync(file(), '\uFEFF{"theme":"a"}')
    expect(saveConfig({ wide: true })).toBe(true)
    expect(readFileSync(file(), "utf8")).toBe('{\n  "theme": "a",\n  "wide": true\n}\n')
    writeFileSync(file(), "\n")
    expect(saveConfig({ wide: true })).toBe(true)
    expect(readFileSync(file(), "utf8")).toBe('{\n  "wide": true\n}\n')
  })
  test("a file that is valid JSON but not an object is left alone", () => {
    writeFileSync(file(), "[1]")
    expect(loadConfig()).toEqual({})
    expect(saveConfig({ wide: true })).toBe(false)
    expect(readFileSync(file(), "utf8")).toBe("[1]")
  })
})
