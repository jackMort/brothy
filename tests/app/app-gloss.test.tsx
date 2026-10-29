// App: the zen gloss (a in zen).
import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { aiStub, HINT_ROW, keys, OLLAMA, panelShown, W120, waitFor, waitFrame, withEnv, useAppHarness } from "./helpers"

const { cfgDir, tmp, mount, aiConfig, glossFile, glossCache, seedGloss, mountAI } = useAppHarness()

const said = (w: string, n = 25) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ")
/** Four sections, each with 25 words of its own. */
const GLOSS_MD = ["Guide", "Apples", "Pears", "Plums"].map((h, i) => `${i ? "##" : "#"} ${h}\n\n${said(h.toLowerCase())}\n`).join("\n")

describe("a gloss on screen", () => {
  test("zen shows a fresh cached gloss for the reading section by itself, without a request", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    const f = await keys(s, "z")
    expect(f).toContain("┈ gloss · Guide ┈")
    expect(f).toContain("About the guide.")
    expect(ai.calls.length).toBe(0)
  })

  test("a section never glossed shows nothing; leaving fades the sheet; coming back shows it again", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const s = await mount(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).toContain("About the guide.")
    await keys(s, "]")
    await waitFrame(s, (f) => !f.includes("gloss ·"))
    expect(s.captureCharFrame()).not.toContain("About the guide.")
    expect(await keys(s, "[")).toContain("About the guide.")
  })

  test("an outdated gloss never shows by itself", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.", "stale")
    const s = await mount(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).not.toContain("gloss ·")
  })

  test("editing the glossed section marks the sheet outdated; editing another section keeps it fresh", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const p = join(d, "a.md")
    seedGloss(p, 0, "About the guide.")
    const s = await mount(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).toContain("gloss · Guide ┈")
    writeFileSync(p, GLOSS_MD.replace("pears3", "PEARS"))
    let f = await keys(s, "r")
    expect(f).toContain("gloss · Guide ┈")
    expect(f).not.toContain("outdated")
    writeFileSync(p, GLOSS_MD.replace("guide3", "GUIDE"))
    f = await keys(s, "r")
    expect(f).toContain("gloss · Guide · outdated · a")
    expect(f).toContain("About the guide.")
  })

  test("no gloss sheet without an ai block, even with a cached gloss", async () => {
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const s = await mount(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).not.toContain("gloss ·")
  })

  test("leaving zen hides the gloss; entering again shows it", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const s = await mount(d, "a.md", { size: W120 })
    await keys(s, "z")
    const f = await keys(s, "z")
    expect(panelShown(f)).toBe(true)
    expect(f).not.toContain("About the guide.")
    expect(await keys(s, "z")).toContain("About the guide.")
  })

  test("a small terminal keeps the reading line clear of the sheet", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const s = await mount(d, "a.md", { size: { width: 60, height: 14 } })
    const lines = (await keys(s, "z")).split("\n")
    const mark = lines.findIndex((l) => l.includes("▸"))
    const rule = lines.findIndex((l) => l.includes("gloss · Guide"))
    expect(mark).toBeGreaterThan(-1)
    expect(rule).toBeGreaterThan(mark)
  })

  test("a long gloss is cut to 3 rows ending in …", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, said("gloss", 60))
    const lines = (await keys(await mount(d, "a.md", { size: W120 }), "z")).split("\n")
    const rule = lines.findIndex((l) => l.includes("gloss · Guide"))
    expect(lines[rule + 3]!.trimEnd().endsWith("…")).toBe(true)
  })

  test("a in zen on a section with nothing in it: nothing to gloss here", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": "# A\n" })
    const s = await mount(d, "a.md", { size: W120 })
    expect(await keys(s, "z", "a")).toContain("nothing to gloss here")
  })

  test("esc hides the gloss and stays in zen; a shows the cached gloss again without a request; esc esc leaves zen", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).toContain("About the guide.")
    let f = await keys(s, "esc")
    expect(f).not.toContain("About the guide.")
    expect(panelShown(f)).toBe(false)
    expect(await keys(s, "a")).toContain("About the guide.")
    expect(ai.calls.length).toBe(0)
    await keys(s, "esc")
    f = await keys(s, "esc")
    expect(panelShown(f)).toBe(true)
  })

  test("an esc-hidden gloss stays hidden until the reading line leaves and comes back", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const s = await mount(d, "a.md", { size: W120 })
    await keys(s, "z", "esc")
    expect(await keys(s, "j")).not.toContain("About the guide.") // still in Guide
    await keys(s, "]")
    expect(await keys(s, "[")).toContain("About the guide.")
  })

  test("the a gloss hint shows in zen only with an ai block", async () => {
    const d = tmp({ "a.md": GLOSS_MD })
    let s = await mount(d, "a.md", { size: { width: 140, height: 30 } })
    expect((await keys(s, "z")).split("\n")[HINT_ROW]).not.toContain("a gloss")
    s.renderer.destroy()
    aiConfig(OLLAMA)
    s = await mount(d, "a.md", { size: { width: 140, height: 30 } })
    const row = (await keys(s, "z")).split("\n")[HINT_ROW]!
    expect(row).toContain("a gloss")
    expect(row.indexOf("[ ] section")).toBeLessThan(row.indexOf("a gloss"))
  })

  test("help lists the gloss under Zen and esc hides it", async () => {
    const d = tmp({ "a.md": "# A\n" })
    const s = await mount(d, "a.md", { size: { width: 90, height: 80 } }) // one column: the two-column sheet cuts long descriptions
    const lines = (await keys(s, "?")).split("\n")
    const at = lines.findIndex((l) => l.includes("gloss: explain the section you're reading"))
    const zen = lines.findIndex((l) => /\bZen\b/.test(l))
    expect(zen).toBeGreaterThan(lines.findIndex((l) => l.includes("Document")))
    expect(at).toBeGreaterThan(zen)
    expect(lines.some((l) => l.includes("clear find · hide gloss · leave zen"))).toBe(true)
  })
})

describe("asking for a gloss", () => {
  test("a outside zen is still the TL;DR", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    const f = await keys(s, "a")
    await waitFor(s, () => ai.calls.length === 1)
    expect(ai.calls[0]!.body.messages[0]!.content).not.toStartWith("Explain this section")
    expect(f).toContain("summarizing")
    expect(f).not.toContain("gloss")
  })

  test("a in zen streams a gloss for the reading section, caches it; a second run shows it without a request", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const ai = aiStub()
    let s = await mount(d, "a.md", { size: W120, fetch: ai.f })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    const msgs = ai.calls[0]!.body.messages
    expect(msgs[0]!.content).toStartWith("Explain this section of a note to its reader")
    expect(msgs[1]!.content).toBe(`Note: a\nSection: Guide\n\n${said("guide")}`)
    await waitFrame(s, (f) => f.includes("gloss · Guide · explaining…"))
    ai.send(0, "The guide ")
    await waitFrame(s, (f) => f.includes("The guide"))
    ai.send(0, "introduces fruit.")
    ai.end(0)
    await waitFrame(s, (f) => f.includes("The guide introduces fruit.") && !f.includes("explaining…"))
    expect(Object.values(glossCache()).map((e) => e.gloss)).toEqual(["The guide introduces fruit."])
    s.renderer.destroy()

    const ai2 = aiStub()
    s = await mount(d, "a.md", { size: W120, fetch: ai2.f })
    expect(await keys(s, "z")).toContain("The guide introduces fruit.")
    expect(ai2.calls.length).toBe(0)
  })

  test("a while the gloss streams cancels it: nothing cached, the sheet closes", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    ai.send(0, "Half")
    const f = await keys(s, "a")
    expect(f).toContain("gloss cancelled")
    expect(f).not.toContain("gloss · Guide")
    expect(ai.calls[0]!.signal?.aborted).toBe(true)
    expect(glossCache()).toEqual({})
  })

  test("a on a gloss already on screen regenerates it", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "Old gloss.")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).toContain("Old gloss.")
    await keys(s, "a")
    await waitFor(s, () => ai.calls.length === 1)
    await waitFrame(s, (f) => f.includes("gloss · Guide · explaining…"))
  })

  test("a on an outdated gloss sends a new request", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "Old gloss.", "stale")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
  })

  test("a 4th concurrent AI request is refused: AI busy · 3 requests running", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a", "]", "a", "]", "a", "]")
    await waitFor(s, () => ai.calls.length === 3)
    expect(await keys(s, "a")).toContain("AI busy · 3 requests running")
    expect(ai.calls.length).toBe(3)
  })

  test("a failed gloss: error toast, the sheet closes, nothing cached", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    ai.fail(0, "model overloaded")
    await waitFrame(s, (f) => f.includes("AI: model overloaded") && !f.includes("gloss · Guide"))
    expect(glossCache()).toEqual({})
  })

  test("a failure for a section the reading line left names its heading", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    await keys(s, "]")
    ai.fail(0, "model overloaded")
    await waitFrame(s, (f) => f.includes("AI · Guide: model overloaded"))
  })

  test("moving on mid-stream: the gloss is cached for its own section and shows on coming back", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    await keys(s, "]")
    await waitFrame(s, (f) => !f.includes("gloss · Guide"))
    ai.send(0, "About the guide.")
    ai.end(0)
    await waitFor(s, () => Object.keys(glossCache()).length === 1)
    expect(s.captureCharFrame()).not.toContain("About the guide.") // Apples is under the reading line
    expect(await keys(s, "[")).toContain("About the guide.")
  })

  test("a gloss's model error mentions the gloss, not a summary", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    ai.end(0) // a stream with no text
    await waitFrame(s, (f) => f.includes("AI: empty gloss"))
  })

  test("a gloss without the preset's key env var toasts which one to set", async () => {
    aiConfig({ provider: "openrouter", model: "x/y" })
    await withEnv({ OPENROUTER_API_KEY: undefined }, async () => {
      const d = tmp({ "a.md": GLOSS_MD })
      const { s, ai } = await mountAI(d, "a.md", { size: W120 })
      expect(await keys(s, "z", "a")).toContain("AI: set OPENROUTER_API_KEY")
      expect(ai.calls.length).toBe(0)
    })
  })

  test("a piped document's gloss shows for the run but is not written to glosses.json", async () => {
    aiConfig(OLLAMA)
    const d = tmp({})
    const { s, ai } = await mountAI(d, undefined, { size: W120, stdin: GLOSS_MD, linkScanDelay: 60_000 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    ai.send(0, "Piped gloss.")
    ai.end(0)
    await waitFrame(s, (f) => f.includes("Piped gloss.") && !f.includes("explaining…"))
    expect(existsSync(glossFile())).toBe(false)
  })

  test("a cancels a running gloss even after the ai block is gone", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    writeFileSync(join(cfgDir, "brothy", "config.json"), "{}")
    const f = await keys(s, "a")
    expect(f).toContain("gloss cancelled")
    expect(f).not.toContain("AI off")
    expect(ai.calls[0]!.signal?.aborted).toBe(true)
  })

  test("a cancels a running summary even after the ai block is gone", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": "# A\n\nText to summarize.\n" })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "a")
    await waitFor(s, () => ai.calls.length === 1)
    writeFileSync(join(cfgDir, "brothy", "config.json"), "{}")
    const f = await keys(s, "a")
    expect(f).toContain("summary cancelled")
    expect(f).not.toContain("AI off")
    expect(ai.calls[0]!.signal?.aborted).toBe(true)
  })
})
