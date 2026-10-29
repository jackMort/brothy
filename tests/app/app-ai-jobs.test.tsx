// App: the AI job entry points (a, D) seen from the panel: where focus goes, and what a refused request leaves alone.
import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { keys, OLLAMA, useAppHarness, W120, waitFor, waitFrame } from "./helpers"

const { tmp, openNote, aiConfig, mountAI } = useAppHarness()

const TWO = "# E\n\n## One\n\nfirst\n\n## Two\n\nsecond\n"
const EDITED = "# E\n\n## One\n\nfirst, edited\n\n## Two\n\nsecond\n\n## Three\n\nthird\n"

test("D from the Files panel starts the request and shows Info", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "e.md": TWO })
  const { s, ai } = await mountAI(d, "e.md", { size: W120 })
  writeFileSync(join(d, "e.md"), EDITED)
  await waitFrame(s, (f) => f.includes("reloaded · 2 sections changed"), 4000)
  expect(await keys(s, "1")).not.toContain("Changed ·")
  const f = await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  expect(f).toContain("Changed · explaining…")
})

test("D refused while 3 requests run: AI busy, no request, Info stays closed", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nA.\n", "b.md": "# B\n\nB.\n", "c.md": "# C\n\nC.\n", "e.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  await keys(s, "a")
  for (const n of ["b", "c"]) {
    await openNote(s, n)
    await keys(s, "a")
  }
  await waitFor(s, () => ai.calls.length === 3)
  await openNote(s, "e")
  writeFileSync(join(d, "e.md"), EDITED)
  await waitFrame(s, (f) => f.includes("reloaded · 2 sections changed"), 4000)
  await keys(s, "1")
  const f = await keys(s, "D")
  expect(f).toContain("AI busy · 3 requests running")
  expect(f).not.toContain("Changed ·")
  expect(ai.calls.length).toBe(3)
})
