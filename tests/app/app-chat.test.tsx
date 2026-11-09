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

test("esc while streaming aborts and puts the question back; esc again hides; c brings back the card with the earlier thread", async () => {
  const { s, ai } = await asked("first?")
  ai.send(0, REPLY)
  ai.end(0)
  await waitFrame(s, (f) => hints(f).includes("go to"))
  await keys(s, "type:second?", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  let f = await keys(s, "esc")
  expect(ai.calls[1]!.signal?.aborted).toBe(true)
  expect(hints(f)).toContain("↑↓ marks") // the card stays: an exchange remains (⏎ says send: the question is back)
  expect(hints(f)).toContain("⏎ send")
  f = await keys(s, "esc") // card → input
  expect(hints(f)).not.toContain("↑↓ marks")
  f = await keys(s, "C-u", "esc") // input → hidden
  expect(hints(f)).not.toContain("⏎ send")
  f = await keys(s, "c")
  expect(hints(f)).toContain("⏎ go to")
})

test("esc on the only running exchange: back to the input with its question, which ⏎ sends again as the first turn", async () => {
  const { s, ai } = await asked("why cloudy?")
  ai.send(0, "Do not")
  await waitFrame(s, (f) => hints(f).includes("esc cancel"))
  const f = await keys(s, "esc")
  expect(ai.calls[0]!.signal?.aborted).toBe(true)
  expect(hints(f)).toContain("esc hide") // the input stage: no exchange left for a card
  expect(hints(f)).toContain("⏎ send")
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 2)
  expect(ai.calls[1]!.body.messages.map((x) => [x.role, x.role === "user" ? x.content : ""])).toEqual([
    ["system", ""],
    ["user", "why cloudy?"],
  ])
})

// ------------------------------------------------------------- hiding and dropping

test("c in zen does nothing chat-related (c is in ZEN_OFF)", async () => {
  aiConfig(OLLAMA)
  const s = await mount(tmp({ "Slow broth.md": NOTE }), "Slow broth.md")
  const f = await keys(s, "z", "c")
  expect(f).not.toContain("ask about this note…")
  expect(f).not.toContain("⏎ send")
})

test("90×30 with the drawer open: c closes the drawer and opens the pill", async () => {
  aiConfig(OLLAMA)
  const s = await mount(tmp({ "Slow broth.md": NOTE }), "Slow broth.md", { size: { width: 90, height: 30 } })
  expect(await keys(s, "C-b")).toMatch(/Files\s+²Outline/)
  const f = await keys(s, "c")
  expect(hints(f)).toContain("⏎ send")
  expect(f).not.toMatch(/Files\s+²Outline/)
})

test("threads per note: ask in A, open B (hidden), c in B is empty, back in A c shows A's card", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(tmp({ "Slow broth.md": NOTE, "pears.md": "# Pears\n\nRipe.\n" }), "Slow broth.md")
  await keys(s, "c", "type:why?", "enter")
  ai.send(0, REPLY)
  ai.end(0)
  await waitFrame(s, (f) => hints(f).includes("go to"))
  await keys(s, "esc", "esc")
  expect(await openNote(s, "pears")).toContain("Ripe.")
  let f = await keys(s, "c")
  expect(hints(f)).toContain("⏎ send")
  await keys(s, "esc")
  await openNote(s, "Slow broth")
  f = await keys(s, "c")
  expect(hints(f)).toContain("go to")
})

/** The pill opened on soup.md with the panel focused, `ks` pressed in it, then hidden behind the drawer a resize to 90×30 opens. */
async function behindDrawer(files: Record<string, string>, ...ks: string[]) {
  aiConfig(OLLAMA)
  const d = tmp({ "soup.md": NOTE, ...files })
  const { s, ai } = await mountAI(d, "soup.md")
  // the panel has focus, then the pill: narrowing turns the focused panel into an open drawer, which hides the pill
  expect(hints(await keys(s, "1", "c"))).toContain("⏎ send")
  await keys(s, ...ks)
  s.resize(90, 30)
  await s.renderOnce()
  return { s, ai, d }
}

test("the pill hides when another note opens: a note picked in the drawer's Files leaves no pill over it", async () => {
  const { s } = await behindDrawer({ "pears.md": "# Pears\n\nRipe.\n" })
  const f = await keys(s, "/", "type:pears", "enter")
  expect(f).toContain("Ripe.")
  expect(hints(f)).not.toContain("⏎ send")
  expect(hints(await keys(s, "j"))).not.toContain("esc hide") // j scrolls the note: the keys are the document's
})

test("c on a pill the drawer hides: the drawer closes and the pill comes back as it was, its input kept", async () => {
  const { s, ai } = await behindDrawer({}, "type:keep me")
  const f = await keys(s, "c")
  expect(f).not.toMatch(/Files\s+²Outline/)
  expect(hints(f)).toContain("⏎ send")
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 1)
  expect(ai.calls[0]!.body.messages.at(-1)!.content).toBe("keep me")
})

test("a new workspace drops every thread and cancels its running answer", async () => {
  const other = tmp({ "pears.md": "# Pears\n\nRipe.\n" })
  // sent, then hidden behind the drawer with its answer running: `o` reaches the opener
  const { s, ai, d } = await behindDrawer({}, "type:why?", "enter")
  expect(ai.calls).toHaveLength(1)
  expect(await keys(s, "o", `type:${other}/pears`, "enter")).toContain("Ripe.")
  expect(ai.calls[0]!.signal?.aborted).toBe(true)
  await keys(s, "o", `type:${d}/soup`, "enter")
  const f = await keys(s, "c")
  expect(hints(f)).toContain("⏎ send") // an empty thread: the input, no card
  expect(hints(f)).not.toContain("esc cancel")
})
