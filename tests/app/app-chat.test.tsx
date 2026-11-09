// App: the chat pill: c, the input, sending, the card, marks and cites.
import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { mix } from "../../src/theme/theme"
import { hex } from "../helpers/theme"
import { B, filler, HINT_ROW, keys, OLLAMA, spansOf, useAppHarness, W120, waitFor, waitFrame, walk } from "./helpers"

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

// ------------------------------------------------------------- drawing: the pill, the card, the list; the mouse

test("c draws the pill: wisp, placeholder, the note's chip, ~N tokens on its bottom border", async () => {
  aiConfig(OLLAMA)
  const { s } = await mountAI(tmp({ "Slow broth.md": NOTE }), "Slow broth.md")
  const f = await keys(s, "c")
  expect(f).toContain("⠳⢆ ▍ask about this note…")
  expect(f).toContain(" Slow broth ")
  expect(f).toMatch(/╰─+ ~\d+ tokens ──╯/)
})

test("the card: the question, the streamed text, the rule `esc cancel`; done: one ¹ kept, the other mark gone, its sentence kept", async () => {
  const { s, ai } = await asked()
  ai.send(0, "Do not press the bones [1]. It clears [2].")
  let f = await waitFrame(s, (x) => x.includes("It clears"))
  expect(f).toContain("› why cloudy?")
  expect(f).toMatch(/esc cancel/)
  ai.send(0, '\nSources:\n[1] note 1: "do not press the bones"\n[2] note 1: "not in the note"')
  ai.end(0)
  f = await waitFrame(s, (x) => x.includes("go to"))
  expect(f).toContain("Do not press the bones¹. It clears.")
  expect(f).not.toMatch(/clears²/)
  expect(f).toContain("¹ Strain and cool · “do not press the bones”")
})

test("esc while streaming: the question is back in the input", async () => {
  const { s } = await asked("first?")
  const f = await keys(s, "esc")
  expect(f).toContain("first?▍")
})

/** A reply of `n` sentences, a paragraph each (a blank row apart in the card). */
const longReply = (n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence ${i} of a long answer that goes on.`).join("\n\n")

test("a tall card stays on screen: its top border below the first body row, one clear row above the pill", async () => {
  const { s, ai } = await asked()
  ai.send(0, longReply(30))
  ai.end(0)
  const f = await waitFrame(s, (x) => x.includes("Sentence 29"))
  const rows = f.split("\n")
  const tops = rows.flatMap((r, i) => (r.includes("╭") ? [i] : []))
  // body rows 2..27 at 100×30 (CH 26): the pill's 3 rows from 25, the gap row 24, the card at most CH − 5 = 21 rows
  expect(tops).toEqual([3, 25])
  expect(rows[24]!.trim()).toBe("")
  expect(rows[23]).toContain("╰")
})

test("an error: the card's ✗ row; folded to the pill, ⏎ on an empty input sends nothing and says send", async () => {
  const { s, ai } = await asked()
  ai.fail(0, "model not found")
  let f = await waitFrame(s, (x) => hints(x).includes("⏎ retry"))
  expect(f).toContain("✗ model not found")
  f = await keys(s, "esc") // the card folds: the input stage
  expect(hints(f)).toContain("⏎ send")
  await keys(s, "enter")
  expect(ai.calls).toHaveLength(1)
})

const TWO =
  'Do not press the bones [1]. Strain it [2].\nSources:\n[1] note 1: "do not press the bones"\n[2] note 1: "Pour the broth through a sieve"'

/** The card answered with TWO: the app, the stub, the frame. */
async function answered(files?: Record<string, string>) {
  const { s, ai } = await asked("why cloudy?", files)
  ai.send(0, TWO)
  ai.end(0)
  const f = await waitFrame(s, (x) => x.includes("go to"))
  return { s, ai, f }
}

test("hovering a cite row selects it", async () => {
  const { s, f } = await answered()
  const rows = f.split("\n")
  const second = rows.findIndex((r) => r.includes("² Strain and cool"))
  expect(rows[second - 1]).toContain("▌ ¹")
  const x = rows[second]!.indexOf("²")
  await s.mockMouse.moveTo(x, second)
  const g = await waitFrame(s, (y) => y.split("\n")[second]!.includes("▌ ²"))
  expect(g.split("\n")[second - 1]).not.toContain("▌")
})

test("the wheel over the card leaves the page where it was", async () => {
  const { s, f } = await answered({ "Slow broth.md": `${NOTE}\n${filler(40)}\n` })
  const rows = f.split("\n")
  const card = rows.findIndex((r) => r.includes("› why cloudy?"))
  const x = rows[card]!.indexOf("›")
  for (let i = 0; i < 3; i++) await s.mockMouse.scroll(x, card, "down")
  const g = await keys(s)
  expect(g.split("\n")[2]).toBe(rows[2])
})

test("a click on the Files panel while the pill has focus does nothing", async () => {
  aiConfig(OLLAMA)
  const { s } = await mountAI(tmp({ "Slow broth.md": NOTE, "b.md": "# B\n\nPears.\n" }), "Slow broth.md", {
    size: W120,
  })
  // the Files list on screen, the note's focus back: `b` is its first row, under the tab strip and its rule
  const B_ROW = 4
  expect((await keys(s, "1", "esc")).split("\n")[B_ROW]).toMatch(/^ {4}b {2}/)
  await keys(s, "c")
  await s.mockMouse.click(4, B_ROW)
  const f = await keys(s)
  expect(f).not.toContain("Pears.")
  expect(hints(f)).toContain("⏎ send")
})

test("a click on the minimap while the pill has focus leaves the page where it was", async () => {
  aiConfig(OLLAMA)
  const { s } = await mountAI(tmp({ "long.md": `# Long\n\n${filler(60)}\n` }), "long.md", { size: W120 })
  const f = await keys(s, "c")
  await s.mockMouse.click(117, 26) // the minimap's last columns, near its bottom
  const g = await keys(s)
  expect(g.split("\n")[3]).toBe(f.split("\n")[3])
  expect(hints(g)).toContain("⏎ send")
})

/** The pill's band at 120×30: the clear row (24) and the pill's rows (25..27). */
const BAND = [24, 25, 26, 27]
/** Note text drawn on the band's rows (under the pill), by the text renderables there. */
const textUnderPill = (s: Awaited<ReturnType<typeof mount>>) =>
  walk(s.renderer.root).flatMap((r) => {
    const text = "plainText" in r ? String(r.plainText) : ""
    return BAND.includes(r.screenY) && text.includes("filler") ? [text] : []
  })

test("the band follows the page's background: transparent with T, the theme's without; no note text under the pill", async () => {
  aiConfig(OLLAMA)
  const { s } = await mountAI(tmp({ "long.md": `# Long\n\n${filler(60)}\n` }), "long.md", { size: W120 })
  await keys(s, "c")
  const clear = () => s.captureSpans().lines[24]!.spans
  expect(clear().some((sp) => hex(sp.bg) === B.background)).toBe(true)
  expect(textUnderPill(s)).toEqual([])
  await keys(s, "esc", "T", "c")
  expect(clear().every((sp) => sp.bg.a === 0)).toBe(true)
  expect(textUnderPill(s)).toEqual([])
  expect(s.captureCharFrame().split("\n")[24]!.trim()).toBe("")
})

test("the page dims by 0.5 while the card is up, not while typing", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(tmp({ "Slow broth.md": NOTE }), "Slow broth.md", { size: { width: 120, height: 30 } })
  const fgOf = (word: string) => hex(spansOf(s).find((sp) => sp.text.includes(word))!.fg)
  await keys(s, "c", "type:q")
  expect(fgOf("Intro line")).toBe(B.text)
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 1)
  await s.renderOnce()
  expect(fgOf("Intro line")).toBe(mix(B.text, B.background, 0.5))
})
