// App: the a summary: the TL;DR block in Info.
import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { aiStub, keys, OLLAMA, openHelp, W120, waitFor, waitFrame, withEnv, useAppHarness } from "./helpers"

const { cfgDir, tmp, mount, openNote, aiConfig, cached, seedSummary, mountAI } = useAppHarness()

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
  expect(f).toContain("TL;DR")
  expect(f).toContain("a to summarize")
  s.renderer.destroy()

  seedSummary(join(d, "a.md"), "About apples.", undefined, "anthropic/claude-haiku-5-5")
  s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  f = await keys(s, "3")
  expect(f).toContain("TL;DR · claude-haiku-5-5")
  expect(f).toContain("About apples.")
  s.renderer.destroy()

  seedSummary(join(d, "a.md"), "About apples.", "stale")
  s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  expect(await keys(s, "3")).toContain("TL;DR · outdated · a")
})

test("no TL;DR block when AI is off, even with a cached summary", async () => {
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "About apples.")
  const s = await mount(d, "a.md", { size: { width: 120, height: 30 } })
  expect(await keys(s, "3")).not.toContain("TL;DR")
})

test("the a summarize footer hint shows only when an ai block is configured", async () => {
  const d = tmp({ "a.md": "# A\n\nText.\n" })
  let s = await mount(d, "a.md", { size: { width: 140, height: 30 } })
  expect(await keys(s, "3")).not.toContain("summarize")
  s.renderer.destroy()
  aiConfig(OLLAMA)
  s = await mount(d, "a.md", { size: { width: 140, height: 30 } })
  expect(await keys(s, "3")).toContain("a summarize")
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
  const ai = lines.findIndex((l) => /  AI  /.test(l))
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
  ai.send(0, "Apples are ")
  await waitFrame(s, (f) => f.includes("TL;DR · summarizing…") && f.includes("Apples are"))
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

test("regenerating hides the old summary until the first new token", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "Old summary.")
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  expect(await keys(s, "3")).toContain("Old summary.")
  await keys(s, "a")
  await waitFor(s, () => ai.calls.length === 1)
  const f = await keys(s)
  expect(f).toContain("TL;DR · summarizing…")
  expect(f).not.toContain("Old summary.")
  ai.send(0, "Fresh one.")
  ai.end(0)
  await waitFrame(s, (fr) => fr.includes("TL;DR · llama3.2") && fr.includes("Fresh one."))
})

test("editing the note marks its summary outdated", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nApples.\n" })
  seedSummary(join(d, "a.md"), "About apples.")
  const s = await mount(d, "a.md", { size: W120 })
  expect(await keys(s, "3")).toContain("TL;DR · llama3.2")
  writeFileSync(join(d, "a.md"), "# A\n\nPears now.\n")
  await waitFrame(s, (f) => f.includes("TL;DR · outdated · a"), 4000)
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
  await waitFrame(s, (f) => f.includes("TL;DR · outdated · a") && f.includes("About apples."))
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
