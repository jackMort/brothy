// App: live reload and D: explaining what changed.
import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { DELTA_PROMPT } from "../../src/ai/delta"
import { hex } from "../helpers/theme"
import {
  B,
  bodyRows,
  filler,
  keys,
  OLLAMA,
  openHelp,
  useAppHarness,
  W120,
  waitFor,
  waitFrame,
  withClock,
} from "./helpers"

const { cfgDir, tmp, mount, openNote, aiConfig, mountAI } = useAppHarness()

const TWO = "# A\n\n## One\n\nfirst\n\n## Two\n\nsecond\n"
const EDITED = "# A\n\n## One\n\nfirst, edited\n\n## Two\n\nsecond\n\n## Three\n\nthird\n"

/** The panel's column at 120 columns: each row's first 34 cells, trailing blanks dropped. */
const info = (f: string) =>
  f
    .split("\n")
    .map((l) => l.slice(0, 34).trimEnd())
    .join("\n")

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
  await waitFrame(s, (f) => f.includes("reloaded · ² sections changed"), 4000)
  const f = s.captureCharFrame()
  expect(f).not.toContain("D explains") // no ai block
  expect(info(f)).toMatch(/Changed since \d\d:\d\d\n/) // and no D explain at its right end
  expect(f).toMatch(/¹ One\s+\+1 −1/)
  expect(f).toMatch(/² Three\s+new/)
  expect(f).not.toMatch(/[¹²³] Two/)
})

test("with an ai block the reload toast names D", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("reloaded · ² sections changed · D explains"), 4000)
})

test("saves add up against the text the note was opened with", async () => {
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), TWO.replace("first", "first!"))
  await waitFrame(s, (f) => f.includes("reloaded · ¹ section changed"), 4000)
  writeFileSync(join(d, "a.md"), TWO.replace("first", "first!").replace("second", "second!"))
  await waitFrame(s, (f) => f.includes("reloaded · ² sections changed"), 4000)
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
  await waitFrame(s, (f) => f.includes("² sections changed"), 4000)
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
  expect(system!.content).toContain("at most 8 words")
  expect(user!.content.startsWith("Note: a\n§1 edited · A › One\n@@\n")).toBe(true)
  expect(user!.content).toContain("+ first, edited")
  expect(user!.content).toContain("§2 added · A › Three")
  expect(user!.content).not.toContain("second") // unchanged sections are never sent
  const waiting = await keys(s)
  expect(waiting).toMatch(/Changed since \d\d:\d\d\s+D cancel/)
  expect(info(waiting)).toMatch(/Changed since[^\n]*\n {2}▍ asking llama3.2\n/) // right under the label, no `· 0 s`
  ai.send(0, "Rewords the first part and adds a third.\n§1: first line reworded")
  await waitFrame(s, (f) => f.includes("Rewords the first part"))
  expect(s.captureCharFrame()).not.toContain("asking llama3.2") // the first token takes the row
  ai.send(0, ' | "first, edited"\n§2: new closing section\n')
  ai.end(0)
  const done = await waitFrame(
    s,
    (f) =>
      /Changed since \d\d:\d\d · llama3.2/.test(f) &&
      f.includes("first line reworded") &&
      f.includes("new closing section"),
  )
  expect(info(done)).not.toContain("D explain")
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
  expect(f).toMatch(/Changed since \d\d:\d\d\s+D explain/)
  expect(f).not.toContain("asking")
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
  // the reply describes the sent text: it goes under Earlier, the newer edit is listed anew
  const f = await waitFrame(s, (f) => /Changed since \d\d:\d\d\s+D explain/.test(f) && /¹ One/.test(f))
  expect(info(f)).toMatch(/Earlier \d\d:\d\d · llama3.2\n {2}Old summary\./)
  expect(info(f)).toMatch(/² One\s+\+1 −1\n {4}reworded/) // numbered on after the current rows
  expect(f).toMatch(/³ Three\s+new/)
  expect(f.split("Earlier")[0]).not.toContain("Three") // explained already: the baseline moved to the sent text
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
  await waitFrame(s, (f) => /Changed since \d\d:\d\d · llama3.2/.test(f) && f.includes("Rewords one line."))
  writeFileSync(
    join(d, "a.md"),
    big((k, i) => `b${k}-${i}`),
  )
  await waitFrame(s, (f) => f.includes("reloaded · too large to compare"), 4000)
  const f = await keys(s)
  expect(info(f)).toMatch(/Changed since \d\d:\d\d\n {2}too many lines changed to\n {2}compare; nothing to explain/)
  expect(info(f)).toMatch(/Earlier \d\d:\d\d · llama3.2\n {2}Rewords one line\./) // the explanation stays, dimmed
  expect(await keys(s, "D")).toContain("too large to compare")
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
  // the error stays in the block (D retry), the toast says it too; the baseline did not move
  const f = await waitFrame(s, (f) => f.includes("AI: boom") && /Changed since \d\d:\d\d\s+D retry/.test(f))
  expect(info(f)).toMatch(/D retry\n {2}✗ boom\n {2}¹ One/)
  expect(f).toContain("D retry") // the footer's word
  await keys(s, "D") // retries
  await waitFor(s, () => ai.calls.length === 2)
  expect(await keys(s)).not.toContain("✗ boom")
  ai.fail(1, "boom")
  await waitFrame(s, (f) => f.includes("✗ boom"))
  // a change to the note clears it
  writeFileSync(join(d, "a.md"), EDITED + "\nmore\n")
  await waitFrame(s, (f) => !f.includes("✗ boom") && /Changed since \d\d:\d\d\s+D explain/.test(f), 4000)
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
      /Changed since \d\d:\d\d · llama3.2/.test(f) &&
      f.includes("Rewords the first part.") &&
      f.includes("first line reworded"),
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

test("help lists D in the AI group; the Info footer shows D explain only with changes and AI", async () => {
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
  expect((await keys(s, "3")).split("\n")[38]).not.toContain("D explain")
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await withClock(new Date(Date.now() + 10_000), async () => {
    // past the toast, so the hints get the whole line; on a change row: ↑↓ changes  ⏎ go to
    const foot = (await keys(s, "tab", "3")).split("\n")[38]!
    expect(foot).toContain("D explain")
    expect(foot).toContain("↑↓ changes")
    expect(foot).toContain("⏎ go to")
    expect(foot).not.toContain("D changes")
  })
})

test("⏎ on a change row jumps to its heading; removed rows are skipped", async () => {
  const d = tmp({ "a.md": LONG })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(
    join(d, "a.md"),
    LONG.replace("row 3\n", "row 3 edited\n").replace("## Two\n\nsecond\n\n", "").replace("third", "third!"),
  )
  await waitFrame(s, (f) => f.includes("³ sections changed"), 4000)
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

test("a second D after an edit keeps the last explanation under Earlier; a cancel keeps it too", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "First pass.\n§1: one reworded\n")
  ai.end(0)
  await waitFrame(s, (f) => /Changed since \d\d:\d\d · llama3.2/.test(f))
  writeFileSync(join(d, "a.md"), EDITED.replace("second", "second, edited"))
  const idle = await waitFrame(s, (f) => f.includes("Earlier"), 4000)
  expect(info(idle)).toMatch(/Changed since \d\d:\d\d\s+D explain\n {2}¹ Two\s+\+1 −1\n {2}Earlier/)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 2)
  expect(info(await keys(s))).toMatch(
    /▍ asking llama3.2\n {2}¹ Two[^\n]*\n {2}Earlier \d\d:\d\d · llama3.2\n {2}First pass\./,
  )
  expect(info(await keys(s, "D"))).toMatch(/D explain\n {2}¹ Two[^\n]*\n {2}Earlier/)
})

test("past 8 changes a `+ n more` stop opens and folds the rest", async () => {
  const many = (tag: string) => Array.from({ length: 10 }, (_, i) => `## S${i}\n\n${tag}${i}\n`).join("\n")
  const d = tmp({ "a.md": many("a") })
  const s = await mount(d, "a.md", { size: { width: 120, height: 40 } })
  writeFileSync(join(d, "a.md"), many("b").replace("## S9\n\nb9\n", ""))
  await waitFrame(s, (f) => f.includes("¹⁰ sections changed"), 4000)
  const f = await keys(s, "3")
  expect(info(f)).toContain("+ 2 more sections")
  expect(info(f)).not.toContain("S9")
  const open = await keys(s, "G", "enter")
  expect(info(open)).toMatch(/¹⁰ S9\s+−3\n {2}show fewer\s+⏎ fewer/)
  expect(open.split("\n")[38]).toContain("⏎ fewer")
  expect(info(await keys(s, "enter"))).toContain("+ 2 more sections")
})

test("the running head counts the changes (AI off too), in Source as well; zen has none", async () => {
  const d = tmp({ "a.md": TWO })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  const f = await waitFrame(s, (f) => f.includes("reloaded"), 4000)
  expect(f.split("\n")[0]).toMatch(/² changed\s*$/)
  expect((await keys(s, "s")).split("\n")[0]).toMatch(/² changed {3}source\s*$/)
  expect((await keys(s, "s", "z")).split("\n")[0]).not.toContain("changed")
})

test("the head says not compared for a reload too large to compare", async () => {
  const big = (tag: string) =>
    Array.from(
      { length: 5 },
      (_, k) => `## S${k}\n\n` + Array.from({ length: 1000 }, (_, i) => `${tag}${k}-${i}`).join("\n"),
    ).join("\n\n")
  const d = tmp({ "a.md": big("a") })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), big("b"))
  const f = await waitFrame(s, (f) => f.includes("too large to compare"), 4000)
  expect(f.split("\n")[0]).toMatch(/not compared\s*$/)
})

const MARKED =
  "# Broth\n\n## One\n\nfirst\n\n## Two\n\nsecond\n\n## Three\n\nthird\n\n## " + "x".repeat(77) + "\n\nlong\n"
const MARKED_EDIT = MARKED.replace("first", "first!").replace("## Two\n\nsecond\n\n", "").replace("long", "long!")

/** The colour of the span that is exactly `text` on screen row `row`. */
const fgAt = (s: Awaited<ReturnType<typeof mount>>, row: number, text: string) =>
  hex(s.captureSpans().lines[row]!.spans.find((sp) => sp.text === text)!.fg)

test("marks: ¹ after a changed heading, a full heading's in the gutter, a removed section's above the next heading", async () => {
  const d = tmp({ "a.md": MARKED })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), MARKED_EDIT)
  const f = await waitFrame(s, (f) => f.includes("reloaded"), 4000)
  const rows = f.split("\n")
  const at = (needle: string) => rows.findIndex((r) => r.includes(needle))
  expect(rows[at("## One")]).toContain("## One¹ ")
  // Two is gone: its mark sits on the blank row above Three, two columns left of the text, muted
  const three = at("## Three")
  expect(rows[three - 1]!.slice(0, 40).trim()).toBe("²")
  expect(rows[three - 1]!.indexOf("²")).toBe(rows[three]!.indexOf("## Three") - 2)
  expect(fgAt(s, three - 1, "²")).toBe(B.textMuted)
  expect(rows[three]).not.toContain("Three³") // Three did not change
  // a heading that fills the measure: its mark in the gutter
  const long = at("x".repeat(77))
  expect(rows[long]!.indexOf("³")).toBe(rows[long]!.indexOf("## x") - 2)
  expect(fgAt(s, at("## One"), "¹")).toBe(B.primary)
  // drawn, not rendered: the heading's text matches once, Source and zen draw none
  expect((await keys(s, "/", "type:One", "enter")).split("\n")[0]).toContain("/One 1/1")
  expect(await keys(s, "esc", "s")).not.toContain("One¹")
  expect(await keys(s, "s", "z")).not.toContain("One¹")
})

test("marks turn muted once explained", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": TWO })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), EDITED)
  const f = await waitFrame(s, (f) => f.includes("## One¹"), 4000)
  const one = f.split("\n").findIndex((r) => r.includes("## One¹"))
  expect(fgAt(s, one, "¹")).toBe(B.primary)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "Sum.\n§1: one reworded\n")
  ai.end(0)
  await waitFrame(s, (f) => /Changed since \d\d:\d\d · llama3.2/.test(f))
  expect(fgAt(s, one, "¹")).toBe(B.textMuted)
})

const WALK =
  "# Walk\n\n## One\n\n" +
  filler(12) +
  "\n\nthe old line\n\n## Two\n\ngone soon\n\n## Three\n\nthree\n\n" +
  filler(12).replaceAll("filler", "more") +
  "\n"
const WALK_EDIT =
  WALK.replace("the old line", "the new line here")
    .replace("## Two\n\ngone soon\n\n", "")
    .replace("three\n", "three!\n") + "\n## Four\n\nfour\n"

/** The footnote's rule row and the note under it, by their text. */
const footOf = (f: string) => {
  const rows = f.split("\n")
  const at = rows.findIndex((r) => /^\s*─{16} {2,}\S/.test(r))
  return at < 0 ? null : { rule: rows[at]!.trim(), note: rows[at + 1]!.trim() }
}

test("⏎ on a change lands: the footnote under a rule, the quoted line marked; [ ] walk, esc hides, scrolling keeps it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": WALK })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), WALK_EDIT)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, 'Sum.\n§1: one line reworded | "the new line here"\n§3: three shouts\n')
  ai.end(0)
  await waitFrame(s, (f) => /Changed since \d\d:\d\d · llama3.2/.test(f))
  let f = await keys(s, "enter")
  expect(footOf(f)).toEqual({
    rule: "────────────────                                                 ¹ of 4 · ] next",
    note: "¹ one line reworded",
  })
  const rows = f.split("\n")
  const line = rows.findIndex((r) => r.includes("the new line here"))
  expect(line).toBe(3) // the landing puts the quoted line on the body's second row
  expect(rows[line]![rows[line]!.indexOf("the new") - 2]).toBe("¹")
  expect(f.split("\n")[28]).toMatch(/\[ \] changes {3}3 all in Info {3}esc hide/)
  // ] skips the removed section (²) for ³; at the last change the tail offers [ prev
  f = await keys(s, "]")
  expect(footOf(f)?.note).toBe("³ three shouts")
  f = await keys(s, "]")
  expect(footOf(f)).toEqual({
    rule: "────────────────                                                 ⁴ of 4 · [ prev",
    note: "⁴ new section · +3",
  })
  expect(await keys(s, "]")).toContain("last change")
  expect(footOf(await keys(s, "[", "[", "[")))?.toEqual(expect.objectContaining({ note: "¹ one line reworded" }))
  expect(await keys(s)).toContain("first change")
  expect(footOf(await keys(s, "j", "j", "space"))).not.toBeNull() // reading on keeps it
  f = await keys(s, "esc")
  expect(footOf(f)).toBeNull()
  expect(f.split("\n")[28]).not.toContain("[ ] changes")
  expect(footOf(await keys(s, "["))).toBeNull() // [ ] are the headings again
})

test("a landing goes with another note and with zen; a search query clears before it", async () => {
  const d = tmp({ "a.md": WALK, "b.md": "# B\n" })
  const s = await mount(d, "a.md", { size: W120 })
  writeFileSync(join(d, "a.md"), WALK_EDIT)
  await waitFrame(s, (f) => f.includes("reloaded"), 4000)
  expect(footOf(await keys(s, "3", "enter"))?.note).toBe("¹ edited · +1 −1") // AI off: the counts
  expect(footOf(await keys(s, "/", "type:three", "enter", "esc"))).not.toBeNull()
  expect(footOf(await keys(s, "esc"))).toBeNull()
  await keys(s, "3", "enter")
  expect(footOf(await keys(s, "z", "z"))).toBeNull()
  await keys(s, "3", "enter")
  await openNote(s, "b")
  await openNote(s, "a")
  expect(footOf(await keys(s))).toBeNull()
})

test("D below 100 columns lands on the first change instead of opening the drawer; 3 opens Info", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": WALK })
  const { s, ai } = await mountAI(d, "a.md", { size: { width: 80, height: 24 } })
  writeFileSync(join(d, "a.md"), WALK_EDIT)
  await waitFrame(s, (f) => f.includes("D explains"), 4000)
  let f = await keys(s, "D")
  await waitFor(s, () => ai.calls.length === 1)
  f = await keys(s)
  expect(f).not.toContain("¹Files") // no drawer
  expect(footOf(f)?.rule).toMatch(/asking llama3.2 · D cancel$/)
  expect(footOf(f)?.note).toBe("¹ ▍")
  await withClock(new Date(Date.now() + 10_000), async () => {
    // past the toast, so the hints get the whole line
    expect((await keys(s, "?")).split("\n")[22]).toMatch(/\[ \] changes {3}3 all in Info {3}D cancel {3}esc hide/)
  })
  ai.send(0, "Sum.\n§1: one line reworded\n")
  ai.end(0)
  f = await waitFrame(s, (f) => footOf(f)?.note === "¹ one line reworded")
  expect(footOf(f)?.rule).toMatch(/¹ of 4 · \] next$/)
  expect(await keys(s, "3")).toContain("¹Files")
})
