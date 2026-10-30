// App: the a summary: the TL;DR block in Info.
import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { mix } from "../../src/theme/theme"
import { hex } from "../helpers/theme"
import {
  aiStub,
  B,
  keys,
  OLLAMA,
  openHelp,
  PRIMARY,
  type Setup,
  sleep,
  spansOf,
  useAppHarness,
  W120,
  waitFor,
  waitFrame,
  withEnv,
} from "./helpers"

const { cfgDir, tmp, mount, openNote, aiConfig, cached, seedSummary, mountAI } = useAppHarness()

/** The running head, the footer hints (the ghost line at 30 rows) and the TL;DR's closing rule. */
const head = (f: string) => f.split("\n")[0]!
const hints = (f: string, rows = 30) => f.split("\n")[rows - 2]!
const ruleRow = (f: string) => /─{4,16} +[^\s─━](?:\S| (?! ))*/.exec(f)?.[0] ?? ""
/** fg of the first span on row 0 holding `text`. */
const headFg = (s: Setup, text: string) =>
  hex(s.captureSpans().lines[0]!.spans.find((sp) => sp.text.includes(text))!.fg)
/** outdated and regenerating TL;DR text: textMuted dimmed toward the background */
const DIMMED = mix(B.textMuted, B.background, 0.4)

test("a without an ai block toasts AI off and opens Info", async () => {
  const d = tmp({ "a.md": "# A\n\nText.\n" })
  const s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  const f = await keys(s, "a")
  expect(f).toContain(`AI off · set "ai" in config.json`)
  expect(f).toContain("words")
  expect(f).not.toContain("TL;DR")
})

test("a on a note with only front matter and comments: nothing to summarize", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "---\ntitle: x\n---\n%%hidden%%\n" })
  const s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  expect(await keys(s, "a")).toContain("nothing to summarize")
})

test("Info shows a TL;DR block from the cache: none, fresh, outdated", async () => {
  aiConfig({ provider: "openrouter", model: "anthropic/claude-haiku-5-5" })
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  let s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  let f = await keys(s, "3")
  expect(f).toContain("* a summarize this note")
  expect(head(f)).not.toContain("a*")
  s.renderer.destroy()

  seedSummary(join(d, "a.md"), "About apples.", undefined, "anthropic/claude-haiku-5-5")
  s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  f = await keys(s, "3")
  expect(ruleRow(f)).toEndWith("TL;DR · claude-haiku-5-5")
  expect(f).toContain("* About apples.")
  expect(head(f)).toContain("a*")
  expect(headFg(s, "*")).toBe(PRIMARY)
  s.renderer.destroy()

  seedSummary(join(d, "a.md"), "About apples.", "stale")
  s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  f = await keys(s, "3")
  expect(ruleRow(f)).toEndWith("edited since · a refresh")
  expect(f).not.toContain("TL;DR ·")
  expect(headFg(s, "*")).toBe(B.textMuted)
})

test("no TL;DR block when AI is off, even with a cached summary", async () => {
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "About apples.")
  const s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  const f = await keys(s, "3")
  expect(f).not.toContain("About apples.")
  expect(f).not.toContain("TL;DR")
  expect(head(f)).not.toContain("a*")
})

test("the a summarize footer hint shows only when an ai block is configured", async () => {
  const d = tmp({ "a.md": "# A\n\nText.\n" })
  let s = await mount(d, "a.md", { size: { width: 160, height: 30 } })
  expect(await keys(s, "3")).not.toContain("summarize")
  s.renderer.destroy()
  aiConfig(OLLAMA)
  s = await mount(d, "a.md", { size: { width: 160, height: 30 } })
  expect(hints(await keys(s, "3"))).toContain("a summarize")
})

test("r re-reads the ai block: the a hint appears after adding and goes after removal", async () => {
  const d = tmp({ "a.md": "# A\n\nText.\n" })
  const s = await mount(d, "a.md", { size: { width: 140, height: 30 } })
  expect(await keys(s, "3")).not.toContain("a summarize")
  aiConfig(OLLAMA)
  expect(await keys(s, "r")).toContain("a summarize")
  writeFileSync(join(cfgDir, "brothy", "config.json"), "{}")
  expect(await keys(s, "r")).not.toContain("a summarize")
})

test("a in zen without an ai block: AI off", async () => {
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  const s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  expect(await keys(s, "z", "a")).toContain(`AI off · set "ai" in config.json`)
})

test("typing a into the Files filter filters, it doesn't summarize", async () => {
  const d = tmp({ "a.md": "# A\n", "b.md": "# B\n" })
  const s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  const f = await keys(s, "1", "/", "type:a")
  expect(f).not.toContain("AI off")
})

test("help lists a in the AI group, not under Global", async () => {
  const d = tmp({ "a.md": "# A\n" })
  const s = await mount(d, "a.md", { size: { width: 120, height: 40 } })
  const lines = (await openHelp(s)).split("\n")
  const at = lines.findIndex((l) => l.includes("summarize the note (Info tab)"))
  const ai = lines.findIndex((l) => / {2}AI {2}/.test(l))
  expect(ai).toBeGreaterThan(0)
  expect(at).toBe(ai + 1)
  expect(lines[at]!.slice(lines[ai]!.indexOf("AI"))).toStartWith("a ") // the key under the chip, whatever the left column holds
})

test("a streams the summary into Info, then caches it; a second run shows it without a request", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "---\ntitle: A\n---\n# A\n\nSome text about apples.\n%%private%%\n" })
  const ai = aiStub()
  let s = await mount(d, "a.md", { size: W120, fetch: ai.f })
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  expect(ai.calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions")
  expect(ai.calls[0]!.body.messages[1]!.content).toBe("# A\n\nSome text about apples.")
  await waitFrame(s, (f) => f.includes("* ▍") && f.includes("asking llama3.2"))
  ai.send(0, "Apples are ")
  await waitFrame(s, (f) => f.includes("* Apples are▍") && f.includes("llama3.2 · a cancel"))
  ai.send(0, "discussed.")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("TL;DR · llama3.2") && f.includes("Apples are discussed."))
  expect(Object.values(cached()).map((e) => e.summary)).toEqual(["Apples are discussed."])
  s.renderer.destroy()

  const again = aiStub()
  s = await mount(d, "a.md", { size: W120, fetch: again.f })
  expect(await keys(s, "3")).toContain("Apples are discussed.")
  expect(again.calls.length).toBe(0)
})

test("regenerating keeps the old summary dimmed under the caret until the first new token", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "Old summary.")
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  expect(await keys(s, "3")).toContain("* Old summary.")
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  const f = await keys(s)
  expect(f).toContain("* ▍")
  expect(f).toContain("  Old summary.")
  expect(hex(spansOf(s).find((sp) => sp.text.includes("Old summary."))!.fg)).toBe(DIMMED)
  ai.send(0, "Fresh one.")
  ai.end(0)
  await waitFrame(s, (fr) => fr.includes("TL;DR · llama3.2") && fr.includes("* Fresh one.") && !fr.includes("Old"))
})

test("editing the note marks its summary outdated", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "About apples.")
  const s = await mount(d, "a.md", { size: W120 })
  expect(await keys(s, "3")).toContain("TL;DR · llama3.2")
  writeFileSync(join(d, "a.md"), "# A\n\nPears now.\n")
  await waitFrame(s, (f) => f.includes("edited since · a refresh"), 4000)
})

test("a live reload mid-stream completes as outdated", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "About apples.")
  writeFileSync(join(d, "a.md"), "# A\n\nPears now.\n")
  await waitFrame(s, (f) => f.includes("Pears now."), 4000)
  ai.end(0)
  await waitFrame(s, (f) => f.includes("edited since · a refresh") && f.includes("About apples."))
})

test("switching notes mid-stream caches the summary for the original note", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n", "b.md": "# B\n\nBananas.\n" })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  await openNote(s, "b")
  await waitFrame(s, (f) => f.includes("Bananas."))
  ai.send(0, "About apples.")
  ai.end(0)
  await waitFor(s, () => Object.keys(cached()).some((p) => p.endsWith("a.md")))
  expect(Object.keys(cached()).some((p) => p.endsWith("b.md"))).toBe(false)
  await openNote(s, "a")
  expect(await keys(s, "3")).toContain("About apples.")
})

test("a again mid-stream cancels: nothing cached, the previous summary shows again", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "Old summary.", "stale")
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "New partial")
  await waitFrame(s, (f) => f.includes("New partial"))
  const f = await keys(s, "a")
  expect(f).toContain("summary cancelled")
  await waitFrame(s, (fr) => fr.includes("Old summary.") && !fr.includes("New partial"))
  expect(Object.values(cached()).map((e) => e.summary)).toEqual(["Old summary."])
})

test("a 4th concurrent request is refused: AI busy", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nA.\n", "b.md": "# B\n\nB.\n", "c.md": "# C\n\nC.\n", "e.md": "# E\n\nE.\n" })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  await keys(s, "a")
  for (const n of ["b", "c"]) {
    await openNote(s, n)
    await keys(s, "a")
  }
  await waitFor(s, () => ai.calls.length === 3)
  await openNote(s, "e")
  expect(await keys(s, "a")).toContain("AI busy · 3 requests running")
  expect(ai.calls.length).toBe(3)
})

test("a failure for a note that isn't current names it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "apples.md": "# A\n\nApples.\n", "b.md": "# B\n\nBananas.\n" })
  const { s, ai } = await mountAI(d, "apples.md", { size: W120 })
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  await openNote(s, "b")
  ai.fail(0, "model overloaded")
  await waitFrame(s, (f) => f.includes("AI · apples: model overloaded"))
  expect(cached()).toEqual({})
})

test("a preset without its key env var toasts which one to set", async () => {
  aiConfig({ provider: "openrouter", model: "x/y" })
  await withEnv({ OPENROUTER_API_KEY: undefined }, async () => {
    const d = tmp({ "a.md": "# A\n\nApples.\n" })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    expect(await keys(s, "a")).toContain("AI: set OPENROUTER_API_KEY")
    expect(ai.calls.length).toBe(0)
  })
})

// the study's 62-word reply: 12 rows in a 30-column Info
const BROTH =
  "A good broth takes patience: bones and cold water held where the surface barely moves, never a rolling boil. Chicken simmers for 3 to 4 hours, beef for 8 to 12 and fish for only 45 minutes before it turns bitter. Skim the grey foam in the first hour, keep the fat, and salt only at the end, since the pot reduces."

test("a 62-word TL;DR shows whole; a longer one stops at 14 rows, and ⏎ on its rule expands and collapses it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), BROTH)
  let { s, ai } = await mountAI(d, "a.md", { size: { width: 120, height: 32 } })
  let f = await keys(s, "3")
  expect(f).toContain("pot reduces.")
  expect(ruleRow(f)).toEndWith("TL;DR · llama3.2")
  s.renderer.destroy()

  seedSummary(join(d, "a.md"), Array.from({ length: 120 }, (_, i) => `w${i}`).join(" "))
  ;({ s, ai } = await mountAI(d, "a.md", { size: { width: 120, height: 32 } }))
  f = await keys(s, "3")
  expect(ruleRow(f)).toEndWith("⏎ more · llama3.2")
  expect(f).not.toContain("w119")
  f = await keys(s, "enter")
  expect(f).toContain("w119") // the list follows the cursor down to the rule
  expect(ruleRow(f)).toEndWith("⏎ less · llama3.2")
  f = await keys(s, "enter")
  expect(f).not.toContain("w119")
  expect(ruleRow(f)).toEndWith("⏎ more · llama3.2")
  expect(ai.calls.length).toBe(0)
})

test("waiting: the caret row at once, the seconds from 1 s, and nothing below moves when the first token lands", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "---\ntitle: A\n---\n# A\n\nApples.\n" })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  const rowOf = (f: string) => f.split("\n").findIndex((r) => r.includes(" title "))
  const first = await keys(s, "a")
  expect(first).toContain("* ▍")
  expect(ruleRow(first)).toEndWith("asking llama3.2")
  expect(head(first)).not.toContain("A*")
  await waitFor(s, () => ai.calls.length === 1)
  const later = await waitFrame(s, (f) => ruleRow(f).endsWith("asking llama3.2 · 1 s"), 2500)
  expect(rowOf(later)).toBe(rowOf(first))
  ai.send(0, "Apples.")
  const live = await waitFrame(s, (f) => f.includes("* Apples.▍"))
  expect(rowOf(live)).toBe(rowOf(first))
  expect(live).not.toContain("asking")
})

test("regenerating an outdated TL;DR: the caret over the old text, replaced by the first token; a cancel brings it back", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "Old summary.", "stale")
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  let f = await keys(s, "a")
  expect(f).toContain("* ▍")
  expect(f).toContain("  Old summary.")
  expect(ruleRow(f)).toStartWith("─")
  expect(headFg(s, "*")).toBe(B.textMuted)
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "New")
  f = await waitFrame(s, (fr) => fr.includes("* New▍"))
  expect(f).not.toContain("Old summary.")
  f = await keys(s, "a")
  expect(f).toContain("summary cancelled")
  f = await waitFrame(s, (fr) => fr.includes("* Old summary.") && ruleRow(fr).endsWith("edited since · a refresh"))
  await sleep(50)
  expect(await keys(s)).not.toContain("TL;DR ready")
})

test("a failure stays in the block with a retry until a, another note or an edit clears it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n", "b.md": "# B\n\nBananas.\n" })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.fail(0, "model overloaded")
  let f = await waitFrame(s, (fr) => fr.includes("* ✗ model overloaded"))
  expect(ruleRow(f)).toEndWith("a retry")
  expect(f).toContain("AI: model overloaded")
  expect(head(f)).not.toContain("a*")
  // a retries: the error goes at once
  f = await keys(s, "a")
  expect(f).not.toContain("* ✗")
  await waitFor(s, () => ai.calls.length === 2)
  ai.fail(1, "still overloaded")
  await waitFrame(s, (fr) => fr.includes("* ✗ still overloaded"))
  await openNote(s, "b")
  await openNote(s, "a")
  expect(await keys(s, "3")).toContain("* a summarize this note")
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 3)
  ai.fail(2, "down")
  await waitFrame(s, (fr) => fr.includes("* ✗ down"))
  writeFileSync(join(d, "a.md"), "# A\n\nPears now.\n")
  await waitFrame(s, (fr) => fr.includes("Pears now.") && fr.includes("* a summarize this note"), 4000)
})

test("a failed regeneration keeps the old TL;DR dimmed under the error, the head mark muted", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "About apples.")
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.fail(0, "model overloaded")
  const f = await waitFrame(s, (fr) => fr.includes("* ✗ model overloaded"))
  expect(f).toContain("  About apples.")
  expect(hex(spansOf(s).find((sp) => sp.text.includes("About apples."))!.fg)).toBe(DIMMED)
  expect(headFg(s, "*")).toBe(B.textMuted)
  expect(Object.values(cached()).map((e) => e.summary)).toEqual(["About apples."])
})

test("a TL;DR that lands out of sight says so: Info hidden, or another note open; not when Info shows it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "apples.md": "# A\n\nApples.\n", "b.md": "# B\n\nBananas.\n" })
  let { s, ai } = await mountAI(d, "apples.md", { size: { width: 80, height: 24 } })
  await keys(s, "a", "esc") // a opens Info in the drawer; esc closes it
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Done.")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("TL;DR ready · 3 to read"))
  s.renderer.destroy()

  ;({ s, ai } = await mountAI(d, "apples.md", { size: W120 }))
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  await openNote(s, "b")
  ai.send(0, "Done.")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("TL;DR ready · apples"))
  s.renderer.destroy()

  ;({ s, ai } = await mountAI(d, "b.md", { size: W120 }))
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Done.")
  ai.end(0)
  const f = await waitFrame(s, (fr) => ruleRow(fr).endsWith("TL;DR · llama3.2"))
  expect(f).not.toContain("TL;DR ready")
})

test("the head's * shows a fresh TL;DR, not in zen; transparent draws the block the same", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "About apples.")
  const s = await mount(d, "a.md", { size: W120 })
  const f = await keys(s, "3")
  expect(head(f)).toContain("a*")
  const painted = ruleRow(f)
  expect(ruleRow(await keys(s, "T"))).toBe(painted)
  const bgOf = (text: string) => hex(spansOf(s).find((sp) => sp.text.includes(text))!.bg)
  expect(bgOf("TL;DR ·")).toBe(bgOf("words"))
  expect(head(await keys(s, "z"))).not.toContain("a*")
})
