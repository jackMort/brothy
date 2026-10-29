import { describe, expect, test } from "bun:test"
import { parseArgs } from "../../src/system/args"
import { themes } from "../../src/theme/theme"

const ok = (argv: string[]) => {
  const r = parseArgs(argv)
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`)
  return r
}
const err = (argv: string[]) => {
  const r = parseArgs(argv)
  if (!("error" in r)) throw new Error("expected an error")
  return r.error
}
const theme = themes[1]!.name

describe("parseArgs", () => {
  test("defaults", () => expect(ok([])).toEqual({ path: ".", stdin: false, given: false, theme: undefined, transparent: false, help: false, version: false }))
  test("path", () => expect(ok(["docs"]).path).toBe("docs"))
  test("-t / --theme / --theme=", () => {
    expect(ok(["-t", theme]).theme).toBe(theme)
    expect(ok(["--theme", theme, "x.md"])).toMatchObject({ theme, path: "x.md" })
    expect(ok([`--theme=${theme}`]).theme).toBe(theme)
  })
  test("help and version", () => {
    expect(ok(["-h"]).help).toBe(true)
    expect(ok(["--help"]).help).toBe(true)
    expect(ok(["-v"]).version).toBe(true)
    expect(ok(["--version"]).version).toBe(true)
  })
  test("help wins over other errors", () => expect(ok(["--bogus", "-h"]).help).toBe(true))
  test("-- ends options", () => expect(ok(["--", "-weird.md"]).path).toBe("-weird.md"))
  test("unknown flags are rejected", () => {
    expect(err(["--bogus"])).toContain("--bogus")
    expect(err(["-x"])).toContain("-x")
  })
  test("-t without a value", () => {
    expect(err(["-t"])).toMatch(/requires a value/)
    expect(err(["--theme"])).toMatch(/requires a value/)
    expect(err(["--theme="])).toMatch(/requires a value/)
    expect(err(["-t", "--help-ish"])).toMatch(/requires a value/)
  })
  test("a family name is accepted as given (App resolves it)", () => {
    expect(ok(["-t", "one"]).theme).toBe("one")
    expect(ok(["--theme=ayu"]).theme).toBe("ayu")
    expect(ok(["-t", "vesper"]).theme).toBe("vesper")
  })
  test("unknown theme lists the families", () => {
    const e = err(["-t", "nope"])
    expect(e).toContain("nope")
    expect(e).toContain("oxocarbon")
    expect(err(["-t", "one-"])).toContain("one-")
  })
  test("unknown theme lists the valid ones", () => {
    const e = err(["-t", "nope"])
    expect(e).toContain("nope")
    expect(e).toContain(theme)
  })
  test("more than one path", () => expect(err(["a", "b"])).toMatch(/one path/))
})

test("--transparent", () => {
  expect(ok(["--transparent"]).transparent).toBe(true)
  expect(ok(["docs", "--transparent", "-t", theme])).toMatchObject({ path: "docs", transparent: true, theme })
  expect(ok(["docs"]).transparent).toBe(false)
})

describe("stdin", () => {
  test("- reads the document from stdin", () => {
    expect(ok(["-"]).stdin).toBe(true)
    expect(ok(["-"]).path).toBe(".")
  })
  test("a path or no path is not stdin (cli decides on a pipe)", () => {
    expect(ok([]).stdin).toBe(false)
    expect(ok(["notes"]).stdin).toBe(false)
  })
  test("- takes options like any path and conflicts with another path", () => {
    expect(ok(["-", "-t", "brothy"]).stdin).toBe(true)
    expect(ok(["--", "-"]).stdin).toBe(true)
    expect(err(["-", "notes"])).toContain("at most one path")
  })
})
