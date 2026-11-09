import { describe, expect, test } from "bun:test"
import { PROMPTS } from "../../src/ai/config"
import {
  bodyParts,
  CHAT_NOTE_MAX,
  CHAT_PROMPT,
  type Chip,
  chatContext,
  chatRequest,
  type Exchange,
  MAX_CHAT,
  parseSources,
  splitReply,
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
