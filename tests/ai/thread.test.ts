import { describe, expect, test } from "bun:test"
import { PROMPTS } from "../../src/ai/config"
import {
  bodyParts,
  CHAT_NOTE_MAX,
  CHAT_PROMPT,
  type Chip,
  chatContext,
  chatRequest,
  citeSection,
  citeWhere,
  type Exchange,
  MAX_CHAT,
  parseSources,
  quoteLines,
  splitReply,
  verifyCites,
} from "../../src/ai/thread"

const A: Chip = { path: "/v/a.md", title: "a" }
const B: Chip = { path: "/v/b.md", title: "b" }
const ex = (q: string, raw: string | null, error: string | null = null): Exchange => ({
  q,
  at: 0,
  model: "m",
  raw,
  parts: raw ? [raw] : [],
  cites: [],
  error,
  doneAt: raw ? 1 : null,
})
const cp = (s: string) => [...s].length

describe("chatContext", () => {
  test("PROMPTS.chat is 1", () => expect(PROMPTS.chat).toBe(1))

  test("a short note goes whole, unclipped; size is tokens of all that is sent", () => {
    const c = chatContext(["apples"], [A], [], "why?", 48_000)
    expect(c.notes).toEqual([{ chip: A, text: "apples", clipped: false }])
    expect(c.turns).toEqual([])
    const r = chatRequest(c, "why?")
    expect(c.size).toBe(Math.ceil(cp(r.system + "why?") / 4))
  })

  test("each note is capped at CHAT_NOTE_MAX and marked clipped", () => {
    const c = chatContext(["x".repeat(CHAT_NOTE_MAX + 10)], [A], [], "q", 1_000_000)
    expect(c.notes[0]!.clipped).toBe(true)
    expect(c.notes[0]!.text).toEndWith("\n[truncated]")
  })

  test("notes share what maxChars leaves after the prompt, question and turns, in chip order; one left with nothing is empty and clipped", () => {
    const room = cp(CHAT_PROMPT) + cp("q") + 100
    const c = chatContext(["y".repeat(80), "z".repeat(80)], [A, B], [], "q", room)
    expect(c.notes[0]).toEqual({ chip: A, text: "y".repeat(80), clipped: false })
    expect(c.notes[1]!.clipped).toBe(true)
    expect(c.notes[1]!.text).toStartWith("z".repeat(20))
    const none = chatContext(["y".repeat(80), "z"], [A, B], [], "q", cp(CHAT_PROMPT) + 81)
    expect(none.notes[1]).toEqual({ chip: B, text: "", clipped: true })
  })

  test("earlier turns: newest first within 25 % of maxChars, failed and unanswered never sent", () => {
    const turns = [ex("q1", "a".repeat(400)), ex("q2", "b".repeat(100)), ex("q3", null, "boom"), ex("q4", "c")]
    const c = chatContext(["n"], [A], turns, "now", 2000) // share: 500
    expect(c.turns).toEqual([
      { role: "user", content: "q2" },
      { role: "assistant", content: "b".repeat(100) },
      { role: "user", content: "q4" },
      { role: "assistant", content: "c" },
    ])
  })
})

describe("chatRequest", () => {
  test("system: the prompt, a blank line, one <note> per chip; user the question; capped at MAX_CHAT, kept by sentences", () => {
    const c = chatContext(
      ["apples", "pears"],
      [A, { path: "/v/b.md", title: 'Say "hi"' }],
      [ex("q0", "a0")],
      "why?",
      48_000,
    )
    const r = chatRequest(c, "why?")
    expect(r.system).toBe(
      `${CHAT_PROMPT}\n\n<note id="1" title="a">\napples\n</note>\n<note id="2" title="Say 'hi'">\npears\n</note>`,
    )
    expect(r.turns).toEqual([
      { role: "user", content: "q0" },
      { role: "assistant", content: "a0" },
    ])
    expect(r.user).toBe("why?")
    expect(r.maxOut).toBe(MAX_CHAT)
    expect(r.clean("<think>x</think> hi ")).toBe("hi")
    expect(r.keep!("One. " + "w ".repeat(4000))).toBe("One.")
  })
})

describe("the reply", () => {
  test("splitReply: at the last Sources line (bold, colon optional); none yet: all body", () => {
    expect(splitReply('A [1].\nSources:\n[1] note 1: "a"')).toEqual({ body: "A [1].", sources: '[1] note 1: "a"' })
    expect(splitReply("A.\n**Sources**\nx\nsources:\ny")).toEqual({ body: "A.\n**Sources**\nx", sources: "y" })
    expect(splitReply("A [1].")).toEqual({ body: "A [1].", sources: "" })
  })
  test("splitReply while streaming hides a last line that is still becoming `Sources:`", () => {
    expect(splitReply("A [1].\nSour", true).body).toBe("A [1].")
    expect(splitReply("A [1].\n**so", true).body).toBe("A [1].")
    expect(splitReply("A [1].\nSoup is", true).body).toBe("A [1].\nSoup is")
    expect(splitReply("A [1].\nSour", false).body).toBe("A [1].\nSour")
  })
  test("bodyParts: a line break before a mark stays; only spaces and tabs go", () => {
    expect(bodyParts("text\n[1] more")).toEqual(["text\n", 1, " more"])
    expect(bodyParts("a  \t[1]")).toEqual(["a", 1])
  })

  test("bodyParts: [1], [1, 2] and [1][2] become numbers, space before a mark dropped; [x], [ ] and [2024] stay text", () => {
    expect(bodyParts("a [1] b [1, 2] c [3][4].")).toEqual(["a", 1, " b", 1, 2, " c", 3, 4, "."])
    expect(bodyParts("[x] and [ ] in [2024]")).toEqual(["[x] and [ ] in [2024]"])
    expect(bodyParts("[1] start")).toEqual([1, " start"])
  })
  test("parseSources: straight and curly quotes, `note 2:` and `2 -`; other lines dropped", () => {
    expect(parseSources('[1] note 1: "do not press"\n[2] 2 - “clear stock”\nnoise\n[3] note 1 "say "hi" now"')).toEqual(
      [
        { n: 1, note: 1, quote: "do not press" },
        { n: 2, note: 2, quote: "clear stock" },
        { n: 3, note: 1, quote: 'say "hi" now' },
      ],
    )
  })
})

describe("verifyCites", () => {
  const SRC =
    "---\ntitle: x\n---\n# Broth\n\nPour it through a sieve; do **not\npress** the bones.\n%%do not press secret%%\n\n```\nlet x = 1\n```\n"
  const notes = [
    { chip: A, src: SRC },
    { chip: B, src: "# B\n\nClear stock stays clear.\n" },
  ]

  test("quoteLines: one per source line, front matter and comments blank, marks gone, code kept", () => {
    const l = quoteLines(SRC)
    expect(l.slice(0, 3)).toEqual(["", "", ""])
    expect(l[3]).toBe("Broth")
    expect(l[5]).toBe("Pour it through a sieve; do not")
    expect(l[7]).toBe("")
    expect(l[10]).toBe("let x = 1")
  })

  test("a quote across a line break and through inline marks, any case, verifies with its start line", () => {
    const r = verifyCites(["Do not ", 1, "."], [{ n: 1, note: 1, quote: "Do NOT press the bones" }], notes)
    expect(r.cites).toEqual([{ n: 1, path: A.path, quote: "Do NOT press the bones", line: 5 }])
    expect(r.parts).toEqual(["Do not ", 1, "."])
  })

  test("an unverified mark is dropped, its sentence kept; the rest renumbered by first appearance; a repeat keeps its number", () => {
    const r = verifyCites(
      ["A ", 7, ". B ", 9, ". C ", 3, ". D ", 7, "."],
      [
        { n: 7, note: 2, quote: "clear stock" },
        { n: 9, note: 1, quote: "not in the note" },
        { n: 3, note: 1, quote: "let x = 1" },
      ],
      notes,
    )
    expect(r.parts).toEqual(["A ", 1, ". B. C ", 2, ". D ", 1, "."])
    expect(r.cites.map((c) => [c.n, c.path, c.line])).toEqual([
      [1, B.path, 2],
      [2, A.path, 10],
    ])
  })

  test("a quote from the wrong note, a missing note id, or a comment does not verify", () => {
    const r = verifyCites(
      ["x ", 1, 2, 3],
      [
        { n: 1, note: 1, quote: "clear stock" },
        { n: 2, note: 5, quote: "Broth" },
        { n: 3, note: 1, quote: "secret" },
      ],
      notes,
    )
    expect(r).toEqual({ parts: ["x"], cites: [] })
  })
})

describe("where a cite is", () => {
  const SRC = "Lead text.\n\n# Slow broth\n\n## Strain and *cool*\n\nPour.\n"
  test("citeSection: the section whose own range holds the line; the lead-in is -1", () => {
    expect(citeSection(SRC, 0).index).toBe(-1)
    expect(citeSection(SRC, 6).index).toBe(1)
    expect(citeSection(SRC, 2).index).toBe(0)
  })
  test("citeWhere: the heading here, `<note> › <heading>` elsewhere, the title for a lead-in", () => {
    const c = (path: string, line: number) => ({ n: 1, path, quote: "q", line })
    expect(citeWhere(c("/v/a.md", 6), "/v/a.md", SRC, "a")).toBe("Strain and cool")
    expect(citeWhere(c("/v/sim.md", 6), "/v/a.md", SRC, "simmering")).toBe("simmering › Strain and cool")
    expect(citeWhere(c("/v/a.md", 0), "/v/a.md", SRC, "Slow broth")).toBe("Slow broth")
  })
})
