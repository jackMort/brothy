import { expect, test } from "bun:test"
import type { Timers } from "../../src/app/ctx"
import { answerToast, doneExchange, makePillMotion } from "../../src/app/pill"
import { INK_MS } from "../../src/ui/chrome"
import type { PillView } from "../../src/ui/pill"

test("answerToast: a success off its note says ready; a failure toasts only with no card on screen", () => {
  expect(answerToast(true, true, true)).toBeNull()
  expect(answerToast(true, false, false)).toBe("ready")
  expect(answerToast(true, true, false)).toBeNull()
  expect(answerToast(false, true, true)).toBeNull()
  expect(answerToast(false, true, false)).toBe("failed")
  expect(answerToast(false, false, false)).toBe("failed")
})

test("doneExchange: a verified source keeps its mark, one whose quote isn't in the note goes and its sentence stays", () => {
  const src = "# Slow broth\n\n## Strain and cool\n\nPour it; do not press the bones: pressing clouds it.\n"
  const chip = { path: "/n/Slow broth.md", title: "Slow broth" }
  const ex = { q: "why?", at: 1, model: "llama3.2", raw: null, parts: [], cites: [], error: null, doneAt: null }
  const text =
    'Do not press the bones [1]. It clears [2].\nSources:\n[1] note 1: "do not press the bones"\n[2] note 1: "not in the note"'
  const done = doneExchange(ex, text, [{ chip, src }], 5)
  expect(done.raw).toBe(text)
  expect(done.parts).toEqual(["Do not press the bones", 1, ". It clears."])
  expect(done.cites).toEqual([{ n: 1, path: chip.path, quote: "do not press the bones", line: 4 }])
  expect(done.doneAt).toBe(5)
})

/** makePillMotion over a stand-in context: the view `derive` gives, the bumps counted. */
function motionRig(motion: boolean, pill: Partial<PillView> | null) {
  const timers: { current: Timers } = { current: {} }
  const alive = { current: true }
  let bumps = 0
  const view =
    pill && ({ focus: true, openedAt: 0, running: null, land: null, thread: { turns: [] }, ...pill } as PillView)
  const { animate } = makePillMotion({
    ui: { current: { motion } },
    derive: () => ({ pill: view }),
    timers,
    alive,
    bump: () => bumps++,
  })
  return { animate, timers, alive, bumps: () => bumps }
}

test("the pill's timer redraws while the border inks, then stops once nothing moves", async () => {
  const r = motionRig(true, { openedAt: Date.now() })
  r.animate()
  expect(r.timers.current.chat).toBeDefined()
  // the ink takes 3 × INK_MS from the opening; late timers under load only make it later
  for (const end = Date.now() + 2000; r.timers.current.chat && Date.now() < end; ) await Bun.sleep(20)
  expect(r.timers.current.chat).toBeUndefined()
  const n = r.bumps()
  expect(n).toBeGreaterThan(0)
  await Bun.sleep(4 * INK_MS)
  expect(r.bumps()).toBe(n) // nothing scheduled: no redraw once the motion settled
  expect(r.timers.current.chat).toBeUndefined()
})

test("the pill's timer: never armed with motion off, with nothing moving, or with the pill hidden", () => {
  for (const r of [
    motionRig(false, { openedAt: Date.now() }),
    motionRig(true, { openedAt: Date.now() - 10 * INK_MS }),
    motionRig(true, null),
  ]) {
    r.animate()
    expect(r.timers.current.chat).toBeUndefined()
  }
})

test("the pill's timer: one at a time; after unmount it fires without a redraw", async () => {
  const r = motionRig(true, { openedAt: Date.now() })
  r.animate()
  const first = r.timers.current.chat
  r.animate()
  expect(r.timers.current.chat).toBe(first)
  r.alive.current = false
  await Bun.sleep(2 * INK_MS)
  expect(r.bumps()).toBe(0)
  expect(r.timers.current.chat).toBeUndefined()
})
