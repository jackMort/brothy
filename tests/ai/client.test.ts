import { describe, expect, test } from "bun:test"
import {
  MAX_SUMMARY,
  SYSTEM_PROMPT,
  aiError,
  buildRequest,
  chat,
  cleanReply,
  cleanSummary,
  clip,
  errMessage,
  extractJSON,
  fmtTokens,
  jsonReply,
  noteText,
  shortModel,
  sseParser,
  stripThink,
  summarize,
  summaryRequest,
  tokens,
  type AIEvent,
} from "../../src/ai/client"
import { PRESETS, PROMPTS, PROMPT_V, normalizeAI, parseGlossStyle, resolveAI, type AITarget } from "../../src/ai/config"
import { IDLE_MS, TOTAL_MS } from "../../src/ai/client"
import * as aiConfig from "../../src/ai/config"

const ok = (r: ReturnType<typeof resolveAI>) => {
  if ("error" in r) throw new Error(r.error)
  return r as AITarget
}

describe("normalizeAI", () => {
  test("keeps a valid block", () => {
    expect(normalizeAI({ provider: "openrouter", model: "anthropic/claude-haiku-5-5" })).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-5-5",
    })
  })
  test("drops the block without provider, model, or a known provider", () => {
    expect(normalizeAI({ model: "m" })).toBeUndefined()
    expect(normalizeAI({ provider: "openai" })).toBeUndefined()
    expect(normalizeAI({ provider: "openai", model: "  " })).toBeUndefined()
    expect(normalizeAI({ provider: "mistral", model: "m" })).toBeUndefined()
    expect(normalizeAI("openai")).toBeUndefined()
  })
  test("custom needs a valid http(s) baseURL", () => {
    expect(normalizeAI({ provider: "custom", model: "m" })).toBeUndefined()
    expect(normalizeAI({ provider: "custom", model: "m", baseURL: "ftp://h/v1" })).toBeUndefined()
    expect(normalizeAI({ provider: "custom", model: "m", baseURL: "http://u:p@h/v1" })).toBeUndefined()
    expect(normalizeAI({ provider: "custom", model: "m", baseURL: "http://host:8080/v1" })?.baseURL).toBe("http://host:8080/v1")
  })
  test("a bad optional field is dropped alone", () => {
    expect(normalizeAI({ provider: "openai", model: "m", baseURL: "nope", keyEnv: "1BAD", maxChars: 999, headers: [] })).toEqual({
      provider: "openai",
      model: "m",
    })
    expect(normalizeAI({ provider: "openai", model: "m", maxChars: 1500.5 })?.maxChars).toBeUndefined()
    expect(normalizeAI({ provider: "openai", model: "m", maxChars: 1000, keyEnv: "MY_KEY" })).toEqual({
      provider: "openai",
      model: "m",
      maxChars: 1000,
      keyEnv: "MY_KEY",
    })
  })
  test("headers keep only valid string pairs and never Authorization", () => {
    const h = normalizeAI({
      provider: "openrouter",
      model: "m",
      headers: { "X-Title": "brothy", "bad name": "x", "X-Evil": "a\r\nInjected: 1", authorization: "Bearer x", "X-Num": 3 },
    })?.headers
    expect(h).toEqual({ "X-Title": "brothy" })
  })
  test("gloss: explain, simplify or translate:<language tag>; anything else is dropped alone", () => {
    for (const g of ["explain", "simplify", "translate:pl", "translate:pt-BR", "translate:zh-Hant-TW", "translate:fil"]) {
      expect(normalizeAI({ provider: "openai", model: "m", gloss: g })?.gloss as string).toBe(g)
      expect(parseGlossStyle(g) as string).toBe(g)
    }
    for (const g of [
      "Explain",
      "translate:",
      "translate:p",
      "translate:polish",
      "translate:pl_PL",
      "translate:pl-",
      "translate:en-x",
      "translate:pl\n",
      "summarize",
      3,
      null,
      ["explain"],
    ]) {
      expect(normalizeAI({ provider: "openai", model: "m", gloss: g })).toEqual({ provider: "openai", model: "m" })
      expect(parseGlossStyle(g)).toBeUndefined()
    }
  })
})

describe("resolveAI", () => {
  test("preset: URL, host, key header, maxChars", () => {
    const t = ok(resolveAI({ provider: "openrouter", model: "x/y" }, { OPENROUTER_API_KEY: "sk-1" }))
    expect(t.url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(t.host).toBe("openrouter.ai")
    expect(t.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer sk-1" })
    expect(t.maxChars).toBe(48_000)
    expect(t.keyEnv).toBe("OPENROUTER_API_KEY")
    expect(t.key).toBe("sk-1")
  })
  test("custom headers are held to the plain-http rule like the key", () => {
    const cfg = { provider: "custom", model: "m", baseURL: "http://gateway.lan/v1", headers: { "api-key": "s3cret-value" } } as const
    expect(resolveAI(cfg, {})).toEqual({ error: "AI: won't send headers over http to gateway.lan" })
    expect("error" in resolveAI({ ...cfg, baseURL: "http://localhost:8080/v1" }, {})).toBe(false)
    expect("error" in resolveAI({ ...cfg, baseURL: "https://gateway.lan/v1" }, {})).toBe(false)
    expect("error" in resolveAI({ ...cfg, headers: undefined }, {})).toBe(false)
  })
  test("overrides: baseURL (trailing slash), keyEnv, maxChars, headers", () => {
    const t = ok(
      resolveAI({ provider: "openai", model: "m", baseURL: "https://proxy.example/v1/", keyEnv: "K", maxChars: 2000, headers: { "X-A": "1" } }, { K: "k" }),
    )
    expect(t.url).toBe("https://proxy.example/v1/chat/completions")
    expect(t.headers).toEqual({ "Content-Type": "application/json", "X-A": "1", Authorization: "Bearer k" })
    expect(t.maxChars).toBe(2000)
  })
  test("a baseURL's query stays after the path; a fragment is dropped", () => {
    const at = (baseURL: string) => ok(resolveAI({ provider: "custom", model: "m", baseURL }, {})).url
    expect(at("https://gw.example/v1?api-version=2024-06-01")).toBe("https://gw.example/v1/chat/completions?api-version=2024-06-01")
    expect(at("https://gw.example/v1/?a=1&b=2#frag")).toBe("https://gw.example/v1/chat/completions?a=1&b=2")
    expect(at("https://gw.example/v1#frag")).toBe("https://gw.example/v1/chat/completions")
  })
  test("missing key is an error naming the env var", () => {
    expect(resolveAI({ provider: "openrouter", model: "m" }, {})).toEqual({ error: "AI: set OPENROUTER_API_KEY" })
    expect(resolveAI({ provider: "openrouter", model: "m" }, { OPENROUTER_API_KEY: "  " })).toEqual({ error: "AI: set OPENROUTER_API_KEY" })
  })
  test("local presets need no key", () => {
    const t = ok(resolveAI({ provider: "ollama", model: "llama3.2" }, {}))
    expect(t.url).toBe("http://localhost:11434/v1/chat/completions")
    expect(t.headers.Authorization).toBeUndefined()
    expect(t.maxChars).toBe(8_000)
    expect(PRESETS.lmstudio.maxChars).toBe(8_000)
  })
  test("custom: keyEnv or none, 48 000 default", () => {
    expect(ok(resolveAI({ provider: "custom", model: "m", baseURL: "http://10.0.0.5:8080/v1" }, {})).maxChars).toBe(48_000)
  })
  test("no key over http to a non-loopback host", () => {
    const cfg = { provider: "custom" as const, model: "m", keyEnv: "K" }
    expect(resolveAI({ ...cfg, baseURL: "http://10.0.0.5:8080/v1" }, { K: "k" })).toEqual({ error: "AI: won't send the key over http to 10.0.0.5:8080" })
    for (const b of ["http://localhost:8080/v1", "http://127.0.0.1/v1", "http://127.9.9.9/v1", "http://[::1]:8080/v1"])
      expect("error" in resolveAI({ ...cfg, baseURL: b }, { K: "k" })).toBe(false)
  })
})

describe("request", () => {
  const T = {
    url: "http://localhost:11434/v1/chat/completions",
    host: "localhost:11434",
    headers: { "Content-Type": "application/json" },
    model: "llama3.2",
    maxChars: 1000,
  }
  test("noteText drops front matter and comments", () => {
    expect(noteText("---\ntitle: x\n---\n# Hi\n\nkeep %%secret%% this\n%%\nhidden\n%%\n")).toBe("# Hi\n\nkeep  this")
    expect(noteText("---\ntitle: x\n---\n\n%%only%%\n")).toBe("")
  })
  test("clip counts code points, never splits a pair, marks the cut", () => {
    expect(clip("abc", 3)).toBe("abc")
    expect(clip("abcd", 3)).toBe("abc\n[truncated]")
    expect(clip("😀😀😀", 2)).toBe("😀😀\n[truncated]")
  })
  test("redirects are not followed: the body only goes to the configured endpoint, the 3xx is its own failure", async () => {
    expect(buildRequest(T, "s", "u").init.redirect).toBe("manual")
    let hits = 0
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (hits++, new Response("{}")) })
    const first = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/x` } }),
    })
    try {
      const t = { ...T, url: `http://127.0.0.1:${first.port}/v1/chat/completions` }
      expect(await chat(t, { system: "s", user: "u", maxOut: 10, clean: (r) => r }, {})).toEqual({ ok: false, failure: { kind: "redirect" } })
      expect(hits).toBe(0)
      // a fetch that reports the redirect as opaque (the spec's manual mode)
      const opaque = (async () => Object.defineProperty(new Response(null, { status: 200 }), "type", { value: "opaqueredirect" })) as unknown as typeof fetch
      expect(await chat(T, { system: "s", user: "u", maxOut: 10, clean: (r) => r }, { fetch: opaque })).toEqual({ ok: false, failure: { kind: "redirect" } })
    } finally {
      first.stop(true)
      other.stop(true)
    }
  })
  test("body: model, stream, system + user as given (callers clip), no max_tokens or temperature", () => {
    const { url, init } = buildRequest(T, SYSTEM_PROMPT, "x".repeat(1200))
    expect(url).toBe(T.url)
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual(T.headers)
    const body = JSON.parse(String(init.body))
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"])
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "x".repeat(1200) },
    ])
  })
})

describe("cleanSummary", () => {
  test.each([
    ["TL;DR: A note.", "A note."],
    ["Summary: A note.", "A note."],
    ["**TL;DR:** A **bold** claim.", "A bold claim."],
    ["Uses __init__ and C# well.", "Uses __init__ and C# well."],
    ["An __important point__ here.", "An important point here."],
    ["Run `bun test` first.", "Run bun test first."],
    ["# Title\n- one\n* two\n  three", "Title one two three"],
    ["<think>hmm\nmore</think>\n\nThe answer.", "The answer."],
    ["<think>still thinking", ""],
    ["<thi", ""],
    ["  spaced\t\tout \n text ", "spaced out text"],
  ])("%p → %p", (raw, want) => expect(cleanSummary(raw)).toBe(want))
  test("idempotent", () => {
    for (const raw of ["Summary: TL;DR: - **x**", "# a\n# b", "<think></think>Summary: ok"]) expect(cleanSummary(cleanSummary(raw))).toBe(cleanSummary(raw))
  })
})

test("shortModel drops the provider prefix", () => {
  expect(shortModel("anthropic/claude-haiku-5-5")).toBe("claude-haiku-5-5")
  expect(shortModel("llama3.2")).toBe("llama3.2")
  expect(shortModel("hf.co/user/model:Q4")).toBe("model:Q4")
})

describe("extractJSON", () => {
  test.each([
    ['{"queries": ["a"]}', { queries: ["a"] }],
    ['```json\n{"a": 1}\n```', { a: 1 }],
    ["```\n[1, 2]\n```", [1, 2]],
    ['Sure! Here: {"a": {"b": 2}} Hope it helps.', { a: { b: 2 } }],
    ['<think>maybe {"x": 0}?</think>\n{"a": 1}', { a: 1 }],
    ['<think>[1]</think>```json\n{"answers": []}\n```', { answers: [] }],
    ['  [ {"id": "c3"} ] trailing', [{ id: "c3" }]],
  ] as const)("%p", (raw, want) => expect(extractJSON(raw)).toEqual(want))
  test.each(["", "no json here", '{"a": ', '<think>{"a": 1}', "{broken}", "] backwards ["])("garbage %p → undefined", (raw) =>
    expect(extractJSON(raw)).toBeUndefined(),
  )
})

describe("tokens", () => {
  test("code points / 4, rounded up; astral characters count once", () => {
    expect(tokens("")).toBe(0)
    expect(tokens("abcd")).toBe(1)
    expect(tokens("abcde")).toBe(2)
    expect(tokens("😀😀😀😀")).toBe(1) // 4 code points, 8 UTF-16 units
  })
  test.each([
    [0, "~0 tokens"],
    [850, "~850 tokens"],
    [1000, "~1k tokens"],
    [1300, "~1.3k tokens"],
    [1349, "~1.3k tokens"],
    [12_400, "~12k tokens"],
  ])("fmtTokens(%p) = %p", (n, want) => expect(fmtTokens(n)).toBe(want))
})

const enc = new TextEncoder()
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const texts = (evs: AIEvent[]) => evs.flatMap((e) => (e.kind === "text" ? [e.text] : [])).join("")
const T = {
  url: "http://localhost:11434/v1/chat/completions",
  host: "localhost:11434",
  headers: { "Content-Type": "application/json" },
  model: "m",
  maxChars: 8000,
}
const reply = (body: BodyInit | null, init: ResponseInit = { headers: { "content-type": "text/event-stream" } }) =>
  (async () => new Response(body, init)) as unknown as typeof fetch
const stream = (chunks: (string | Uint8Array)[], close = true) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch)
      if (close) c.close()
    },
  })

describe("sseParser", () => {
  test("lines and JSON split anywhere, \\r\\n, comments, keep-alives, [DONE]", () => {
    const whole = (": OPENROUTER PROCESSING\n\n" + delta("Hello ") + "\n" + delta("world") + "data: [DONE]\n\n").replace(/\n/g, "\r\n")
    for (const step of [1, 3, 7, 64]) {
      const p = sseParser()
      const evs: AIEvent[] = []
      for (let i = 0; i < whole.length; i += step) evs.push(...p.push(whole.slice(i, i + step)))
      evs.push(...p.end())
      expect(texts(evs)).toBe("Hello world")
      expect(evs.at(-1)).toEqual({ kind: "done" })
    }
  })
  test("a multi-byte character split across byte chunks decodes cleanly", () => {
    const bytes = enc.encode(delta("Zażółć 😀"))
    const p = sseParser()
    const evs = [...Array.from(bytes, (b) => p.push(new Uint8Array([b]))).flat(), ...p.end()]
    expect(texts(evs)).toBe("Zażółć 😀")
  })
  test("a final line without a newline is read on end()", () => {
    const p = sseParser()
    expect(p.push(delta("a").trimEnd())).toEqual([])
    expect(texts(p.end())).toBe("a")
  })
  test("mid-stream error chunk and finish reasons", () => {
    const p = sseParser()
    expect(p.push(`data: {"error":{"message":"Provider overloaded"},"choices":[{"delta":{},"finish_reason":"error"}]}\n\n`)).toEqual([
      { kind: "error", message: "Provider overloaded" },
    ])
    expect(p.push(`data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n`)).toEqual([{ kind: "finish", reason: "length" }])
  })
  test("reasoning deltas and junk yield no text", () => {
    const p = sseParser()
    expect(p.push(`data: {"choices":[{"delta":{"reasoning":"hmm","reasoning_content":"x"}}]}\n\ndata: not json\n\nevent: ping\n\n`)).toEqual([])
  })
})

describe("replies", () => {
  test("errMessage reads object, array, string and top-level message shapes", () => {
    expect(errMessage({ error: { message: "bad" } })).toBe("bad")
    expect(errMessage([{ error: { code: 400, message: "API key not valid" } }])).toBe("API key not valid")
    expect(errMessage({ error: "nope" })).toBe("nope")
    expect(errMessage({ message: "plain" })).toBe("plain")
    expect(errMessage("<html>")).toBeUndefined()
  })
  test("jsonReply: whole text, error, or unexpected", () => {
    expect(jsonReply({ choices: [{ message: { content: "All of it." } }] })).toEqual({ text: "All of it." })
    expect(jsonReply({ error: { message: "bad model" } })).toEqual({ failure: { kind: "message", message: "bad model" } })
    expect(jsonReply({ ok: true })).toEqual({ failure: { kind: "unexpected" } })
  })
})

describe("aiError", () => {
  const C = { host: "openrouter.ai", keyEnv: "OPENROUTER_API_KEY", key: "sk-secret" }
  test.each([
    [{ kind: "status", status: 401 }, "AI: key rejected (OPENROUTER_API_KEY)"],
    [{ kind: "status", status: 403, message: "x" }, "AI: key rejected (OPENROUTER_API_KEY)"],
    [{ kind: "status", status: 404 }, "AI: model or endpoint not found"],
    [{ kind: "status", status: 429 }, "AI: rate limited"],
    [{ kind: "status", status: 500, message: "upstream down" }, "AI: upstream down"],
    [{ kind: "status", status: 502 }, "AI: 502 from openrouter.ai"],
    [{ kind: "status", status: 503, message: "   " }, "AI: 503 from openrouter.ai"],
    [{ kind: "message", message: "Provider overloaded" }, "AI: Provider overloaded"],
    [{ kind: "length" }, "AI: summary cut short"],
    [{ kind: "tooLong" }, "AI: summary too long"],
    [{ kind: "unexpected" }, "AI: unexpected reply from openrouter.ai"],
    [{ kind: "network" }, "AI: can't reach openrouter.ai"],
    [{ kind: "redirect" }, "AI: openrouter.ai redirects · set baseURL to the final URL"],
    [{ kind: "idle" }, "AI: no answer for 60 s"],
    [{ kind: "total" }, "AI: no summary after 180 s"],
    [{ kind: "empty" }, "AI: empty summary"],
  ] as const)("%p", (f, want) => expect(aiError(f, C)).toBe(want))
  test("401/403 when no key was sent", () => {
    expect(aiError({ kind: "status", status: 401 }, { host: "h" })).toBe("AI: unauthorized · set keyEnv")
    expect(aiError({ kind: "status", status: 403 }, { host: "h" })).toBe("AI: unauthorized · set keyEnv")
  })
  test("redacts the key, strips control characters, cuts to 80 columns", () => {
    const msg = aiError({ kind: "message", message: "bad key sk-secret\x1b[31m " + "x".repeat(200) }, C)
    expect(msg).not.toContain("sk-secret")
    expect(msg).not.toContain("\x1b")
    expect(msg.startsWith("AI: bad key …")).toBe(true)
    expect(Bun.stringWidth(msg.slice("AI: ".length))).toBe(80)
    expect(msg.endsWith("…")).toBe(true)
  })
  test("Gemini bad key: 400 with an array body", () => {
    const body = [{ error: { code: 400, message: "Please pass a valid API key", status: "INVALID_ARGUMENT" } }]
    expect(
      aiError(
        { kind: "status", status: 400, message: errMessage(body) },
        { host: "generativelanguage.googleapis.com", keyEnv: "GEMINI_API_KEY", key: "AIza-secret" },
      ),
    ).toBe("AI: Please pass a valid API key")
  })
  test("a background note is named", () => {
    expect(aiError({ kind: "status", status: 429 }, { ...C, note: "groceries" })).toBe("AI · groceries: rate limited")
  })
  test("nouns name what was asked for; summary by default", () => {
    for (const noun of ["summary", "gloss", "explanation", "answer"] as const) {
      expect(aiError({ kind: "length" }, { ...C, noun })).toBe(`AI: ${noun} cut short`)
      expect(aiError({ kind: "tooLong" }, { ...C, noun })).toBe(`AI: ${noun} too long`)
      expect(aiError({ kind: "total" }, { ...C, noun })).toBe(`AI: no ${noun} after 180 s`)
      expect(aiError({ kind: "empty" }, { ...C, noun })).toBe(`AI: empty ${noun}`)
      expect(aiError({ kind: "invalid" }, { ...C, noun })).toBe(`AI: no usable ${noun}`)
    }
    expect(aiError({ kind: "invalid" }, C)).toBe("AI: no usable summary")
  })
  test("the noun leaves transport errors alone and works with the background prefix", () => {
    expect(aiError({ kind: "status", status: 429 }, { ...C, noun: "gloss" })).toBe("AI: rate limited")
    expect(aiError({ kind: "idle" }, { ...C, noun: "answer" })).toBe("AI: no answer for 60 s")
    expect(aiError({ kind: "empty" }, { ...C, noun: "gloss", note: "Why another reader?" })).toBe("AI · Why another reader?: empty gloss")
  })
})

describe("chat · transport (through summarize)", () => {
  test("streams deltas and returns the cleaned text", async () => {
    const seen: string[] = []
    const r = await summarize(T, "note", {
      fetch: reply(stream([delta("TL;DR: "), delta("**Short** note."), "data: [DONE]\n\n"])),
      onDelta: (raw) => seen.push(raw),
    })
    expect(r).toEqual({ ok: true, text: "Short note." })
    expect(seen).toEqual(["TL;DR: ", "TL;DR: **Short** note."])
  })
  test("multi-byte characters split across chunks stay whole", async () => {
    const bytes = enc.encode(delta("Zażółć 🍲.") + "data: [DONE]\n\n")
    const r = await summarize(T, "n", { fetch: reply(stream(Array.from(bytes, (b) => Uint8Array.of(b)))) })
    expect(r).toEqual({ ok: true, text: "Zażółć 🍲." })
  })
  test("sends the built request with the signal", async () => {
    let got: RequestInit | undefined
    const f = (async (_u: unknown, init: RequestInit) => (
      (got = init), new Response(stream(["data: [DONE]\n\n"]), { headers: { "content-type": "text/event-stream" } })
    )) as unknown as typeof fetch
    await summarize(T, "note", { fetch: f })
    expect(JSON.parse(String(got!.body)).messages[1].content).toBe("note")
    expect(got!.signal).toBeInstanceOf(AbortSignal)
  })
  test("a JSON 200 body (stream ignored)", async () => {
    const r = await summarize(T, "n", {
      fetch: reply(JSON.stringify({ choices: [{ message: { content: "Whole." } }] }), { headers: { "content-type": "application/json" } }),
    })
    expect(r).toEqual({ ok: true, text: "Whole." })
  })
  test("unexpected content type", async () => {
    const r = await summarize(T, "n", { fetch: reply("<html>", { headers: { "content-type": "text/html" } }) })
    expect(r).toEqual({ ok: false, failure: { kind: "unexpected" } })
  })
  test("error statuses carry the server message, HTML bodies don't", async () => {
    expect(await summarize(T, "n", { fetch: reply(JSON.stringify([{ error: { message: "API key not valid" } }]), { status: 400 }) })).toEqual({
      ok: false,
      failure: { kind: "status", status: 400, message: "API key not valid" },
    })
    expect(await summarize(T, "n", { fetch: reply("<html>bad gateway</html>", { status: 502 }) })).toEqual({
      ok: false,
      failure: { kind: "status", status: 502, message: undefined },
    })
  })
  test("mid-stream error, finish length, empty, too long", async () => {
    expect(await summarize(T, "n", { fetch: reply(stream([delta("par"), `data: {"error":{"message":"boom"}}\n\n`])) })).toEqual({
      ok: false,
      failure: { kind: "message", message: "boom" },
    })
    expect(await summarize(T, "n", { fetch: reply(stream([delta("par"), `data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n`])) })).toEqual({
      ok: false,
      failure: { kind: "length" },
    })
    expect(await summarize(T, "n", { fetch: reply(stream([delta("<think>only thoughts</think>"), "data: [DONE]\n\n"])) })).toEqual({
      ok: false,
      failure: { kind: "empty" },
    })
    expect(await summarize(T, "n", { fetch: reply(stream([delta("x ".repeat(MAX_SUMMARY))], false)) })).toEqual({ ok: false, failure: { kind: "tooLong" } })
  })
  test("network failure", async () => {
    const f = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    expect(await summarize(T, "n", { fetch: f })).toEqual({ ok: false, failure: { kind: "network" } })
  })
  test("idle timeout: no bytes", async () => {
    expect(await summarize(T, "n", { fetch: reply(stream([], false)), idleMs: 30 })).toEqual({ ok: false, failure: { kind: "idle" } })
  })
  test("total timeout: bytes keep coming, no end", async () => {
    const drip = new ReadableStream<Uint8Array>({
      async pull(c) {
        await Bun.sleep(5)
        c.enqueue(enc.encode(": ping\n\n"))
      },
    })
    expect(await summarize(T, "n", { fetch: reply(drip), idleMs: 1000, totalMs: 60 })).toEqual({ ok: false, failure: { kind: "total" } })
  })
  test("abort through signal resolves cancelled even if the body never ends", async () => {
    const ac = new AbortController()
    const p = summarize(T, "n", { fetch: reply(stream([delta("par")], false)), signal: ac.signal })
    await Bun.sleep(10)
    ac.abort()
    expect(await p).toEqual({ ok: false, cancelled: true })
  })
  test("abort while an error body never ends", async () => {
    const ac = new AbortController()
    const p = summarize(T, "n", { fetch: reply(stream(["<html>"], false), { status: 502 }), signal: ac.signal })
    await Bun.sleep(10)
    ac.abort()
    expect(await p).toEqual({ ok: false, cancelled: true })
  })
  test("an already aborted signal never fetches", async () => {
    const ac = new AbortController()
    ac.abort()
    let called = false
    const f = (async () => ((called = true), new Response(null))) as unknown as typeof fetch
    expect(await summarize(T, "n", { fetch: f, signal: ac.signal })).toEqual({ ok: false, cancelled: true })
    expect(called).toBe(false)
  })
  test("the connection stays open while the reply is read and is closed once it settles", async () => {
    let sig: AbortSignal | undefined
    const f = (async (_url: string, init: RequestInit) => {
      sig = init.signal ?? undefined
      return new Response(stream([delta("hi"), "data: [DONE]\n\n"]), { headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch
    const open: boolean[] = []
    expect(await summarize(T, "n", { fetch: f, onDelta: () => open.push(!sig!.aborted) })).toEqual({ ok: true, text: "hi" })
    expect(open).toEqual([true])
    expect(sig!.aborted).toBe(true)
  })
})

test("PROMPT_V is the TL;DR version and stays 1: cached summaries don't turn outdated", () => {
  expect(PROMPTS).toEqual({ tldr: 1, gloss: 1, delta: 2, ask: 1, rerank: 1 })
  expect(PROMPT_V).toBe(PROMPTS.tldr)
  expect(PROMPT_V).toBe(1)
})

describe("stripThink", () => {
  test.each([
    ["plain", "plain"],
    ["<think>a</think>{}", "{}"],
    ["  <think>a</think> {}", " {}"],
    ["<think>still", ""],
    ["<thi", ""],
    ["a <think>b</think>", "a <think>b</think>"],
  ])("%p", (raw, want) => expect(stripThink(raw)).toBe(want))
  test("cleanReply: the reply without its think block, trimmed", () => {
    expect(cleanReply("  <think>a</think> {} \n")).toBe("{}")
    expect(cleanReply("<thi")).toBe("")
  })
})

describe("summaryRequest", () => {
  test("the note clipped to maxChars under SYSTEM_PROMPT, cleaned by cleanSummary, capped at MAX_SUMMARY", () => {
    expect(summaryRequest("abcdef", 3)).toEqual({ system: SYSTEM_PROMPT, user: "abc\n[truncated]", maxOut: MAX_SUMMARY, clean: cleanSummary })
    expect(summaryRequest("note", 1000).user).toBe("note")
  })
})

describe("chat", () => {
  const REQ = { system: "S", user: "U", maxOut: 20, clean: (r: string) => r.trim() }
  const sse = { headers: { "content-type": "text/event-stream" } }
  const capture = () => {
    const sent: { body?: { messages: { role: string; content: string }[] } } = {}
    const f = (async (_u: unknown, init: RequestInit) => (
      (sent.body = JSON.parse(String(init.body))), new Response(stream([delta(' {"a": 1} '), "data: [DONE]\n\n"]), sse)
    )) as unknown as typeof fetch
    return { sent, f }
  }

  test("sends system and user as given; returns the cleaned text and the raw reply", async () => {
    const { sent, f } = capture()
    expect(await chat(T, REQ, { fetch: f })).toEqual({ ok: true, text: '{"a": 1}', raw: ' {"a": 1} ' })
    expect(sent.body!.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ])
  })
  test("a leading <think> block doesn't count toward maxOut when clean uses stripThink", async () => {
    const think = "<think>" + "x".repeat(300) + "</think>"
    const body = () => [delta(think.slice(0, 150)), delta(think.slice(150)), delta('{"queries":["a"]}'), "data: [DONE]\n\n"]
    const clean = (r: string) => stripThink(r).trim()
    expect(await chat(T, { ...REQ, maxOut: 40, clean }, { fetch: reply(stream(body())) })).toEqual({
      ok: true,
      text: '{"queries":["a"]}',
      raw: think + '{"queries":["a"]}',
    })
    // a plain trim fails on the same reply
    expect(await chat(T, { ...REQ, maxOut: 40 }, { fetch: reply(stream(body())) })).toEqual({ ok: false, failure: { kind: "tooLong" } })
  })
  test("runaway thinking still ends: the raw reply is capped", async () => {
    const f = reply(stream([delta("<think>" + "x".repeat(70_000))], false))
    expect(await chat(T, { ...REQ, clean: (r) => stripThink(r).trim() }, { fetch: f })).toEqual({ ok: false, failure: { kind: "tooLong" } })
  })
  test("header values and the key are redacted from failure messages", async () => {
    const t = { ...T, headers: { ...T.headers, "api-key": "s3cret-value" }, key: "sk-abc123" }
    const body = JSON.stringify({ error: { message: "bad api-key s3cret-value / sk-abc123" } })
    const json = { status: 400, headers: { "content-type": "application/json" } }
    const r = await chat(t, REQ, { fetch: reply(body, json) })
    expect(JSON.stringify(r)).not.toContain("s3cret-value")
    expect(JSON.stringify(r)).not.toContain("sk-abc123")
    const ev = await chat(t, REQ, { fetch: reply(stream([`data: {"error":{"message":"echo s3cret-value"}}\n\n`])) })
    expect(JSON.stringify(ev)).not.toContain("s3cret-value")
  })
  test("chat doesn't clip; summarize clips to the target's maxChars", async () => {
    const a = capture()
    await chat({ ...T, maxChars: 3 }, { ...REQ, user: "abcdef" }, { fetch: a.f })
    expect(a.sent.body!.messages[1]!.content).toBe("abcdef")
    const b = capture()
    await summarize({ ...T, maxChars: 3 }, "abcdef", { fetch: b.f })
    expect(b.sent.body!.messages[1]!.content).toBe("abc\n[truncated]")
    expect(b.sent.body!.messages[0]!.content).toBe(SYSTEM_PROMPT)
  })
  test("maxOut caps the cleaned text, per call, mid-stream", async () => {
    // the stream never closes: only the cap can end it
    expect(await chat(T, { ...REQ, maxOut: 5 }, { fetch: reply(stream([delta("123456")], false)) })).toEqual({ ok: false, failure: { kind: "tooLong" } })
    expect(await chat(T, { ...REQ, maxOut: 5, clean: (r) => r.slice(0, 3) }, { fetch: reply(stream([delta("123456"), "data: [DONE]\n\n"])) })).toEqual({
      ok: true,
      text: "123",
      raw: "123456",
    })
  })
  test("empty is judged on the cleaned text", async () => {
    expect(await chat(T, { ...REQ, clean: () => "" }, { fetch: reply(stream([delta("words"), "data: [DONE]\n\n"])) })).toEqual({
      ok: false,
      failure: { kind: "empty" },
    })
  })
  test("a JSON 200 body returns raw too", async () => {
    const r = await chat(T, REQ, {
      fetch: reply(JSON.stringify({ choices: [{ message: { content: " [1] " } }] }), { headers: { "content-type": "application/json" } }),
    })
    expect(r).toEqual({ ok: true, text: "[1]", raw: " [1] " })
  })
  test("onDelta gets the raw accumulated text", async () => {
    const seen: string[] = []
    await chat(T, REQ, { fetch: reply(stream([delta("a "), delta("b"), "data: [DONE]\n\n"])), onDelta: (raw) => seen.push(raw) })
    expect(seen).toEqual(["a ", "a b"])
  })
  test("summarize keeps its result shape: no raw", async () => {
    expect(await summarize(T, "n", { fetch: reply(stream([delta("TL;DR: Ok."), "data: [DONE]\n\n"])) })).toEqual({ ok: true, text: "Ok." })
  })
})

describe("ai-config", () => {
  test("parseGlossStyle with a fallback: a valid style wins, anything else is the fallback", () => {
    expect(aiConfig.parseGlossStyle("simplify", "explain")).toBe("simplify")
    expect(aiConfig.parseGlossStyle("translate:pl", "explain")).toBe("translate:pl")
    for (const bad of [undefined, null, 3, "Explain", "translate:", "translate:polish"]) {
      expect(aiConfig.parseGlossStyle(bad, "explain")).toBe("explain")
      expect(aiConfig.parseGlossStyle(bad, "simplify")).toBe("simplify")
    }
  })
})

test("the timeout texts are derived from IDLE_MS and TOTAL_MS (60 s and 180 s today)", () => {
  expect([IDLE_MS, TOTAL_MS]).toEqual([60_000, 180_000])
  expect(aiError({ kind: "idle" }, { host: "h" })).toBe(`AI: no answer for ${IDLE_MS / 1000} s`)
  expect(aiError({ kind: "total" }, { host: "h", noun: "gloss" })).toBe(`AI: no gloss after ${TOTAL_MS / 1000} s`)
})
