import { expect, test } from "bun:test"
import { answerToast, doneExchange } from "../../src/app/pill"

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
