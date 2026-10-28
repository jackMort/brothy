import { expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { SYSTEM_PROMPT, chat, noteText, type AITarget } from "../src/ai"
import { ASK_PROMPT, RERANK_PROMPT, parseQueries, parseRerank } from "../src/ask"
import { DELTA_PROMPT, deltaMessage, diffSections, parseDelta } from "../src/delta"
import { glossRequest, glossSystem } from "../src/gloss"
import { FAKE_AI, STOCK, fakeFetch, fakeReply, kindOf, stockEdit, tokensOf } from "../scripts/fakeai"
import { normalizeAI } from "../src/ai"

const ex = join(import.meta.dir, "../examples")
const notes = (dir = ex): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? notes(join(dir, n)) : n.endsWith(".md") ? [join(dir, n)] : []))
const stock = readFileSync(join(ex, "notes/stock.md"), "utf8")

test("the request kind comes from the system prompt", () => {
  expect(kindOf(SYSTEM_PROMPT)).toBe("tldr")
  expect(kindOf(glossSystem("explain"))).toBe("gloss")
  expect(kindOf(DELTA_PROMPT)).toBe("delta")
  expect(kindOf(ASK_PROMPT)).toBe("ask")
  expect(kindOf(RERANK_PROMPT)).toBe("rerank")
  expect(kindOf("something else")).toBeNull()
})

test("the tour's ai block is valid", () => {
  expect(normalizeAI(FAKE_AI)).toEqual(FAKE_AI)
})

test("every example note has a TL;DR that fits the summary prompt", () => {
  for (const f of notes()) {
    const r = fakeReply(SYSTEM_PROMPT, noteText(readFileSync(f, "utf8")))
    expect(r, f).not.toBeNull()
    expect(r!.split(/\s+/).length, f).toBeLessThanOrEqual(60)
  }
  expect(fakeReply(SYSTEM_PROMPT, "# Unknown note\n\ntext")).toBeNull()
})

test("glosses exist for the sections the tour reads, in the 35-word budget", () => {
  const { user } = glossRequest("explain", "Slow broth", ["Slow broth", "Skim as you go"], "text", 8000)
  const r = fakeReply(glossSystem("explain"), user)!
  expect(r).toContain("foam")
  expect(r.split(/\s+/).length).toBeLessThanOrEqual(35)
  expect(fakeReply(glossSystem("explain"), glossRequest("explain", "Slow broth", ["Nope"], "t", 8000).user)).toBeNull()
})

test("the reload explanation parses, with quotes found in the added lines", () => {
  const before = noteText(stock), after = noteText(stockEdit(stock))
  const changes = diffSections(before, after)!
  expect(changes.map((c) => c.path.at(-1))).toEqual(["How long to simmer", "Storing"])
  const reply = fakeReply(DELTA_PROMPT, deltaMessage("Slow broth", changes, 16000))!
  const p = parseDelta(reply, changes)!
  expect(p.summary).toContain("Storing")
  expect(p.notes.map((n) => n?.quote)).toEqual(["4 to 6 hours", "four days in the fridge"])
  expect(STOCK).toBe("examples/notes/stock.md")
})

test("a change nobody wrote a reply for gets none", () => {
  const changes = diffSections("# T\n\n## A\n\none\n", "# T\n\n## A\n\ntwo\n")!
  expect(fakeReply(DELTA_PROMPT, deltaMessage("T", changes, 16000))).toBeNull()
})

test("ask: search terms for the question, and a rerank over its numbered excerpts", () => {
  const q = parseQueries(fakeReply(ASK_PROMPT, "how long should broth simmer")!)!
  expect(q).toContain("simmer")
  expect(fakeReply(ASK_PROMPT, "unknown question")).toBeNull()
  const msg = "Question: how long should broth simmer\n\nc1 · simmering › Heat levels\nlow reading\n\nc2 · stock › How long to simmer\nSimmer chicken broth for 3 to 4 hours\n\nc3 · stock › Salt late\nright at hour two is too salty"
  expect(parseRerank(fakeReply(RERANK_PROMPT, msg)!, 3)!.map((a) => a.i)).toEqual([1, 2])
})

test("tokens rejoin to the reply", () => {
  const s = "Chicken broth simmers for 4–6 hours, then rests."
  expect(tokensOf(s).join("")).toBe(s)
  expect(tokensOf("extraordinarily").every((t) => t.length <= 6)).toBe(true)
})

const target: AITarget = { url: "http://localhost:11434/v1/chat/completions", host: "localhost:11434", headers: {}, model: "llama3.2", maxChars: 8000 }

test("fakeFetch streams a reply through chat() paced per token, and says no for an unwritten request", async () => {
  const f = fakeFetch({ first: 5, pace: [1, 2] })
  const seen: string[] = []
  const r = await chat(target, { system: SYSTEM_PROMPT, user: noteText(stock), maxOut: 1200, clean: (x) => x.trim() }, { fetch: f, onDelta: (raw) => seen.push(raw) })
  expect(r.ok ? r.text : null).toBe(fakeReply(SYSTEM_PROMPT, noteText(stock)))
  expect(seen.length).toBeGreaterThan(10)
  const bad = await chat(target, { system: SYSTEM_PROMPT, user: "# Nothing\n", maxOut: 1200, clean: (x) => x.trim() }, { fetch: f })
  expect(bad.ok).toBe(false)
})

test("cancelling stops the stream", async () => {
  const ctl = new AbortController()
  const p = chat(target, { system: SYSTEM_PROMPT, user: noteText(stock), maxOut: 1200, clean: (x) => x }, { fetch: fakeFetch({ first: 5, pace: [20, 20] }), signal: ctl.signal })
  setTimeout(() => ctl.abort(), 60)
  expect(await p).toEqual({ ok: false, cancelled: true })
})
