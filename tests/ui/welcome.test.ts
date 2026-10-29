import { expect, test } from "bun:test"
import { BIG, SMALL, STILL_TICK, steamRows, welcomeArt, welcomeFit, type ArtCell } from "../../src/ui/welcome"
import { WORDMARK } from "../../src/ui/status"

const text = (rows: ArtCell[][]) => rows.map((r) => r.map((c) => c.ch).join(""))

test("steamRows: v3's particle field, braille or blank, the same for the same tick and moving between ticks", () => {
  expect(steamRows(12, 22, 4)).toEqual(["        ⠠ ⠂   ⢈       ", "         ⠐⣈⡀   ⠄      ", "         ⠭   ⢐⡂       ", "        ⢉⡐⠂  ⠠⠄       "])
  expect(steamRows(12, 16, 2)).toEqual(["     ⡠⢁⡈  ⠰     ", "      ⢒⡒  ⠈⠥    "])
  const a = steamRows(7, 22, 4)
  for (const r of a) {
    expect([...r]).toHaveLength(22)
    for (const c of r) expect(c === " " || (c >= "⠁" && c <= "⣿")).toBe(true)
  }
  expect(steamRows(7, 22, 4)).toEqual(a)
  expect(steamRows(8, 22, 4)).not.toEqual(a)
})

test("welcomeArt BIG: wordmark (36 cells), steam over a 30-cell bowl centred under it with chopsticks and a foot", () => {
  const rows = welcomeArt(BIG, STILL_TICK)
  const t = text(rows)
  expect(t).toHaveLength(15)
  for (const r of t) expect([...r]).toHaveLength(36)
  expect(t.slice(0, 3)).toEqual([...WORDMARK])
  expect(t.slice(8)).toEqual([
    "   ▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖   ",
    "    ████████████████████████████    ",
    "    ▐██████████████████████████▌    ",
    "     ▀████████████████████████▀     ",
    "      ▝▜████████████████████▛▘      ",
    "         ▀▜██████████████▛▀         ",
    "             ▝▀▀▀▀▀▀▀▀▀▘            ",
  ])
  // chopsticks rest on the broth, right of the steam
  expect(t.slice(3, 8).map((r) => r.slice(27, 33))).toEqual(["    ▞ ", "   ▞ ▞", "  ▞ ▞ ", " ▞ ▞  ", "▞ ▞   "])
  // the steam field (22×4) sits on the rim, centred
  expect(t.slice(4, 8).map((r) => r.slice(7, 27))).toEqual(steamRows(STILL_TICK, 22, 4).map((r) => r.slice(0, 20)))
  // roles: the broth is the top half of the rim's inner cells
  expect(rows[8]!.map((c) => (c.broth ? "b" : ".")).join("")).toBe("....." + "b".repeat(26) + ".....")
  expect(rows[8]![3]!.role).toBe("edge")
  expect(rows[9]![8]!.role).toBe("body")
  expect(rows[0]![0]!.role).toBe("mark")
  expect(rows[3]![31]!.role).toBe("edge")
  expect(rows[7]!.find((c) => c.role === "steam")!.row).toBe(4) // the bottom steam row takes the last colour
})

test("welcomeArt SMALL: a 20-cell bowl centred under the wordmark, two rows of steam, no foot and no chopsticks", () => {
  const t = text(welcomeArt(SMALL, STILL_TICK))
  expect(t).toEqual([
    ...WORDMARK,
    " ".repeat(10) + steamRows(STILL_TICK, 16, 2)[0] + " ".repeat(10),
    " ".repeat(10) + steamRows(STILL_TICK, 16, 2)[1] + " ".repeat(10),
    "        ▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖        ",
    "         ██████████████████         ",
    "         ▝▜██████████████▛▘         ",
    "           ▝▀██████████▀▘           ",
  ])
})

test("welcomeArt: without steam the field is blank; without the bowl only the wordmark is left", () => {
  const still = text(welcomeArt(BIG, STILL_TICK, { steam: false }))
  expect(still.slice(4, 8).every((r) => !/[⠁-⣿]/.test(r))).toBe(true)
  expect(text(welcomeArt(SMALL, 0, { bowl: false }))).toEqual([...WORDMARK])
})

test("welcomeFit: v3's rows at 120×34 (CH 30) and 80×24 (CH 21) with 3 recent projects", () => {
  expect(welcomeFit(80, 30, 3)).toEqual({ size: BIG, steam: true, bowl: true, mark: true, recents: 3, hint: true, top: 2, height: 26 })
  expect(welcomeFit(74, 21, 3)).toEqual({ size: SMALL, steam: true, bowl: true, mark: true, recents: 3, hint: true, top: 1, height: 19 })
})

test("welcomeFit: shrinks the bowl, then drops steam, recent rows, the bowl and the wordmark; message, keys and hint stay", () => {
  const seen: string[] = []
  for (let CH = 40; CH >= 3; CH--) {
    const f = welcomeFit(80, CH, 5)
    expect(f.height).toBeLessThanOrEqual(Math.max(CH, 3))
    const k = `${f.size === BIG ? "big" : "small"} ${f.steam} ${f.recents} ${f.bowl} ${f.mark}`
    if (seen.at(-1) !== k) seen.push(k)
  }
  expect(seen[0]).toBe("big true 5 true true")
  expect(seen.slice(0, 3)).toEqual(["big true 5 true true", "small true 5 true true", "small false 5 true true"])
  expect(seen).toContain("small false 0 true true")
  expect(seen.at(-1)).toBe("small false 0 false false")
  expect(welcomeFit(80, 3, 5)).toMatchObject({ mark: false, hint: false, height: 3 })
  // narrow: the art is as wide as the wordmark, 36 columns, and gives way to the text below that
  expect(welcomeFit(36, 40, 0)).toMatchObject({ mark: true, bowl: true })
  expect(welcomeFit(35, 40, 0)).toMatchObject({ mark: false, bowl: false })
})
