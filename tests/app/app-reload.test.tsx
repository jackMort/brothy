// App: live reload and D: explaining what changed.
import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { DELTA_PROMPT } from "../../src/ai/delta"
import { bodyRows, keys, OLLAMA, openHelp, useAppHarness, W120, waitFor, waitFrame, withClock } from "./helpers"

const { cfgDir, tmp, mount, openNote, aiConfig, mountAI } = useAppHarness()

const TWO = "# A\n\n## One\n\nfirst\n\n## Two\n\nsecond\n"
const EDITED = "# A\n\n## One\n\nfirst, edited\n\n## Two\n\nsecond\n\n## Three\n\nthird\n"

const LONG =
  "# A\n\n## One\n\n" +
  Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n\n") +
  "\n\n## Two\n\nsecond\n\n## Three\n\nthird\n\n" +
  Array.from({ length: 30 }, (_, i) => `tail ${i}`).join("\n\n") +
  "\n" // room below Three, so its heading can reach the top

test("a live reload lists the changed sections in Info and counts them in the toast", async () => {
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { size: W120 })
  await keys(s, "3")
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("reloaded · 2 sections changed"), 4000)
  const f = s.captureCharFrame()
  expect(f).not.toContain("D explains") // no ai block
  expect(f).toMatch(/Changed · since \d\d:\d\d/)
  expect(f).toMatch(/~ One\s+\+1 −1/)
  expect(f).toMatch(/\+ Three\s+\+3/)
  expect(f).not.toMatch(/[~+] Two/)
})

test("with an ai block the reload toast names D", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("reloaded · 2 sections changed · D explains"), 4000)
})

test("saves add up against the text the note was opened with", async () => {
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), TWO.replace("first", "first!"))
  await waitFrame(s, (f) => f.includes("reloaded · 1 section changed"), 4000)
  writeFileSync(join(d, "a.md"), TWO.replace("first", "first!").replace("second", "second!"))
  await waitFrame(s, (f) => f.includes("reloaded · 2 sections changed"), 4000)
})

test("a properties-only change and an unchanged save", async () => {
  const d = tmp({ "a.md": "---\ntitle: x\n---\n" + TWO })
  const s = await mount(d, "a.md", { size: W120 })
  await keys(s, "3")
  writeFileSync(join(d, "a.md"), "---\ntitle: y\n---\n" + TWO)
  await waitFrame(s, (f) => f.includes("reloaded · properties changed"), 4000)
  expect(s.captureCharFrame()).not.toContain("Changed")
  writeFileSync(join(d, "a.md"), "---\ntitle: x\n---\n" + TWO + "\n\n")
  await waitFrame(s, (f) => f.includes("reloaded from disk"), 4000)
})

test("switching notes drops the change list; coming back starts from the text on disk", async () => {
  const d = tmp({ "a.md": TWO, "b.md": "# B\n" })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("2 sections changed"), 4000)
  await openNote(s, "b")
  expect(await keys(s, "3")).not.toContain("Changed")
  await openNote(s, "a")
  expect(await keys(s, "3")).not.toContain("Changed")
})

test("D streams an explanation of the changed hunks into Info; the baseline moves", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  const [system, user] = ai.calls[0]!.body.messages
  expect(system!.content).toBe(DELTA_PROMPT)
  expect(user!.content.startsWith("Note: a\n§1 edited · A › One\n@@\n")).toBe(true)
  expect(user!.content).toContain("+ first, edited")
  expect(user!.content).toContain("§2 added · A › Three")
  expect(user!.content).not.toContain("second") // unchanged sections are never sent
  expect(await keys(s)).toContain("Changed · explaining…")
  ai.send(0, "Rewords the first part and adds a third.\n§1: first line reworded")
  await waitFrame(s, (f) => f.includes("Rewords the first part"))
  ai.send(0, ' | "first, edited"\n§2: new closing section\n')
  ai.end(0)
  await waitFrame(
    s,
    (f) => f.includes("Changed · llama3.2") && f.includes("first line reworded") && f.includes("new closing section"),
  )
  expect(await keys(s, "D")).toMatch(/no changes since \d\d:\d\d/)
})

test("D mid-stream cancels; the list goes back to idle", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  const f = await keys(s, "D")
  expect(f).toContain("explanation cancelled")
  expect(f).toMatch(/Changed · since \d\d:\d\d/)
})

test("a reload mid-stream leaves the newer changes listed after completion", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  writeFileSync(join(d, "a.md"), EDITED.replace("first, edited", "first, edited twice"))
  await waitFrame(s, (f) => f.includes("first, edited twice"), 4000)
  ai.send(0, "Old summary.\n§1: reworded")
  ai.end(0)
  await waitFrame(s, (f) => /Changed · since \d\d:\d\d/.test(f) && /~ One/.test(f))
  const f = s.captureCharFrame()
  expect(f).not.toContain("Old summary.")
  expect(f).not.toMatch(/\+ Three/) // explained already: the baseline moved to the sent text
})

test("an explanation goes once a reload is too large to compare", async () => {
  aiConfig(OLLAMA)
  // five sections of 1000 lines: rewriting them all is over DIFF_BUDGET, editing one line is not
  const big = (v: (k: number, i: number) => string) =>
    Array.from(
      { length: 5 },
      (_, k) => `## S${k}\n\n` + Array.from({ length: 1000 }, (_, i) => v(k, i)).join("\n") + "\n",
    ).join("\n")
  const d = tmp({ "a.md": big((k, i) => `a${k}-${i}`) })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(
    join(d, "a.md"),
    big((k, i) => (k === 0 && i === 5 ? "edited" : `a${k}-${i}`)),
  )
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Rewords one line.\n§1: one line edited\n")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("Changed · llama3.2") && f.includes("Rewords one line."))
  writeFileSync(
    join(d, "a.md"),
    big((k, i) => `b${k}-${i}`),
  )
  await waitFrame(s, (f) => f.includes("reloaded · too large to compare"), 4000)
  const f = await keys(s)
  expect(f).not.toContain("Rewords one line.")
  expect(f).not.toContain("Changed")
})

test("a failed request: one error toast, the list stays", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.fail(0, "boom")
  await waitFrame(s, (f) => f.includes("AI: boom") && /Changed · since/.test(f))
})

test("a reply past MAX_DELTA keeps the summary and the finished section lines", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Rewords the first part.\n§1: first line reworded\n")
  await waitFrame(s, (f) => f.includes("first line reworded"))
  ai.send(0, "§2: " + "very ".repeat(500))
  await waitFrame(
    s,
    (f) =>
      f.includes("Changed · llama3.2") && f.includes("Rewords the first part.") && f.includes("first line reworded"),
  )
  const f = s.captureCharFrame()
  expect(f).not.toContain("too long")
  expect(f).not.toContain("very very")
})

test("a reply with nothing usable: AI: no usable explanation", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "§9: no such section")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("AI: no usable explanation"))
})

test("leaving the note mid-stream cancels and drops the list", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO, "b.md": "# B\n" })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  await openNote(s, "b")
  expect(ai.calls[0]!.signal?.aborted).toBe(true)
  await openNote(s, "a") // a fresh baseline from the text on disk: nothing listed
  expect(await keys(s, "3")).not.toContain("Changed")
  expect(await keys(s, "D")).toMatch(/no changes since/) // the cancelled job no longer counts or runs
})

test("D: AI off without an ai block; no changes without a reload", async () => {
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { size: W120 })
  expect(await keys(s, "D")).toContain(`AI off · set "ai" in config.json`)
  aiConfig(OLLAMA)
  expect(await keys(s, "D")).toMatch(/no changes since \d\d:\d\d/)
})

test("D in zen does nothing", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { size: W120 })
  const z = await keys(s, "z", "D")
  expect(z).not.toContain("no changes since")
  expect(z).not.toContain("AI off")
})

test("help lists D in the AI group; the Info footer shows D changes only with changes and AI", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { size: { width: 120, height: 40 } })
  const help = (await openHelp(s)).split("\n")
  const at = help.findIndex((l) => l.includes("explain what changed on disk"))
  const ai = help.findIndex((l) => / {2}AI {2}/.test(l))
  expect(ai).toBeGreaterThan(help.findIndex((l) => l.includes("Document")))
  expect(at).toBeGreaterThan(ai)
  expect(help[at]!.indexOf("D ")).toBe(help[ai]!.indexOf("AI"))
  await keys(s, "esc")
  expect((await keys(s, "3")).split("\n")[38]).not.toContain("D changes")
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await withClock(new Date(Date.now() + 10_000), async () => {
    // past the toast, so the hints get the whole line
    expect((await keys(s, "tab", "3")).split("\n")[38]).toContain("D changes")
  })
})

test("⏎ on a change row jumps to its heading; removed rows are skipped", async () => {
  const d = tmp({ "a.md": LONG })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(
    join(d, "a.md"),
    LONG.replace("row 3\n", "row 3 edited\n").replace("## Two\n\nsecond\n\n", "").replace("third", "third!"),
  )
  await waitFrame(s, (f) => f.includes("3 sections changed"), 4000)
  await keys(s, "3")
  // rows: ~ One (stop), − Two (not a stop), ~ Three (stop): j goes from One straight to Three
  const f = await keys(s, "j", "enter")
  expect(bodyRows(f).split("\n")[0]).toContain("Three")
})

test("⏎ after D lands on the quoted line", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": LONG })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), LONG.replace("row 40\n", "row 40 changed now\n"))
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, 'One line changed.\n§1: row forty reworded | "row 40 changed now"\n')
  ai.end(0)
  await waitFrame(s, (f) => f.includes("row forty reworded"))
  const f = await keys(s, "enter")
  expect(bodyRows(f).split("\n").slice(0, 3).join("\n")).toContain("row 40 changed now")
  // Source: the same row by its raw text
  const src = await keys(s, "s", "3", "enter")
  expect(bodyRows(src).split("\n").slice(0, 3).join("\n")).toContain("row 40 changed now")
})

test("jump finds the heading again when it moved", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": LONG })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), LONG.replace("third", "third!"))
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  // mid-request a new section lands above: Three's outline index shifts by one
  writeFileSync(join(d, "a.md"), LONG.replace("## One", "## Zero\n\nz\n\n## One").replace("third", "third!"))
  await waitFrame(s, (f) => f.includes("Zero"), 4000)
  const f = await keys(s, "3", "enter") // loading rows: the sent list, one stop (Three)
  expect(bodyRows(f).split("\n")[0]).toContain("Three")
})

test("D cancels a running explanation even after the ai block is gone", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  writeFileSync(join(cfgDir, "brothy", "config.json"), "{}")
  const f = await keys(s, "D")
  expect(f).toContain("explanation cancelled")
  expect(ai.calls[0]!.signal?.aborted).toBe(true)
})
