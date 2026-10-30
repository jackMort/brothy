// App: the zen gloss (a and A in zen): the footnote sheet, waiting, outdated notes, the dwell, margin notes.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mix } from "../../src/theme/theme"
import { DIM_OTHER } from "../../src/ui/footnote"
import { hex } from "../helpers/theme"
import {
  aiStub,
  B,
  HINT_ROW,
  keys,
  OLLAMA,
  panelShown,
  type Setup,
  sleep,
  spansOf,
  useAppHarness,
  W120,
  waitFor,
  waitFrame,
  withEnv,
} from "./helpers"

const { cfgDir, tmp, mount, aiConfig, glossFile, glossCache, seedGloss, mountAI } = useAppHarness()

const said = (w: string, n = 25) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ")
/** Four sections, each with 25 words of its own. */
const GLOSS_MD = ["Guide", "Apples", "Pears", "Plums"]
  .map((h, i) => `${i ? "##" : "#"} ${h}\n\n${said(h.toLowerCase())}\n`)
  .join("\n")
/** The row of the note's rule: exactly 16 `─` (the document's own rules and the progress line run longer). */
const ruleAt = (f: string) => f.split("\n").findIndex((l) => /^\s*─{16}(?!─)/.test(l))
/** The colour of the first span drawn as `text`. */
const fgOf = (s: Setup, text: string) => hex(spansOf(s).find((sp) => sp.text === text)!.fg)
/** Rewrite every cached gloss with `patch`. */
const patchCache = (patch: (e: Record<string, unknown>) => Record<string, unknown>) => {
  const all = JSON.parse(readFileSync(glossFile(), "utf8")) as Record<string, Record<string, unknown>>
  for (const k of Object.keys(all)) all[k] = patch(all[k]!)
  writeFileSync(glossFile(), JSON.stringify(all))
}

describe("a gloss on screen", () => {
  test("zen shows a fresh cached gloss for the reading section by itself, marked on its heading, without a request", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    const f = await keys(s, "z")
    expect(ruleAt(f)).toBeGreaterThan(-1)
    expect(f).toMatch(/Guide¹/)
    expect(f).toContain("¹ About the guide.")
    expect(f).not.toContain("gloss ·")
    expect(fgOf(s, "¹")).toBe(B.primary)
    expect(ai.calls.length).toBe(0)
  })

  test("a section never glossed shows nothing; leaving fades the note; coming back shows it again after a pause", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const s = await mount(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).toContain("About the guide.")
    await keys(s, "]")
    await waitFrame(s, (f) => ruleAt(f) < 0)
    expect(s.captureCharFrame()).not.toContain("About the guide.")
    expect(await keys(s, "[")).not.toContain("About the guide.") // the dwell: not at once
    await waitFrame(s, (f) => f.includes("About the guide."))
  })

  test("an outdated gloss shows by itself, dimmed, with its mark muted and how to refresh it", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.", "stale")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    const f = await keys(s, "z")
    expect(f).toContain("edited since · a refresh")
    expect(f).toContain("About the guide.")
    expect(fgOf(s, "¹")).toBe(B.textMuted)
    expect(ai.calls.length).toBe(0)
  })

  test("a gloss from an older prompt version says so", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    patchCache((e) => ({ ...e, v: 0 }))
    expect(await keys(await mount(d, "a.md", { size: W120 }), "z")).toContain("older version · a refresh")
  })

  test("editing the glossed section marks the note outdated; editing another section keeps it fresh", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const p = join(d, "a.md")
    seedGloss(p, 0, "About the guide.")
    const s = await mount(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).toContain("About the guide.")
    writeFileSync(p, GLOSS_MD.replace("pears3", "PEARS"))
    let f = await keys(s, "r")
    expect(f).toContain("About the guide.")
    expect(f).not.toContain("edited since")
    writeFileSync(p, GLOSS_MD.replace("guide3", "GUIDE"))
    f = await keys(s, "r")
    expect(f).toContain("edited since · a refresh")
    expect(f).toContain("About the guide.")
  })

  test("no gloss without an ai block, even with a cached one", async () => {
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const f = await keys(await mount(d, "a.md", { size: W120 }), "z")
    expect(ruleAt(f)).toBe(-1)
    expect(f).not.toContain("Guide¹")
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

  test("a small terminal keeps the reading line and the row under it clear of the sheet", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, said("gloss", 60))
    const s = await mount(d, "a.md", { size: { width: 60, height: 14 } })
    const lines = (await keys(s, "z")).split("\n")
    const mark = lines.findIndex((l) => l.includes("▸"))
    const rule = ruleAt(lines.join("\n"))
    expect(mark).toBeGreaterThan(-1)
    expect(rule).toBe(mark + 2) // the row under the reading line is the sheet's blank gap row
    expect(lines[rule - 1]!.trim()).toBe("")
    // gap, rule and 3 rows: 5 of the 11 body rows
    expect(lines.slice(rule + 1, rule + 4).every((l) => /gloss/.test(l))).toBe(true)
  })

  test("a long gloss is cut to 3 rows ending in …, and the rule offers more", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, said("gloss", 60))
    const lines = (await keys(await mount(d, "a.md", { size: W120 }), "z")).split("\n")
    const rule = ruleAt(lines.join("\n"))
    expect(lines[rule]!.trimEnd().endsWith("a more")).toBe(true)
    expect(lines[rule + 3]!.trimEnd().endsWith("…")).toBe(true)
    expect(lines[rule + 2]!.trimStart().startsWith("gloss")).toBe(true) // the hanging indent
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
    expect(f).not.toContain("Guide¹") // the mark goes with the note
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
    await keys(s, "]", "[")
    await waitFrame(s, (f) => f.includes("About the guide."))
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

  test("help lists a and A under Zen, and esc hides the gloss", async () => {
    const d = tmp({ "a.md": "# A\n" })
    const s = await mount(d, "a.md", { size: { width: 90, height: 80 } }) // one column: the two-column sheet cuts long descriptions
    const lines = (await keys(s, "?")).split("\n")
    const at = lines.findIndex((l) => l.includes("gloss: explain the section you're reading"))
    const again = lines.findIndex((l) => l.includes("gloss: ask again, replacing the cached one"))
    const zen = lines.findIndex((l) => /\bZen\b/.test(l))
    expect(zen).toBeGreaterThan(lines.findIndex((l) => l.includes("Document")))
    expect(at).toBeGreaterThan(zen)
    expect(again).toBeGreaterThan(zen)
    expect(lines[again]).toMatch(/\bA\b/)
    expect(lines.some((l) => l.includes("clear find · hide gloss · leave zen"))).toBe(true)
  })
})

describe("more, less and asking again", () => {
  test("a on a fresh gloss that overflows shows more, then less; esc hides it and it returns collapsed", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, said("gloss", 60))
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z")
    const tail = (f: string) => f.split("\n")[ruleAt(f)]!.trimEnd()
    let f = await keys(s, "a")
    expect(tail(f).endsWith("a less")).toBe(true)
    expect(f).toContain("gloss59")
    expect(ai.calls.length).toBe(0)
    f = await keys(s, "a")
    expect(tail(f).endsWith("a more")).toBe(true)
    expect(f).not.toContain("gloss59")
    await keys(s, "a", "esc")
    expect(tail(await keys(s, "a")).endsWith("a more")).toBe(true)
  })

  test("a on a fresh gloss that fits: nothing more · A asks again, no request", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z")
    expect(await keys(s, "a")).toContain("nothing more · A asks again")
    expect(ai.calls.length).toBe(0)
  })

  test("A on a gloss on screen asks again: the old text stays dimmed under the caret; A while it runs does nothing", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "Old gloss.")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).toContain("Old gloss.")
    await keys(s, "A")
    await waitFor(s, () => ai.calls.length === 1)
    const f = await waitFrame(s, (x) => x.includes("asking llama3.2") && x.includes("¹ ▍"))
    expect(f).toContain("  Old gloss.")
    expect(spansOf(s).some((sp) => sp.text === "¹" && hex(sp.fg) === B.textMuted)).toBe(true)
    await keys(s, "A")
    expect(ai.calls.length).toBe(1)
    ai.send(0, "New gloss.")
    ai.end(0)
    await waitFrame(s, (x) => x.includes("New gloss.") && !x.includes("Old gloss."))
  })

  test("A with no ai block: AI off; with nothing to gloss: nothing to gloss here", async () => {
    const d = tmp({ "a.md": GLOSS_MD, "b.md": "# B\n" })
    let s = await mount(d, "a.md", { size: W120 })
    expect(await keys(s, "z", "A")).toContain(`AI off · set "ai" in config.json`)
    s.renderer.destroy()
    aiConfig(OLLAMA)
    s = await mount(d, "b.md", { size: W120 })
    expect(await keys(s, "z", "A")).toContain("nothing to gloss here")
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
    expect(f).toContain("asking llama3.2")
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
    await waitFrame(s, (f) => f.includes("asking llama3.2") && f.includes("a cancel") && f.includes("¹ ▍"))
    ai.send(0, "The guide ")
    await waitFrame(s, (f) => f.includes("¹ The guide▍"))
    ai.send(0, "introduces fruit.")
    ai.end(0)
    await waitFrame(s, (f) => f.includes("The guide introduces fruit.") && !f.includes("a cancel"))
    expect(Object.values(glossCache()).map((e) => e.gloss)).toEqual(["The guide introduces fruit."])
    s.renderer.destroy()

    const ai2 = aiStub()
    s = await mount(d, "a.md", { size: W120, fetch: ai2.f })
    expect(await keys(s, "z")).toContain("The guide introduces fruit.")
    expect(ai2.calls.length).toBe(0)
  })

  test("waiting: a gap row, the rule, ¹ ▍ and the seconds from 1 s; they stop at the first token", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    let f = await waitFrame(s, (x) => x.includes("¹ ▍"))
    const lines = f.split("\n")
    const rule = ruleAt(f)
    expect(lines[rule - 1]!.trim()).toBe("")
    expect(lines[rule]!.trimEnd().endsWith("asking llama3.2 · a cancel")).toBe(true)
    expect(f).not.toContain("· 0 s")
    expect(f).toMatch(/Guide¹/)
    await waitFrame(s, (x) => x.includes("asking llama3.2 · 1 s · a cancel"), 2500)
    ai.send(0, "Some")
    f = await waitFrame(s, (x) => x.includes("¹ Some▍"))
    expect(f.split("\n")[ruleAt(f)]!.trimEnd().endsWith("a cancel")).toBe(true)
    expect(f).not.toContain("asking")
    await sleep(1100)
    expect(s.captureCharFrame()).not.toContain("asking")
  })

  test("streaming grows the sheet upward and shows the last 3 rows with the caret last; the end shows the head", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    ai.send(0, "start ")
    const one = ruleAt(await waitFrame(s, (f) => f.includes("¹ start")))
    ai.send(0, `${said("w", 40)} `)
    const three = ruleAt(await waitFrame(s, (f) => f.includes("w39")))
    expect(three).toBe(one - 2)
    ai.send(0, said("v", 30))
    const f = await waitFrame(s, (x) => x.includes("v29▍"))
    expect(ruleAt(f)).toBe(three)
    expect(f).not.toContain("¹ start")
    ai.end(0)
    const done = await waitFrame(s, (x) => x.includes("¹ start"))
    expect(done.split("\n")[ruleAt(done)]!.trimEnd().endsWith("a more")).toBe(true)
    expect(done).not.toContain("▍")
  })

  test("a reply past 400 characters keeps its finished sentences: cached, no error, the stream closed", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    const sentence = `${"word ".repeat(22).trim()}.` // 110 characters
    for (let i = 0; i < 4; i++) ai.send(0, `${sentence} `)
    await waitFor(s, () => Object.keys(glossCache()).length === 1)
    expect(Object.values(glossCache())[0]!.gloss).toBe([sentence, sentence, sentence].join(" "))
    expect(ai.calls[0]!.signal?.aborted).toBe(true)
    expect(s.captureCharFrame()).not.toContain("AI")
  })

  test("a while the gloss streams cancels it: nothing cached, the note and its mark gone", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    ai.send(0, "Half")
    const f = await keys(s, "a")
    expect(f).toContain("gloss cancelled")
    expect(f).not.toContain("¹")
    expect(ai.calls[0]!.signal?.aborted).toBe(true)
    expect(glossCache()).toEqual({})
  })

  test("a on an outdated gloss refreshes it; a failure keeps the old entry, which returns on re-entry", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "Old gloss.", "stale")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    ai.fail(0, "model overloaded")
    await waitFrame(s, (f) => f.includes("AI: model overloaded") && ruleAt(f) < 0)
    expect(Object.values(glossCache()).map((e) => e.gloss)).toEqual(["Old gloss."])
    await keys(s, "]", "[")
    await waitFrame(s, (f) => f.includes("Old gloss.") && f.includes("edited since"))
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

  test("a failed gloss: error toast, the note and its mark close, nothing cached", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    await keys(s, "z", "a")
    await waitFor(s, () => ai.calls.length === 1)
    ai.fail(0, "model overloaded")
    await waitFrame(s, (f) => f.includes("AI: model overloaded") && ruleAt(f) < 0 && !f.includes("Guide¹"))
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
    await waitFrame(s, (f) => ruleAt(f) < 0)
    ai.send(0, "About the guide.")
    ai.end(0)
    await waitFor(s, () => Object.keys(glossCache()).length === 1)
    expect(s.captureCharFrame()).not.toContain("About the guide.") // Apples is under the reading line
    await keys(s, "[")
    await waitFrame(s, (f) => f.includes("About the guide."))
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
    await waitFrame(s, (f) => f.includes("Piped gloss.") && !f.includes("a cancel"))
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

describe("the dwell and the heading mark", () => {
  test("skimming with ] shows no note on the way; the last section's shows after the pause", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const p = join(d, "a.md")
    seedGloss(p, 0, "About the guide.")
    seedGloss(p, 1, "About apples.")
    seedGloss(p, 2, "About pears.")
    const { s, ai } = await mountAI(d, "a.md", { size: W120 })
    expect(await keys(s, "z")).toContain("About the guide.") // entering zen: at once
    const f = await keys(s, "]", "]")
    expect(f).not.toContain("About apples.")
    expect(f).not.toContain("About pears.")
    await sleep(200)
    expect(s.captureCharFrame()).not.toContain("About pears.")
    await waitFrame(s, (x) => x.includes("About pears."))
    expect(s.captureCharFrame()).not.toContain("About apples.")
    expect(ai.calls.length).toBe(0)
  })

  test("a heading as wide as the measure carries its mark in the gutter", async () => {
    aiConfig(OLLAMA)
    const heading = "word ".repeat(14).trim() // 69 columns: the measure 72 holds it on one full row
    const d = tmp({ "a.md": `## ${heading}\n\n${said("text")}\n` })
    seedGloss(join(d, "a.md"), 0, "About it.")
    const f = await keys(await mount(d, "a.md", { size: W120 }), "z")
    expect(f).toContain("▸¹")
  })
})

describe("margin notes", () => {
  const W140 = { width: 140, height: 36 }
  const W160 = { width: 160, height: 40 }

  test("from 140 columns the note sits in the right margin beside its heading, no sheet at the bottom", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    const f = await keys(await mount(d, "a.md", { size: W140 }), "z")
    expect(ruleAt(f)).toBe(-1)
    const lines = f.split("\n")
    const row = lines.findIndex((l) => l.includes("Guide¹"))
    expect(lines[row]!.indexOf("¹ About the guide.")).toBe(109)
  })

  test("139 columns, or a wider measure at 140: the sheet", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    seedGloss(join(d, "a.md"), 0, "About the guide.")
    let s = await mount(d, "a.md", { size: { width: 139, height: 36 } })
    expect(ruleAt(await keys(s, "z"))).toBeGreaterThan(-1)
    s.renderer.destroy()
    s = await mount(d, "a.md", { size: W140 })
    await keys(s, "z")
    expect(ruleAt(await keys(s, ">"))).toBeGreaterThan(-1)
  })

  test("at 160 the section above with a fresh gloss shows too, dimmed and numbered first; each note ends before the next", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const p = join(d, "a.md")
    seedGloss(p, 0, said("guide", 30))
    seedGloss(p, 1, "About apples.")
    const s = await mount(d, "a.md", { size: W160 })
    await keys(s, "z", "]")
    const f = await waitFrame(s, (x) => x.includes("² About apples."))
    const lines = f.split("\n")
    const guide = lines.findIndex((l) => l.includes("Guide¹"))
    const apples = lines.findIndex((l) => l.includes("Apples²"))
    expect(lines[guide]!.indexOf("¹ guide0")).toBe(119)
    expect(lines[apples]!.indexOf("² About apples.")).toBe(119)
    expect(lines[apples - 1]!.slice(119).trim()).toBe("") // one empty row before the next note
    expect(fgOf(s, "¹")).toBe(mix(B.primary, B.background, DIM_OTHER))
    expect(fgOf(s, "²")).toBe(B.primary)
  })

  test("the reading note stays on the first row while its heading is scrolled above", async () => {
    aiConfig(OLLAMA)
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${said("x", 8)}`).join("\n\n")
    const d = tmp({ "a.md": `# Long\n\n${long}\n` })
    seedGloss(join(d, "a.md"), 0, "About the long one.")
    const s = await mount(d, "a.md", { size: W140 })
    await keys(s, "z")
    const f = await keys(s, ...Array.from({ length: 40 }, () => "j"))
    expect(f).not.toContain("Long¹")
    expect(f.split("\n")[2]!.indexOf("¹ About the long one.")).toBe(109)
  })

  test("an outdated neighbour is not drawn; esc hides the reading note and the neighbours stay", async () => {
    aiConfig(OLLAMA)
    const d = tmp({ "a.md": GLOSS_MD })
    const p = join(d, "a.md")
    seedGloss(p, 0, "About the guide.")
    seedGloss(p, 1, "About apples.")
    seedGloss(p, 2, "About pears.")
    patchCache((e) => (e.gloss === "About pears." ? { ...e, hash: "stale" } : e))
    const s = await mount(d, "a.md", { size: W160 })
    await keys(s, "z", "]")
    let f = await waitFrame(s, (x) => x.includes("About apples."))
    expect(f).toContain("About the guide.")
    expect(f).not.toContain("About pears.")
    f = await keys(s, "esc")
    expect(f).not.toContain("About apples.")
    expect(f).toContain("About the guide.")
  })
})
