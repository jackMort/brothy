// App: asking the vault from C-p (? question, rerank, jump).
import { expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ASK_PROMPT, RERANK_PROMPT } from "../../src/ai/ask"
import { GHOST_STEP, HINT_HOLD } from "../../src/ui/status"
import { aiStub, filler, keys, OLLAMA, type Setup, useAppHarness, W120, waitFor, waitFrame, withClock } from "./helpers"

const { cacheDir, tmp, mount, openNote, aiConfig, mountAI } = useAppHarness()
/** Past the startup hints, so the first `?` shows the key hints and the second opens the sheet. */
const PAST_HINTS = () => new Date(Date.now() + HINT_HOLD + 4 * GHOST_STEP + 10)

// ------------------------------------------------------------- ? in C-p: ask

/** Two notes; "Open a single file" sits below 40 filler paragraphs, so a jump there scrolls. */
const askVault = () =>
  tmp({
    "README.md": "# README\n\n## Quick start\n\nbrothy path opens it.\n",
    "getting-started.md": `# Getting started\n\nIntro.\n\n## Open a folder\n\nPass a folder path.\n\n${filler(40)}\n\n## Open a single file\n\nSee below.\n\nGive a single file path to brothy.\n`,
  })
const QUERIES = JSON.stringify({ queries: ["single file", "path", "cli"] })
/** C-p, `?<question>`, ⏎; call `i` of the stub replies `reply`. Resolves with the frame once the Matches show. */
async function askIt(
  s: Setup,
  ai: ReturnType<typeof aiStub>,
  reply = QUERIES,
  i = 0,
  question = "how do I open one file",
) {
  await keys(s, "C-p", `type:?${question}`)
  await waitFrame(s, (f) => f.includes("⏎ ask"))
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === i + 1)
  ai.send(i, reply)
  ai.end(i)
  return waitFrame(s, (f) => f.includes("Matches"))
}

test("? in C-p: the title is Ask, the row says what leaves and where; too short asks for more", async () => {
  aiConfig(OLLAMA)
  const s = await mount(askVault(), "README.md", { size: W120 })
  let f = await keys(s, "C-p", "type:?ho")
  expect(f).toContain("Ask")
  expect(f).toContain("type a question")
  f = await keys(s, "type:w")
  expect(f).toContain("⏎ ask · only the question → localhost:11434")
  expect(f).not.toContain("Go to")
  await waitFrame(s, (fr) => fr.includes("2 notes")) // after the index build's "indexing n/m"
})

test("with an ai block Go to says ? asks, and its footer has a spare `? ask`, dropped first when short", async () => {
  aiConfig(OLLAMA)
  let s = await mount(askVault(), "README.md", { size: W120 })
  let f = await keys(s, "C-p")
  expect(f).toContain("Note, heading or text… · ? asks your notes")
  expect(f.split("\n").at(-3)).toContain("? ask")
  s.renderer.destroy()
  s = await mount(askVault(), "README.md", { size: { width: 60, height: 24 } })
  f = await keys(s, "C-p")
  expect(f.split("\n").at(-3)).toContain("esc close")
  expect(f.split("\n").at(-3)).not.toContain("? ask")
})

test("without an ai block Go to never mentions ?", async () => {
  const s = await mount(askVault(), "README.md", { size: W120 })
  const f = await keys(s, "C-p")
  expect(f).toContain("Note, heading or text…")
  expect(f).not.toContain("? asks your notes")
  expect(f.split("\n").at(-3)).not.toContain("? ask")
})

test("the help sheet names ask in the AI group", async () => {
  const s = await mount(askVault(), "README.md", { size: W120 })
  await withClock(PAST_HINTS(), async () => {
    await keys(s, "?")
    expect(await keys(s, "?")).toContain("ask your notes: ^p then ?question")
  })
})

test("the ask footer follows the state: idle, asking, Matches, reranked, an error", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  const footer = async () => (await keys(s)).split("\n").at(-3)!
  await keys(s, "C-p", "type:?ho")
  expect(await footer()).toMatch(/⌫ edit\s+esc close/)
  await keys(s, "type:w do I open one file")
  expect(await footer()).toMatch(/⏎ ask\s+⌫ edit\s+esc close/)
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 1)
  expect(await footer()).toMatch(/⌫ edit · cancels\s+esc close/)
  ai.send(0, QUERIES)
  ai.end(0)
  await waitFrame(s, (f) => f.includes("Matches"))
  expect(await footer()).toMatch(/↑↓ select\s+⏎ open\s+tab rerank\s+esc close/)
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  expect(await footer()).toMatch(/↑↓ select\s+⏎ open\s+esc close/)
  ai.send(1, JSON.stringify({ answers: [{ id: "c1", why: "pass the file path" }] }))
  ai.end(1)
  await waitFrame(s, (f) => f.includes("Other matches"))
  expect(await footer()).toMatch(/↑↓ select\s+⏎ open\s+tab section\s+esc close/)
  await keys(s, "type:x")
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 3)
  ai.fail(2, "boom")
  await waitFrame(s, (f) => f.includes("✗ boom"))
  expect(await footer()).toMatch(/⏎ try again\s+⌫ edit\s+esc close/)
})

test("idle: the pane at 120 says what ⏎ sends; at 80 two muted rows; a long question names the 300 cut", async () => {
  aiConfig(OLLAMA)
  let s = await mount(askVault(), "README.md", { size: W120 })
  let f = await keys(s, "C-p", "type:?how do I open one file")
  expect(f).toContain("Ask your notes")
  expect(f).toContain("Nothing is written to disk.")
  expect(f).not.toContain("· nothing is written to disk")
  s.renderer.destroy()
  s = await mount(askVault(), "README.md", { size: { width: 80, height: 24 } })
  f = await keys(s, "C-p", "type:?how do I open one file")
  expect(f).toContain("· only the question goes out; rerank adds short excerpts")
  expect(f).toContain("· nothing is written to disk")
  f = await keys(s, `type:${"x".repeat(440)}`)
  expect(f).toContain("only the first 300 characters → localhost:11434")
})

test("asking: the pane shows the question sent and its length, nothing of the vault", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  const f = await keys(s)
  expect(f).toContain("sent to localhost:11434")
  expect(f).toContain("“how do I open one file”")
  expect(f).toContain("22 characters · nothing else")
  expect(f).not.toContain("brothy path opens it")
})

test("? never opens help while the switcher is open", async () => {
  const s = await mount(askVault(), "README.md", { size: W120 })
  const f = await keys(s, "C-p", "type:?")
  expect(f).toContain("Ask")
  expect(f).not.toContain("Global")
})

test("without an ai block the Ask row says AI off and ⏎ sends nothing", async () => {
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  let f = await keys(s, "C-p", "type:?how do I open one file")
  expect(f).toContain(`AI off · set "ai" in config.json`)
  f = await keys(s, "enter")
  expect(f).toContain(`AI off · set "ai" in config.json`)
  expect(ai.calls.length).toBe(0)
})

test("⏎ sends only the question; a waiting row under a rule, then Matches with the word that matched", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  let f = await keys(s)
  expect(f).toContain("────────────────")
  expect(f).toContain("▍ asking llama3.2")
  expect(f).not.toContain("asking llama3.2 · 0 s")
  const body = ai.calls[0]!.body
  expect(body.messages.map((m) => m.content)).toEqual([ASK_PROMPT, "how do I open one file"])
  expect(JSON.stringify(body)).not.toMatch(/brothy path|Give a single|README|getting-started/)
  ai.send(0, QUERIES)
  ai.end(0)
  f = await waitFrame(s, (fr) => fr.includes("Matches"))
  // the list is narrower beside the peek pane: the note name keeps its quarter, cut with …
  for (const x of [
    "llama3.2",
    "getting-sta… › Open a single file",
    "single file",
    "README › Quick start",
    "↻ rerank with excerpts",
    "searched: single file · path · cli",
  ])
    expect(f).toContain(x)
  expect(f).not.toContain("Answers")
  expect(f).not.toMatch(/\b[0-9]\/3\b/)
  expect(f).not.toContain("▍ asking")
  expect(existsSync(join(cacheDir, "brothy"))).toBe(false) // nothing on disk
})

test("the waiting row counts the seconds from 1 s; the title names the model while asking", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  const f = await waitFrame(s, (fr) => fr.includes("▍ asking llama3.2 · 1 s"), 3000)
  expect(f.split("\n").find((l) => l.includes("Ask"))).toContain("llama3.2")
})

test("editing the question aborts the request and goes back to idle; esc aborts too", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  const f = await keys(s, "backspace")
  expect(ai.calls[0]!.signal!.aborted).toBe(true)
  expect(f).toContain("⏎ ask")
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 2)
  expect(await keys(s, "esc")).not.toContain("Ask")
  expect(ai.calls[1]!.signal!.aborted).toBe(true)
})

test("a failed ask toasts and keeps the error in the list: what left, and the next steps; ⏎ asks again", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.fail(0, "boom")
  const f = await waitFrame(s, (fr) => fr.includes("✗ boom"))
  expect(f).toContain("AI: boom") // the toast
  expect(f).toContain("the question was sent to localhost:11434")
  expect(f).toContain("· is ollama running? ⏎ tries again")
  expect(f).toContain("· the ai block lives in config.json; r re-reads it")
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 2)
})

test("a reply without usable queries: AI: no usable answer", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await keys(s, "C-p", "type:?how do I open one file", "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, "no json here")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("AI: no usable answer"))
})

test("an ask while 3 other AI requests run: AI busy, on the toast and the ask row; nothing is sent", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "a.md": "# A\n\nA.\n", "b.md": "# B\n\nB.\n", "c.md": "# C\n\nC.\n" })
  const { s, ai } = await mountAI(d, "a.md", { size: W120 })
  await keys(s, "a")
  for (const n of ["b", "c"]) {
    await openNote(s, n)
    await keys(s, "a")
  }
  await waitFor(s, () => ai.calls.length === 3)
  await keys(s, "C-p", "type:?how do I open one file")
  await waitFrame(s, (f) => f.includes("⏎ ask"))
  const f = await keys(s, "enter")
  expect(f).toContain("✗ AI busy · 3 requests running")
  expect(f).toContain("nothing was sent")
  await waitFrame(s, (fr) => fr.split("\n").filter((l) => l.includes("AI busy · 3 requests running")).length === 2) // toast + row
  expect(ai.calls.length).toBe(3)
})

test("asking the same question again reuses its queries without a request", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await askIt(s, ai)
  expect(await keys(s, "type:x", "backspace")).toContain("⏎ ask")
  expect(await keys(s, "enter")).toContain("Matches")
  expect(ai.calls.length).toBe(1)
})

test("excerpts are sent only from the rerank row; the model's order shows with its why, the rest under Other matches", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await askIt(s, ai)
  expect(ai.calls.length).toBe(1)
  await keys(s, "tab", "enter") // first answer → the rerank row
  await waitFor(s, () => ai.calls.length === 2)
  expect(await keys(s)).toMatch(/▍ ranking \d+ excerpts · llama3\.2/)
  const [sys, user] = ai.calls[1]!.body.messages.map((m) => m.content)
  expect(sys).toBe(RERANK_PROMPT)
  expect(user).toStartWith(
    "Question: how do I open one file\n\nc1 · getting-started › Getting started › Open a single file\nSee below. Give a single file path to brothy.",
  )
  ai.send(
    1,
    JSON.stringify({ answers: [{ id: "c1", why: "pass the file path" }, { id: "c7" }, { id: "c1", why: "dup" }] }),
  )
  ai.end(1)
  const f = await waitFrame(s, (fr) => fr.includes("Other matches"))
  const lines = f.split("\n")
  const row = (x: string) => lines.find((l) => l.includes(x))!
  expect(row("Answers")).toContain("llama3.2")
  expect(row("Open a single file")).toContain("¹ getting-sta")
  expect(row("¹ pass the file path")).toBeDefined() // the why is a footnote under the rule, not on the answer's row
  expect(row("Open a single file")).not.toContain("pass the file path")
  expect(lines.findIndex((l) => l.includes("────────────────"))).toBeLessThan(
    lines.findIndex((l) => l.includes("¹ pass the file path")),
  )
  expect(f).not.toContain("↻ rerank with excerpts")
  expect(f).not.toContain("dup")
  // the highlighted answer's why is also at the pane's foot
  expect(f.split("¹ pass the file path")).toHaveLength(3)
})

test("a rerank with no known id: AI: no usable ranking, the local order stays", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await askIt(s, ai)
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  ai.send(1, JSON.stringify({ answers: [{ id: "c9" }] }))
  ai.end(1)
  const f = await waitFrame(s, (fr) => fr.includes("AI: no usable ranking"))
  expect(f).toContain("↻ rerank with excerpts")
  expect(f).not.toContain("Other matches")
})

test("a failed rerank toasts the error; the tier 0 answers stay", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await askIt(s, ai)
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  ai.fail(1, "boom")
  const f = await waitFrame(s, (fr) => fr.includes("AI: boom"))
  expect(f).toContain("↻ rerank with excerpts")
  expect(f).toContain("README › Quick start")
  expect(f).not.toContain("asks again")
})

test("the same rerank again is served from memory", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await askIt(s, ai)
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  ai.send(1, JSON.stringify({ answers: [{ id: "c1", why: "pass the file path" }] }))
  ai.end(1)
  await waitFrame(s, (fr) => fr.includes("Other matches"))
  await keys(s, "type:x", "backspace", "enter") // the question again: queries from memory
  await waitFrame(s, (fr) => fr.includes("↻ rerank with excerpts"))
  const f = await keys(s, "tab", "enter")
  expect(f).toContain("Other matches")
  expect(ai.calls.length).toBe(2)
})

test("⏎ on an answer opens the note at the first line holding its best query, with the find highlight", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "README.md", { size: W120 })
  await askIt(s, ai)
  const f = await keys(s, "enter") // getting-started › Open a single file (best query: "single file")
  expect(f).not.toContain("Ask")
  expect(f).toContain("Give a single file path to brothy.")
  expect(f).toContain("/single file 2/2") // the heading is match 1
})

test("an answer whose best query is only in the heading opens at the heading, no find", async () => {
  aiConfig(OLLAMA)
  const { s, ai } = await mountAI(askVault(), "getting-started.md", { size: W120 })
  await askIt(s, ai, JSON.stringify({ queries: ["quick start"] }))
  const f = await keys(s, "enter")
  expect(f).toContain("Quick start")
  expect(f).toContain("brothy path opens it.")
  expect(f).not.toContain("/quick start")
})

test("a heading renamed since indexing: the note opens where it was left and toasts heading gone", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const d = askVault()
  const s = await mount(d, "README.md", { size: W120, fetch: ai.f })
  await askIt(s, ai)
  writeFileSync(
    join(d, "getting-started.md"),
    readFileSync(join(d, "getting-started.md"), "utf8").replace("## Open a single file", "## Open one file"),
  )
  const f = await keys(s, "enter")
  expect(f).toContain("heading gone")
  expect(f).toContain("Getting started")
  expect(f).not.toContain("/single file")
})

test("an answer whose note was deleted opens the read error, with no jump", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const d = askVault()
  const s = await mount(d, "README.md", { size: W120, fetch: ai.f })
  await askIt(s, ai)
  rmSync(join(d, "getting-started.md"))
  const f = await keys(s, "enter")
  expect(f).not.toContain("Ask")
  expect(f).not.toContain("heading gone")
  expect(f).not.toContain("/single file")
})

test("a rerank is sent again after a candidate note's text changed", async () => {
  aiConfig(OLLAMA)
  const ai = aiStub()
  const d = askVault()
  const s = await mount(d, "README.md", { size: W120, fetch: ai.f })
  await askIt(s, ai)
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 2)
  ai.send(1, JSON.stringify({ answers: [{ id: "c1", why: "pass the file path" }] }))
  ai.end(1)
  await waitFrame(s, (fr) => fr.includes("Other matches"))
  await keys(s, "esc")
  const file = join(d, "getting-started.md")
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      "Give a single file path to brothy.",
      "Give a single file path to brothy, or a folder, or stdin.",
    ),
  )
  utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  await keys(s, "C-p", "type:?how do I open one file")
  await waitFrame(s, (fr) => fr.includes("⏎ ask"))
  await keys(s, "enter") // the queries come from memory
  await waitFrame(s, (fr) => fr.includes("↻ rerank with excerpts"))
  await keys(s, "tab", "enter")
  await waitFor(s, () => ai.calls.length === 3)
  expect(ai.calls[2]!.body.messages[1]!.content).toContain("or a folder, or stdin")
})
