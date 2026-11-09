// App: the chat pill: c, the input, sending, the card, marks and cites.
import { expect, setSystemTime, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
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
  // the minimap's first lit cell in the body's upper rows (columns 116-119)
  const miniFg = () =>
    s
      .captureSpans()
      .lines.slice(3, 9)
      .flatMap((l) => l.spans)
      .find((sp) => /[\u2800-\u28ff]/.test(sp.text) && sp.fg)!.fg
  await keys(s, "c", "type:q")
  expect(fgOf("Intro line")).toBe(B.text)
  const lit = hex(miniFg())
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 1)
  await s.renderOnce()
  expect(hex(miniFg())).toBe(mix(lit!, B.background, 0.5))
  expect(fgOf("Intro line")).toBe(mix(B.text, B.background, 0.5))
})

// ------------------------------------------------------------- marks and scrolling in the card

test("↑↓ walk every cite of the card with no wrap; the selected one gets ▌", async () => {
  const { s, ai } = await asked()
  ai.send(0, 'A [1]. B [2].\nSources:\n[1] note 1: "do not press the bones"\n[2] note 1: "Intro line"')
  ai.end(0)
  let f = await waitFrame(s, (x) => x.includes("go to"))
  expect(f).toMatch(/▌ ¹ Strain and cool/)
  f = await keys(s, "down")
  expect(f).toMatch(/▌ ² Slow broth · “Intro line”/)
  f = await keys(s, "down")
  expect(f).toMatch(/▌ ² /)
  f = await keys(s, "up", "up")
  expect(f).toMatch(/▌ ¹ /)
})

test("a hover re-check after a key (no pointer move) keeps the key's selection", async () => {
  const { s, f } = await answered()
  const rows = f.split("\n")
  const second = rows.findIndex((r) => r.includes("² Strain and cool"))
  await s.mockMouse.moveTo(rows[second]!.indexOf("²"), second)
  await waitFrame(s, (y) => y.split("\n")[second]!.includes("▌ ²"))
  await keys(s, "up")
  // what OpenTUI does after a render whose hit grid changed: an `over` at the resting pointer's cell. Forced through
  // two renderer internals of @opentui/core 0.8.1 (`lastOverRenderable`, `recheckHoverState`): a key keeps the card's
  // row renderables, so no natural re-check lands on another one
  const r = s.renderer as unknown as { lastOverRenderable?: unknown; recheckHoverState: () => void }
  r.lastOverRenderable = undefined
  r.recheckHoverState()
  const g = await keys(s)
  expect(g.split("\n")[second - 1]).toContain("▌ ¹")
  expect(g.split("\n")[second]).not.toContain("▌")
})

const PGUP = "\x1b[5~"
const PGDN = "\x1b[6~"
/** The answer to exchange `i`: one sentence and its cite. */
const cited = (i: number) => `Answer ${i} [1].\nSources:\n[1] note 1: "do not press the bones"`

/** A thread of `n` answered exchanges at 100×20, the card taller than its room. */
async function longThread(n: number) {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(tmp({ "Slow broth.md": NOTE }), "Slow broth.md", { size: { width: 100, height: 20 } })
  await keys(s, "c")
  for (let i = 0; i < n; i++) {
    await keys(s, `type:question ${i}?`, "enter")
    await waitFor(s, () => ai.calls.length === i + 1)
    ai.send(i, cited(i))
    ai.end(i)
    await waitFrame(s, (x) => x.includes(`Answer ${i}¹`))
  }
  return s
}

test("pgup scrolls the card up (↓ n more on its bottom border); pgdn pins it back to the bottom", async () => {
  const s = await longThread(4)
  let f = await keys(s)
  expect(f).toContain("Answer 3¹")
  expect(f).not.toContain("more ─")
  expect(f).not.toContain("› question 0?")
  f = await keys(s, PGUP, PGUP, PGUP)
  expect(f).toMatch(/╰─+ ↓ \d+ more ─+╯/)
  expect(f).toContain("› question 0?") // at the top: the oldest exchange
  expect(f).not.toContain("Answer 3¹")
  f = await keys(s, PGDN, PGDN, PGDN)
  expect(f).not.toMatch(/↓ \d+ more/)
  expect(f).toContain("Answer 3¹")
})

test("↑ walks back to an earlier exchange's cite, the card scrolled to keep it in view; ↓ brings it back", async () => {
  const s = await longThread(4)
  let f = ""
  for (let i = 0; i < 3; i++) {
    f = await keys(s, "up")
    expect(f).toMatch(/▌ ¹/)
  }
  // exchange 0's cite selected and on screen, the newest scrolled out of view
  const sel = f.split("\n").findIndex((r) => r.includes("▌ ¹"))
  expect(sel).toBeGreaterThan(-1)
  expect(f).toMatch(/↓ \d+ more/)
  expect(f).not.toContain("Answer 3¹")
  f = await keys(s, "up") // no wrap: still the first stop
  expect(f.split("\n").findIndex((r) => r.includes("▌ ¹"))).toBe(sel)
  for (let i = 0; i < 4; i++) {
    f = await keys(s, "down")
    expect(f).toMatch(/▌ ¹/) // every stop on the way is kept in view
  }
  expect(f).toContain("Answer 3¹")
  expect(f).not.toMatch(/↓ \d+ more/)
  expect(f).toMatch(/▌ ¹/)
})

test("one wheel notch over a tall card scrolls it 3 rows, not a page; back down it pins again", async () => {
  const { s, ai } = await asked()
  ai.send(0, longReply(30))
  ai.end(0)
  const rowOf = (f: string, text: string) => f.split("\n").findIndex((r) => r.includes(text))
  const f = await waitFrame(s, (x) => x.includes("Sentence 29"))
  const at = rowOf(f, "Sentence 25")
  const x = f.split("\n")[at]!.indexOf("Sentence")
  await s.mockMouse.scroll(x, at, "up")
  let g = await keys(s)
  expect(rowOf(g, "Sentence 25")).toBe(at + 3)
  expect(g).toMatch(/╰─+ ↓ 3 more ─+╯/)
  await s.mockMouse.scroll(x, at, "down")
  g = await keys(s)
  expect(rowOf(g, "Sentence 25")).toBe(at)
  expect(g).not.toMatch(/↓ \d+ more/)
})

test("the terminal shrinks with the card up: the card re-pins and keeps the top line and a clear row", async () => {
  const { s, ai } = await asked()
  ai.send(0, `${"A long answer sentence. ".repeat(30)}[1]\nSources:\n[1] note 1: "do not press the bones"`)
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  await keys(s, PGUP) // scrolled up first: the smaller room re-pins it
  s.resize(60, 14) // MIN_W × MIN_H: the note still draws
  const f = await keys(s)
  const rows = f.split("\n")
  expect(rows[0]).toContain("Slow broth") // the top line is still there
  const tops = rows.flatMap((r, i) => (r.includes("╭") ? [i] : []))
  expect(tops).toHaveLength(2) // the card's and the pill's: the card's top border is not clipped
  // 60×14: the top line, then the body from row 1 (no gap row below 28); body row 0 kept clear
  expect(tops[0]).toBeGreaterThanOrEqual(2)
  const pillTop = tops[1]!
  expect(rows[pillTop - 1]!.trim()).toBe("") // the clear row between the card and the pill
  expect(rows[pillTop - 2]).toContain("╰")
})

// ------------------------------------------------------------- chips: the `[[` list

/** The pill's own row (its wisp, the input, the chips). */
const pillOf = (f: string) => f.split("\n").find((r) => r.includes("⠳⢆")) ?? ""

const LINKED = {
  "Slow broth.md": `${NOTE}\nSee [[simmering]].\n`,
  "simmering.md": "# Simmering\n\nKeep it below a boil.\n",
}

test("[[sim ⏎ adds a chip; the next body holds two <note> tags; ⌫ on an empty input removes it; on the only chip it toasts", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(tmp(LINKED), "Slow broth.md")
  let f = await keys(s, "c", "type:[[sim")
  expect(f).toContain("simmering  linked from here")
  f = await keys(s, "enter")
  expect(pillOf(f)).toContain(" Slow broth   simmering ")
  expect(pillOf(f)).not.toContain("[[sim")
  expect(hints(f)).toContain("esc hide") // back to the input's footer
  await keys(s, "type:why?", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  const system = ai.calls[0]!.body.messages[0]!.content
  expect(system).toContain('<note id="1" title="Slow broth">')
  expect(system).toContain('<note id="2" title="simmering">')
  await keys(s, "esc") // cancel: the question back in the input
  f = await keys(s, "C-u", "backspace")
  expect(pillOf(f)).not.toContain("simmering")
  expect(pillOf(f)).toContain(" Slow broth ")
  f = await keys(s, "backspace")
  expect(f).toContain("chat needs a note")
})

test("[[ alone lists the notes the thread's note links to; ↓ moves the highlight and tab adds it, keeping the text before", async () => {
  aiConfig(OLLAMA)
  const d = tmp({
    "Slow broth.md": `${NOTE}\nSee [[simmering]] and [[stock]].\n`,
    "simmering.md": "# Simmering\n\nLow.\n",
    "stock.md": "# Stock\n\nBones.\n",
    "other.md": "# Other\n\nNot linked.\n",
  })
  const { s } = await mountAI(d, "Slow broth.md")
  let f = await keys(s, "c", "type:and [[")
  expect(f).toContain("▌ simmering  linked from here")
  expect(f).toContain("  stock  linked from here")
  expect(f).not.toContain("│   other")
  f = await keys(s, "down")
  expect(f).toContain("▌ stock  linked from here")
  f = await keys(s, "down") // held at the last
  expect(f).toContain("▌ stock  linked from here")
  f = await keys(s, "up", "down", "tab")
  expect(pillOf(f)).toContain(" Slow broth   stock ")
  expect(pillOf(f)).not.toContain("simmering")
  expect(pillOf(f)).toContain("⠳⢆ and ▍")
})

test("six notes at most: at six, [[ toasts and opens no list; nothing more is added", async () => {
  aiConfig(OLLAMA)
  const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
  const files = Object.fromEntries(names.map((n) => [`${n}.md`, `# ${n}\n\n${n} text.\n`]))
  const { s, ai } = await mountAI(tmp({ "Slow broth.md": NOTE, ...files }), "Slow broth.md")
  await keys(s, "c")
  for (const n of names.slice(0, 5)) await keys(s, `type:[[${n.slice(0, 4)}`, "enter")
  const f = await keys(s, "type:[[")
  expect(f).toContain("6 notes at most")
  expect(f).not.toContain("▌") // no list
  expect(hints(f)).toContain("esc hide") // the input's footer, not the list's
  await keys(s, "C-u", "type:q", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  const system = ai.calls[0]!.body.messages[0]!.content
  expect(system).toContain('<note id="6" title="echo">')
  expect(system).not.toContain('<note id="7"')
  expect(system).not.toContain("foxtrot")
})

test("a note over 24k characters: `clipped` on its chip, the system text cut", async () => {
  aiConfig({ ...OLLAMA, maxChars: 100_000 })
  const { s, ai } = await mountAI(tmp({ "Slow broth.md": NOTE + "x ".repeat(13_000) }), "Slow broth.md")
  const f = await keys(s, "c")
  expect(f).toContain("Slow broth · clipped")
  await keys(s, "type:q", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  expect(ai.calls[0]!.body.messages[0]!.content).toContain("[truncated]")
})

test("a cite in another note: ⏎ opens it; H returns with the pill still folded", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(tmp(LINKED), "Slow broth.md")
  await keys(s, "c", "type:[[sim", "enter", "type:why?", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, 'Keep it low [1].\nSources:\n[1] note 2: "Keep it below a boil"')
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  let f = await keys(s, "enter")
  expect(f.split("\n")[0]).toContain("simmering")
  expect(f).toContain("1 of 1")
  f = await keys(s, "H")
  expect(f.split("\n")[0]).toContain("Slow broth")
  expect(f).toContain("1 of 1")
})

test("folded on a cite in another note, [[ still lists what the thread's note links to", async () => {
  aiConfig(OLLAMA)
  const d = tmp({
    "Slow broth.md": `${NOTE}\nSee [[simmering]] and [[stock]].\n`,
    "simmering.md": "# Simmering\n\nKeep it below a boil.\n",
    "stock.md": "# Stock\n\nBones.\n",
  })
  const { s, ai } = await mountAI(d, "Slow broth.md")
  await keys(s, "c", "type:[[sim", "enter", "type:why?", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, 'Keep it low [1].\nSources:\n[1] note 2: "Keep it below a boil"')
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  await keys(s, "enter") // simmering is open now; it links to nothing
  const f = await keys(s, "c", "type:[[")
  expect(f).toContain("▌ stock  linked from here")
})

test("piped: the thread is keyed on stdin and [[ lists the notes of the cwd", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "simmering.md": "# Simmering\n\nLow.\n" })
  const { s } = await mountAI(d, undefined, { stdin: NOTE })
  const f = await keys(s, "c", "type:[[sim")
  expect(f).toContain("▌ simmering")
  expect(pillOf(await keys(s, "enter"))).toContain(" simmering ")
})

// ------------------------------------------------------------- folded on a cite

/** The backgrounds of the page's spans holding `word` (the pill's `“quote”` left out). */
const bgOf = (s: Awaited<ReturnType<typeof asked>>["s"], word: string) =>
  s
    .captureSpans()
    .lines.flatMap((l) => l.spans)
    .filter((sp) => sp.text.includes(word) && !sp.text.includes("“"))
    .map((sp) => hex(sp.bg))

test("⏎ on ¹ folds onto it: no card, the pill holds the cite, its row on screen with ¹ in the gutter, the chatLanded footer", async () => {
  const long = NOTE.replace("## Strain", `${"filler\n\n".repeat(30)}## Strain`)
  const { s, ai } = await asked("why?", { "Slow broth.md": long })
  ai.send(0, REPLY)
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  const f = await keys(s, "enter")
  expect(f).toContain("¹ “do not press the bones”")
  expect(f).toContain("1 of 1")
  expect(f).not.toContain("go to") // the card is gone
  const row = f.split("\n").find((r) => r.includes("do not press the bones:"))
  expect(row).toMatch(/¹ +Pour the broth/)
  expect(hints(f)).toContain("[ ] marks")
  expect(hints(f)).toContain("c answer")
  // the quote is tinted (motion off: the full tint), the text before it is not; the page is not dimmed
  expect(bgOf(s, "do not press the bones")).toEqual([B.backgroundElement])
  expect(bgOf(s, "Pour the broth")).not.toContain(B.backgroundElement)
  expect(hex(spansOf(s).find((sp) => sp.text.includes("Pour the broth"))!.fg)).toBe(B.text)
})

test("the tint and the mark follow the fold as the view scrolls", async () => {
  const long = `${NOTE.replace("## Strain", `${"filler\n\n".repeat(30)}## Strain`)}\n${"after\n\n".repeat(30)}`
  const { s, ai } = await asked("why?", { "Slow broth.md": long })
  ai.send(0, REPLY)
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  await keys(s, "enter")
  const f = await keys(s, "k", "k")
  expect(f).toContain("1 of 1") // moving the view keeps the fold
  expect(f.split("\n").find((r) => r.includes("do not press the bones:"))).toMatch(/¹ +Pour the broth/)
  expect(bgOf(s, "do not press the bones")).toEqual([B.backgroundElement])
})

test("in Source, a quote wrapping across two source lines lands and tints its text, not the line numbers", async () => {
  const two =
    "# Slow broth\n\nIntro line.\n\n## Strain and cool\n\nPour the broth through a sieve;\ndo not press the bones.\n"
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(tmp({ "Slow broth.md": two }), "Slow broth.md")
  await keys(s, "s", "c", "type:why?", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, 'Gently [1].\nSources:\n[1] note 1: "a sieve; do not press"')
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  const f = await keys(s, "enter")
  expect(f).toContain("1 of 1")
  expect(f).not.toContain("quote no longer in the note")
  const tinted = s
    .captureSpans()
    .lines.map((l) =>
      l.spans
        .filter((sp) => hex(sp.bg) === B.backgroundElement)
        .map((sp) => sp.text)
        .join(""),
    )
    .filter(Boolean)
  expect(tinted).toEqual(["a sieve;", "do not press"])
  expect(f.split("\n").find((r) => r.includes("through a sieve;"))).toMatch(/¹ +7 +Pour the broth/)
})

test("a quote edited away lands on its section with a toast", async () => {
  const d = tmp({ "Slow broth.md": NOTE })
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(d, "Slow broth.md")
  await keys(s, "c", "type:why?", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, REPLY)
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  writeFileSync(join(d, "Slow broth.md"), NOTE.replace("do not press the bones", "leave the bones"))
  await waitFrame(s, (x) => x.includes("leave the bones"))
  const f = await keys(s, "enter") // the card still has the keys: ⏎ on the selected ¹
  expect(f).toContain("quote no longer in the note")
  expect(f).toContain("1 of 1") // folded all the same, on the section
  expect(f).toContain("Strain and cool")
  expect(bgOf(s, "leave the bones")).not.toContain(B.backgroundElement)
})

test("a cite in a chip's note deleted since: ⏎ toasts note gone and the card stays as it was", async () => {
  const d = tmp({ "Slow broth.md": NOTE, "Stock.md": "# Stock\n\nRoast the bones first.\n" })
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(d, "Slow broth.md")
  await keys(s, "c", "type:[[sto", "enter", "type:why?", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, 'Roast first [1].\nSources:\n[1] note 2: "Roast the bones first"')
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  rmSync(join(d, "Stock.md"))
  const f = await keys(s, "enter")
  expect(f).toContain("note gone")
  expect(f).toContain("Slow broth") // still on the thread's note
  expect(hints(f)).toContain("go to") // the card stays up with the keys
  expect(f).toContain("Stock › Stock · “Roast the bones first”")
})

test("[ ] step the folded cites; at the ends: last mark / first mark; esc hides", async () => {
  const { s, ai } = await asked()
  ai.send(0, 'A [1]. B [2].\nSources:\n[1] note 1: "do not press the bones"\n[2] note 1: "Intro line"')
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  let f = await keys(s, "enter", "]")
  expect(f).toContain("2 of 2")
  expect(f).toContain("² “Intro line”")
  expect(bgOf(s, "Intro line")).toEqual([B.backgroundElement])
  f = await keys(s, "]")
  expect(f).toContain("last mark")
  expect(f).toContain("2 of 2")
  f = await keys(s, "[", "[")
  expect(f).toContain("1 of 2")
  expect(f).toContain("first mark")
  f = await keys(s, "esc")
  expect(f).not.toContain("1 of 2")
  expect(hints(f)).not.toContain("[ ] marks")
  expect(bgOf(s, "do not press the bones")).not.toContain(B.backgroundElement)
})

test("folded: c brings the card back with the cite selected", async () => {
  const { s, ai } = await asked()
  ai.send(0, 'A [1]. B [2].\nSources:\n[1] note 1: "do not press the bones"\n[2] note 1: "Intro line"')
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  const f = await keys(s, "down", "enter", "c")
  expect(hints(f)).toContain("go to")
  expect(f).toMatch(/▌ ² /)
})

test("folded: z hides the pill; at 90 columns tab, 1 and ^b (the drawer) hide it too", async () => {
  const cases = [
    [undefined, "z"],
    [{ width: 90, height: 30 }, "tab"],
    [{ width: 90, height: 30 }, "1"],
    [{ width: 90, height: 30 }, "C-b"],
  ] as const
  for (const [size, key] of cases) {
    aiConfig(OLLAMA)
    const { s, ai } = await mountAI(tmp({ "Slow broth.md": NOTE }), "Slow broth.md", size ? { size } : {})
    await keys(s, "c", "type:why?", "enter")
    await waitFor(s, () => ai.calls.length === 1)
    ai.send(0, REPLY)
    ai.end(0)
    await waitFrame(s, (x) => x.includes("go to"))
    expect(await keys(s, "enter")).toContain("1 of 1")
    const f = await keys(s, key)
    expect(f).not.toContain("1 of 1")
    expect(f).not.toContain("do not press the bones”")
    s.renderer.destroy()
  }
})

test("motion on: the pill's border inks in from border to borderActive", async () => {
  aiConfig(OLLAMA)
  const s = await mount(tmp({ "Slow broth.md": NOTE }), "Slow broth.md", { motion: true })
  const corner = () => hex(spansOf(s).find((sp) => sp.text.startsWith("╭"))!.fg)
  // the clock held while c lands: the first frame is the ink's first step whatever the load
  setSystemTime(new Date())
  let first: string | null
  try {
    await keys(s, "c")
    first = corner()
  } finally {
    setSystemTime()
  }
  expect(first).toBe(B.border)
  // nothing else redraws within HINT_HOLD: only the pill's timer can bring the border to borderActive
  await waitFor(s, () => corner() === B.borderActive, 1500)
})

test("motion on: the folded cite's tint fades in from the page to the full tint", async () => {
  aiConfig(OLLAMA)
  const two =
    "# Slow broth\n\nIntro line.\n\n## Strain and cool\n\nPour the broth through a sieve;\ndo not press the bones.\n"
  const { s, ai } = await mountAI(tmp({ "Slow broth.md": two }), "Slow broth.md", { motion: true })
  await keys(s, "c", "type:why?", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, 'Sieve, not press [1].\nSources:\n[1] note 1: "through a sieve; do not press"')
  ai.end(0)
  await waitFrame(s, (x) => x.includes("go to"))
  await Bun.sleep(1100) // the marks' glow and the wait tick (on the whole second) are done: only the fold can redraw
  // the clock held while ⏎ folds: the tint's first step, the page's own colour
  setSystemTime(new Date())
  try {
    await keys(s, "enter")
    expect([...bgOf(s, "through a sieve;"), ...bgOf(s, "do not press")]).toEqual([B.background, B.background])
  } finally {
    setSystemTime()
  }
  await waitFor(s, () => bgOf(s, "do not press").includes(B.backgroundElement), 1500)
  expect(bgOf(s, "through a sieve;")).toEqual([B.backgroundElement])
})

test("the card's rows clear the text column: no note text beside the card, the rows above stay", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(tmp({ "long.md": `# Long\n\n${filler(60)}\n` }), "long.md", { size: W120 })
  await keys(s, "c", "type:why?", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Short answer.")
  ai.end(0)
  const f = await waitFrame(s, (x) => x.includes("Short answer."))
  const rows = f.split("\n")
  const top = rows.findIndex((r) => r.includes("╭"))
  expect(rows.slice(top, top + 8).filter((r) => r.includes("fill"))).toEqual([])
  expect(rows.slice(2, top).some((r) => r.includes("filler"))).toBe(true)
})
