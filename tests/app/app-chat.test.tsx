// App: the chat pill: c, the input, sending, the card, marks and cites.
import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { filler, HINT_ROW, keys, OLLAMA, useAppHarness, W120, waitFor, waitFrame } from "./helpers"

const { tmp, mount, mountAI, aiConfig, openNote } = useAppHarness()

const NOTE =
  "# Slow broth\n\nIntro line.\n\n## Strain and cool\n\nPour the broth through a sieve; do not press the bones: pressing clouds it.\n"
const hints = (f: string) => f.split("\n")[HINT_ROW]!

test("c without an ai block toasts AI off; no pill", async () => {
  const d = tmp({ "Slow broth.md": NOTE })
  const s = await mount(d, "Slow broth.md")
  const f = await keys(s, "c")
  expect(f).toContain(`AI off · set "ai" in config.json`)
  expect(hints(f)).not.toContain("⏎ send")
})

test("c on a note with nothing in it: nothing to ask about", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "e.md": "---\ntitle: x\n---\n%%hidden%%\n" })
  const { s } = await mountAI(d, "e.md")
  expect(await keys(s, "c")).toContain("nothing to ask about")
})

test("c opens the pill: its footer pinned, keys typed (? and c too), esc hides; nothing sent before ⏎", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(tmp({ "Slow broth.md": NOTE }), "Slow broth.md")
  let f = await keys(s, "c")
  expect(hints(f)).toContain("⏎ send")
  expect(hints(f)).toContain("esc hide")
  f = await keys(s, "type:why c?")
  expect(ai.calls).toHaveLength(0)
  expect(hints(f)).toContain("⏎ send") // `?` was typed, not the help sheet
  f = await keys(s, "backspace", "C-u", "esc")
  expect(hints(f)).not.toContain("⏎ send")
  expect(ai.calls).toHaveLength(0)
})

test("⌫ on an empty input never removes the only note", async () => {
  aiConfig(OLLAMA)
  const { s } = await mountAI(tmp({ "Slow broth.md": NOTE }), "Slow broth.md")
  const f = await keys(s, "c", "backspace")
  expect(f).toContain("chat needs a note")
  expect(hints(f)).toContain("⏎ send")
})

test("[[ opens the note list's footer; esc drops the [[query and goes back to the input", async () => {
  aiConfig(OLLAMA)
  const { s } = await mountAI(tmp({ "Slow broth.md": NOTE, "Stock.md": "# Stock\n\nbones\n" }), "Slow broth.md")
  let f = await keys(s, "c", "type:and [[sto")
  expect(hints(f)).toContain("tab complete")
  expect(hints(f)).toContain("esc back")
  f = await keys(s, "esc")
  expect(hints(f)).toContain("esc hide")
  // the input kept what came before `[[`: one more esc hides the pill
  f = await keys(s, "esc")
  expect(hints(f)).not.toContain("⏎ send")
})

test("a pill the open note can no longer show (its file gone) gives the keys back", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "Slow broth.md": NOTE, "b.md": "# b\n\nbee\n" })
  const { s } = await mountAI(d, "Slow broth.md")
  expect(hints(await keys(s, "c"))).toContain("⏎ send")
  rmSync(join(d, "Slow broth.md"))
  const f = await waitFrame(s, (f) => !hints(f).includes("⏎ send"), 3000)
  expect(hints(f)).not.toContain("esc hide")
})

test("a focused pill the drawer hides takes no keys and shows no chat hints", async () => {
  aiConfig(OLLAMA)
  const { s } = await mountAI(tmp({ "Slow broth.md": NOTE }), "Slow broth.md")
  // the panel has focus, then the pill: narrowing turns the focused panel into an open drawer, which hides the pill
  expect(hints(await keys(s, "1", "c"))).toContain("⏎ send")
  s.resize(90, 30)
  await s.renderOnce() // the drawer opens as the resize draws
  const f = await keys(s, "/", "type:zzz")
  expect(hints(f)).not.toContain("⏎ send")
  expect(f).toContain("zzz") // the drawer's Files filter took the keys
})

test("with the pill up, the note scrolls far enough for its last row to clear the pill and its gap row", async () => {
  aiConfig(OLLAMA)
  const { s } = await mountAI(tmp({ "long.md": `# Long\n\n${filler(40)}\n` }), "long.md")
  await keys(s, "c")
  for (let i = 0; i < 40; i++) await s.mockMouse.scroll(70, 10, "down")
  const f = await waitFrame(s, (f) => f.includes("filler 39"))
  const rows = f.split("\n")
  const last = rows.findIndex((r) => r.includes("filler 39"))
  // body rows 2..27 at 100×30 (CH 26): the pill takes the last 3, the row above it stays clear
  expect(last).toBe(2 + 26 - 3 - 2)
})

/** The pill opened on NOTE with `q` sent; resolves with the app and the stub. */
async function asked(q = "why cloudy?", files: Record<string, string> = { "Slow broth.md": NOTE }) {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(tmp(files), "Slow broth.md")
  await keys(s, "c", `type:${q}`, "enter")
  await waitFor(s, () => ai.calls.length === 1)
  return { s, ai }
}
const REPLY =
  'Do not press the bones [1]. It clears [2].\nSources:\n[1] note 1: "do not press the bones"\n[2] note 1: "not in the note"'

test("⏎ sends one request: system with the note tag, the question; the footer says esc cancel while it streams", async () => {
  const { s, ai } = await asked()
  const m = ai.calls[0]!.body.messages
  expect(m.map((x) => x.role)).toEqual(["system", "user"])
  expect(m[0]!.content).toContain('<note id="1" title="Slow broth">')
  expect(m[1]!.content).toBe("why cloudy?")
  ai.send(0, "Do not press")
  expect(hints(await waitFrame(s, (f) => hints(f).includes("esc cancel")))).toContain("esc cancel")
})

test("a follow-up sends [system, user, assistant, user]; a failed exchange is never sent", async () => {
  const { s, ai } = await asked()
  ai.send(0, REPLY)
  ai.end(0)
  await waitFrame(s, (f) => hints(f).includes("go to"))
  await keys(s, "type:and salt?", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  expect(ai.calls[1]!.body.messages.map((x) => x.role)).toEqual(["system", "user", "assistant", "user"])
  expect(ai.calls[1]!.body.messages[2]!.content).toBe(REPLY)
})

test("an error shows in the card, no toast; ⏎ on an empty input retries as the second call", async () => {
  const { s, ai } = await asked()
  ai.fail(0, "model not found")
  const f = await waitFrame(s, (x) => hints(x).includes("⏎ retry"))
  expect(f).not.toContain("AI: model not found") // the toast; the card shows the message alone
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 2)
  expect(ai.calls[1]!.body.messages.map((x) => x.role)).toEqual(["system", "user"])
})

test("with 3 requests running ⏎ toasts busy and keeps the input", async () => {
  aiConfig(OLLAMA)
  const files = { "a.md": "# A\n\nA.\n", "b.md": "# B\n\nB.\n", "c.md": "# C\n\nC.\n", "Slow broth.md": NOTE }
  const { s, ai } = await mountAI(tmp(files), "a.md", { size: W120 })
  await keys(s, "a")
  for (const n of ["b", "c"]) {
    await openNote(s, n)
    await keys(s, "a")
  }
  await waitFor(s, () => ai.calls.length === 3)
  await openNote(s, "Slow broth")
  const f = await keys(s, "c", "type:again", "enter")
  expect(f).toContain("AI busy · 3 requests running")
  expect(ai.calls).toHaveLength(3)
  expect(hints(f)).toContain("⏎ send") // the input kept: still the input stage
})
