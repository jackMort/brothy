import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ART_PATH, STEAM_FRAMES, siteArt } from "../scripts/site-art"

test("site/src/art.json is what scripts/site-art.ts draws from the current wordmark and bowl", () => {
  expect(JSON.parse(readFileSync(ART_PATH, "utf8"))).toEqual(JSON.parse(JSON.stringify(siteArt())))
})

test("siteArt: an 18x3-cell wordmark, the 30-cell bowl with its three roles, braille steam frames", () => {
  const a = siteArt()
  expect([a.wordmark.w, a.wordmark.h]).toEqual([180, 60])
  expect(a.bowl.w).toBe(300)
  for (const k of ["body", "edge", "broth"] as const) expect(a.bowl[k]).toMatch(/^M[\d.]+ [\d.]+h/)
  expect(a.steam.frames).toHaveLength(STEAM_FRAMES)
  for (const r of a.steam.frames[a.steam.still]!) expect(r).toMatch(/^[ ⠀-⣿]{22}$/)
})
