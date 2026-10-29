import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Screen, undrawn, unsupported } from "../../site/src/scripts/ansi"

const DIR = join(import.meta.dir, "../../site/public/casts")
const casts = readdirSync(DIR).filter((f) => f.endsWith(".cast"))

test("there are committed casts to check", () => {
  expect(casts.length).toBeGreaterThan(0)
})

for (const f of casts)
  test(`${f}: asciicast v2 output using only what the site's canvas player handles`, () => {
    const [head, ...lines] = readFileSync(join(DIR, f), "utf8").trim().split("\n")
    const h = JSON.parse(head!) as { version: number; width: number; height: number }
    expect(h.version).toBe(2)
    const bad = new Set<string>(), glyphs = new Set<string>()
    let last = 0
    for (const l of lines) {
      const [t, kind, d] = JSON.parse(l) as [number, string, string]
      expect(kind).toBe("o")
      expect(t).toBeGreaterThanOrEqual(last)
      last = t
      for (const s of unsupported(d)) bad.add(JSON.stringify(s))
      for (const g of undrawn(d)) glyphs.add(g)
    }
    expect([...bad]).toEqual([])
    expect([...glyphs]).toEqual([])
  })

test("unsupported / undrawn: what the player can't replay is reported", () => {
  expect(unsupported("\x1b[2J\x1b[?25l\x1b[3;7H\x1b[0;1;38;2;1;2;3;48;2;4;5;6mx\x1b[0m")).toEqual([])
  expect(unsupported("\x1b[K\x1b[2;5r\x1b[38;5;12m\x1b[1J\x1b]0;t\x07")).toEqual(["\x1b[K", "\x1b[2;5r", "\x1b[38;5;12m", "\x1b[1J", "\x1b]"])
  expect(undrawn("─━┈▌ ok ╌ ▒")).toEqual(["╌", "▒"])
})

test("Screen replays cursor moves, clear and truecolor SGR into cells", () => {
  const s = new Screen(4, 2)
  s.write("\x1b[2;2H\x1b[0;1;38;2;1;2;3;48;2;4;5;6mab\x1b[0mc")
  expect(s.ch.join("")).toBe("     abc")
  expect([s.fg[5], s.bg[5], s.at[5]]).toEqual(["1,2,3", "4,5,6", 1])
  expect([s.fg[7], s.at[7]]).toEqual([null, 0])
  s.write("\x1b[2J")
  expect(s.ch.join("")).toBe("        ")
})
