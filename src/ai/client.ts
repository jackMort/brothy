/**
 * AI: one OpenAI-compatible client over `fetch` (`chat`), used by the TL;DR (`summarize`) and
 * the features built on it. Everything but `chat` is pure; caches live in `ai/cache.ts` and the
 * `ai` config block in `ai/config.ts`.
 */

import { isRecord } from "../lib/json"
import { safeLine } from "../lib/spans"
import { truncate } from "../lib/text"
import { parseFrontMatter } from "../markdown/frontmatter"
import { stripComments } from "../markdown/lexer"
import type { AITarget } from "./config"

/** What is summarized and hashed: the body without front matter and `%%comments%%`. */
export function noteText(src: string): string {
  return stripComments(parseFrontMatter(src).body).trim()
}

/** At most `max` code points (a surrogate pair is never split), marked when cut. */
export function clip(text: string, max: number): string {
  let i = 0
  for (let n = 0; i < text.length && n < max; n++) i += text.codePointAt(i)! > 0xffff ? 2 : 1
  return i < text.length ? text.slice(0, i) + "\n[truncated]" : text
}

/** The TL;DR's system prompt: bump `PROMPTS.tldr` (ai/config.ts) with any change. */
export const SYSTEM_PROMPT =
  "Summarize the note in 2–3 sentences, at most 60 words. Plain text only: no markdown, no lists, no preamble. Write in the same language as the note."

/** Cap on the raw reply, so a model that thinks forever still ends. */
const MAX_RAW = 64_000

/** `redirect: "manual"`: the note text only goes to the configured endpoint (a 3xx fails as `redirect`). No max_tokens (reasoning models spend it thinking) and no temperature (some models reject it). Callers clip `user`. */
export function buildRequest(t: AITarget, system: string, user: string): { url: string; init: RequestInit } {
  const body = {
    model: t.model,
    stream: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }
  return { url: t.url, init: { method: "POST", headers: t.headers, body: JSON.stringify(body), redirect: "manual" } }
}

/** Drops one leading `<think>…</think>` from a reply; "" while the tag or the block is still open. */
export function stripThink(raw: string): string {
  const s = raw.trimStart()
  if (s && "<think>".startsWith(s)) return ""
  if (!s.startsWith("<think>")) return raw
  const end = s.indexOf("</think>")
  return end < 0 ? "" : s.slice(end + "</think>".length)
}

/** The `clean` of the structured requests (ask, rerank, `D`): the reply without its think block, trimmed; they parse `raw`. */
export const cleanReply = (raw: string) => stripThink(raw).trim()

function cleanStep(s: string): string {
  s = stripThink(s.trimStart()) // "" while the tag arrives or the model is still thinking: show nothing yet
  s = s
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, (m, x: string) => (/^\w+$/.test(x) ? m : x)) // `__init__` is a name, not emphasis
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]*#+[ \t]*/gm, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/^\s*(?:TL;?DR|Summary)\s*:\s*/i, "")
  return s.replace(/\s+/g, " ").trim()
}

/** Passes of `cleanStep` before giving up on a fixed point (stripping one mark can expose another). */
const CLEAN_PASSES = 8

/** Model output as plain text; applied to the accumulated stream on every render, so it is idempotent. */
export function cleanSummary(raw: string): string {
  let s = raw
  for (let i = 0; i < CLEAN_PASSES; i++) {
    const next = cleanStep(s)
    if (next === s) break
    s = next
  }
  return s
}

/** `anthropic/claude-haiku-5-5` → `claude-haiku-5-5`. */
export const shortModel = (model: string) => model.slice(model.lastIndexOf("/") + 1) || model

/**
 * The JSON value in a model reply, or undefined: a leading `<think>…</think>` is dropped, one
 * ``` / ```json fence unwrapped, then the text from the first `{` or `[` to the last matching
 * `}` / `]` is parsed. No `response_format` is sent (not portable across presets), so prose
 * around the JSON is expected.
 */
export function extractJSON(raw: string): unknown {
  let s = stripThink(raw.trim())
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1]!
  const open = s.search(/[{[]/)
  if (open < 0) return undefined
  const close = s.lastIndexOf(s[open] === "{" ? "}" : "]")
  if (close < open) return undefined
  try {
    return JSON.parse(s.slice(open, close + 1))
  } catch {
    return undefined
  }
}

/** A rough input estimate for cost labels: a token is about 4 code points. */
export const tokens = (text: string) => Math.ceil([...text].length / 4)

/** `~850 tokens`, `~1.3k tokens`, `~12k tokens`. */
export function fmtTokens(n: number): string {
  if (n < 1000) return `~${n} tokens`
  const k = n / 1000
  return `~${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k tokens`
}

export type AIEvent =
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }
  | { kind: "finish"; reason: string }
  | { kind: "done" }

/** `error.message`, `error` as a string, or `message`; Gemini wraps errors in an array. */
export function errMessage(body: unknown): string | undefined {
  const b = Array.isArray(body) ? body[0] : body
  if (!isRecord(b)) return undefined
  const e = b.error
  if (isRecord(e) && typeof e.message === "string" && e.message) return e.message
  if (typeof e === "string" && e) return e
  if (typeof b.message === "string" && b.message) return b.message
  return undefined
}

const firstChoice = (o: Record<string, unknown>): Record<string, unknown> | undefined =>
  Array.isArray(o.choices) && isRecord(o.choices[0]) ? o.choices[0] : undefined

function chunkEvents(obj: unknown): AIEvent[] {
  if (!isRecord(obj)) return []
  if (obj.error !== undefined) return [{ kind: "error", message: errMessage(obj) ?? "stream error" }]
  const ch = firstChoice(obj)
  if (!ch) return []
  const out: AIEvent[] = []
  const content = isRecord(ch.delta) ? ch.delta.content : undefined
  if (typeof content === "string" && content) out.push({ kind: "text", text: content })
  // reasoning / reasoning_content deltas yield nothing; the idle timer counts their bytes
  if (typeof ch.finish_reason === "string") out.push({ kind: "finish", reason: ch.finish_reason })
  return out
}

/**
 * Server-sent events from arbitrary byte chunks: lines split anywhere, `\r\n`, `:` comments,
 * blank keep-alives, `data: [DONE]`. One JSON object per `data:` line (what OpenAI-compatible
 * servers send); lines that don't parse are skipped.
 */
export function sseParser() {
  const dec = new TextDecoder()
  let buf = ""
  const line = (raw: string): AIEvent[] => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (!l.startsWith("data:")) return []
    const data = l.slice("data:".length).trimStart()
    if (data === "[DONE]") return [{ kind: "done" }]
    try {
      return chunkEvents(JSON.parse(data))
    } catch {
      return []
    }
  }
  const feed = (text: string, flush: boolean) => {
    const parts = (buf + text).split("\n")
    buf = flush ? "" : parts.pop()!
    return parts.flatMap(line)
  }
  return {
    push: (chunk: Uint8Array | string) =>
      feed(typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true }), false),
    end: () => feed(dec.decode(), true),
  }
}

export type Failure =
  | { kind: "status"; status: number; message?: string }
  | { kind: "message"; message: string }
  /** `invalid`: a structured reply that failed validation entirely (set by the caller, never by `chat`) */
  /** `redirect`: the endpoint answered 3xx; the request is never re-sent to where it points */
  | { kind: "length" | "tooLong" | "unexpected" | "network" | "redirect" | "idle" | "total" | "empty" | "invalid" }

/** A 200 JSON body (a server that ignored `stream`). */
export function jsonReply(body: unknown): { text: string } | { failure: Failure } {
  const m = errMessage(body)
  if (m) return { failure: { kind: "message", message: m } }
  const ch = isRecord(body) ? firstChoice(body) : undefined
  const content = ch && isRecord(ch.message) ? ch.message.content : undefined
  return typeof content === "string" ? { text: content } : { failure: { kind: "unexpected" } }
}

export interface ErrCtx {
  host: string
  keyEnv?: string
  /** replaced by `…` in server messages */
  key?: string
  /** set when the failed request was for a note that is not current */
  note?: string
  /** what the request was for, in the failure strings; default "summary" */
  noun?: "summary" | "gloss" | "explanation" | "answer"
}
const MSG_W = 80

/** A server's own words for the toast: control characters out, the key redacted, one line. */
function serverText(m: string, ctx: ErrCtx): string {
  return truncate(safeLine(ctx.key ? m.replaceAll(ctx.key, "…") : m).trim(), MSG_W)
}

/** The toast text for an HTTP status failure: the well-known codes by name, else the server's message, else the bare status. */
function statusError(f: Extract<Failure, { kind: "status" }>, ctx: ErrCtx): string {
  if (f.status === 401 || f.status === 403)
    return ctx.key ? `key rejected (${ctx.keyEnv})` : "unauthorized · set keyEnv"
  if (f.status === 404) return "model or endpoint not found"
  if (f.status === 429) return "rate limited"
  return f.message?.trim() ? serverText(f.message, ctx) : `${f.status} from ${ctx.host}`
}

/** What failed, without the toast's `AI: ` / `AI · <note>: ` prefix: the text an AI block shows where its reply would be. */
export function aiMessage(f: Failure, ctx: ErrCtx): string {
  const noun = ctx.noun ?? "summary"
  switch (f.kind) {
    case "status":
      return statusError(f, ctx)
    case "message":
      return serverText(f.message, ctx)
    case "length":
      return `${noun} cut short`
    case "tooLong":
      return `${noun} too long`
    case "unexpected":
      return `unexpected reply from ${ctx.host}`
    case "network":
      return `can't reach ${ctx.host}`
    case "redirect":
      return `${ctx.host} redirects · set baseURL to the final URL`
    case "idle":
      return `no answer for ${IDLE_MS / 1000} s`
    case "total":
      return `no ${noun} after ${TOTAL_MS / 1000} s`
    case "empty":
      return `empty ${noun}`
    case "invalid":
      return `no usable ${noun}`
  }
}

/** The error toast for a failure (spec: Errors table). */
export const aiError = (f: Failure, ctx: ErrCtx) => (ctx.note ? `AI · ${ctx.note}: ` : "AI: ") + aiMessage(f, ctx)

/** A request with no bytes for this long fails as `idle`. */
export const IDLE_MS = 60_000
/** A request still running after this long fails as `total`. */
export const TOTAL_MS = 180_000
/** Cleaned summaries longer than this abort the request. */
export const MAX_SUMMARY = 1200

export interface ChatOpts {
  fetch?: typeof fetch
  signal?: AbortSignal
  /** the raw accumulated text after each delta; render it through the request's `clean` */
  onDelta?: (raw: string) => void
  idleMs?: number
  totalMs?: number
}

/** One request. The caller builds (and clips) `user`; `clean` turns the reply into what is shown, `maxOut` caps that. */
export interface ChatReq {
  system: string
  user: string
  /** cleaned text longer than this aborts the request (`tooLong`) */
  maxOut: number
  /** applied to the accumulated stream on every delta: idempotent and cheap */
  clean: (raw: string) => string
}
/** `raw` is the reply as received, for callers that parse structure (`extractJSON`). */
export type ChatResult =
  | { ok: true; text: string; raw: string }
  | { ok: false; failure: Failure }
  | { ok: false; cancelled: true }
/** `ChatResult` without `raw`. */
export type SummaryResult =
  | { ok: true; text: string }
  | { ok: false; failure: Failure }
  | { ok: false; cancelled: true }

const fail = (failure: Failure): ChatResult => ({ ok: false, failure })
const finish = (raw: string, req: ChatReq): ChatResult => {
  const text = req.clean(raw)
  if (!text) return fail({ kind: "empty" })
  if (text.length > req.maxOut) return fail({ kind: "tooLong" })
  return { ok: true, text, raw }
}

/** Shortest key or header value scrubbed from a message: a shorter one would shred ordinary words. */
const MIN_SECRET = 4

/**
 * The only network I/O. Never throws: every outcome is a result. The idle timer is re-armed by
 * any bytes (reasoning deltas and `:` comments count); aborting `o.signal` resolves `cancelled`.
 */
export async function chat(t: AITarget, req: ChatReq, o: ChatOpts = {}): Promise<ChatResult> {
  const r = await send(t, req, o)
  if (r.ok || !("failure" in r)) return r
  const f = r.failure
  const text = f.kind === "message" || f.kind === "status" ? f.message : undefined
  if (!text) return r
  // a server may echo a secret back: the key and every custom header value never reach a message
  let out = text
  for (const v of [t.key, ...Object.values(t.headers)])
    if (v && v.length >= MIN_SECRET && v !== "application/json") out = out.replaceAll(v, "…")
  return out === text ? r : { ok: false, failure: { ...f, message: out } as Failure }
}

/** One request's lifetime: the idle and total timers, the caller's abort, and why it stopped early. */
interface Guard {
  /** the fetch's signal: aborted by either timer, the caller's signal or `close` */
  signal: AbortSignal
  /** re-arms the idle timer */
  poke: () => void
  /** why the request stopped early, if it was stopped */
  ended: () => ChatResult | null
  /** a whole-body read that ignores the fetch signal (stubs, some proxies) still settles on abort */
  whole: <T>(p: Promise<T>) => Promise<T>
  /** clears the timers and closes the connection (stops billing where supported) */
  close: () => void
}

/** Arms the total timer and follows `o.signal`; the idle timer starts on the first `poke`. */
function guard(o: ChatOpts): Guard {
  const ctl = new AbortController()
  let why: "idle" | "total" | null = null
  const stop = (w: "idle" | "total") => {
    why ??= w
    ctl.abort()
  }
  let idle: ReturnType<typeof setTimeout> | undefined
  const total = setTimeout(() => stop("total"), o.totalMs ?? TOTAL_MS)
  const onAbort = () => ctl.abort()
  o.signal?.addEventListener("abort", onAbort)
  const aborted = new Promise<never>((_, reject) =>
    ctl.signal.addEventListener("abort", () => reject(new Error("aborted"))),
  )
  aborted.catch(() => {})
  return {
    signal: ctl.signal,
    poke: () => {
      clearTimeout(idle)
      idle = setTimeout(() => stop("idle"), o.idleMs ?? IDLE_MS)
    },
    ended: () => {
      if (why) return fail({ kind: why })
      return ctl.signal.aborted ? { ok: false, cancelled: true } : null
    },
    whole: (p) => Promise.race([p, aborted]),
    close: () => {
      clearTimeout(idle)
      clearTimeout(total)
      o.signal?.removeEventListener("abort", onAbort)
      ctl.abort()
    },
  }
}

/** A non-2xx answer: the server's message when the body is JSON that has one, else the status alone. */
async function statusFailure(res: Response, g: Guard): Promise<ChatResult> {
  const body = await g.whole(res.text()).catch(() => "")
  let message: string | undefined
  try {
    message = errMessage(JSON.parse(body))
  } catch {
    // not JSON (an HTML error page): status only
  }
  return g.ended() ?? fail({ kind: "status", status: res.status, message })
}

/** A 200 JSON body (a server that ignored `stream`). */
async function jsonResult(res: Response, req: ChatReq, g: Guard): Promise<ChatResult> {
  let body: unknown
  try {
    body = await g.whole(res.json())
  } catch {
    return g.ended() ?? fail({ kind: "unexpected" })
  }
  const r = jsonReply(body)
  return "failure" in r ? fail(r.failure) : finish(r.text, req)
}

/** Stream events into `acc.raw`: a failure, "done" at the end marker, else null to read on. */
function takeEvents(evs: AIEvent[], acc: { raw: string }, req: ChatReq, o: ChatOpts): Failure | "done" | null {
  for (const ev of evs) {
    if (ev.kind === "error") return { kind: "message", message: ev.message }
    if (ev.kind === "done") return "done"
    if (ev.kind === "finish") {
      if (ev.reason === "length") return { kind: "length" }
      if (ev.reason === "error") return { kind: "message", message: "stream failed" }
      continue
    }
    acc.raw += ev.text
    if (acc.raw.length > MAX_RAW || req.clean(acc.raw).length > req.maxOut) return { kind: "tooLong" }
    o.onDelta?.(acc.raw)
  }
  return null
}

/** An SSE body, read until its end marker or its end; any bytes re-arm the idle timer. */
async function streamResult(
  body: NonNullable<Response["body"]>,
  req: ChatReq,
  o: ChatOpts,
  g: Guard,
): Promise<ChatResult> {
  const reader = body.getReader()
  // a body that ignores the fetch signal still ends: a cancelled read resolves done
  g.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}))
  const p = sseParser()
  const acc = { raw: "" }
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>
    try {
      chunk = await reader.read()
    } catch {
      return g.ended() ?? fail({ kind: "network" })
    }
    const early = g.ended()
    if (early) return early
    const r = chunk.done ? takeEvents(p.end(), acc, req, o) : (g.poke(), takeEvents(p.push(chunk.value), acc, req, o))
    if (r && r !== "done") return fail(r)
    if (r === "done" || chunk.done) break
  }
  return finish(acc.raw, req)
}

/** The answer by its kind: a redirect or error status fails, a JSON or SSE body is read, anything else is unexpected. */
function reply(res: Response, req: ChatReq, o: ChatOpts, g: Guard): Promise<ChatResult> | ChatResult {
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return fail({ kind: "redirect" })
  if (!res.ok) return statusFailure(res, g)
  const type = res.headers.get("content-type") ?? ""
  if (type.includes("application/json")) return jsonResult(res, req, g)
  if (!type.includes("text/event-stream") || !res.body) return fail({ kind: "unexpected" })
  return streamResult(res.body, req, o, g)
}

async function send(t: AITarget, req: ChatReq, o: ChatOpts): Promise<ChatResult> {
  if (o.signal?.aborted) return { ok: false, cancelled: true }
  const g = guard(o)
  try {
    g.poke()
    const { url, init } = buildRequest(t, req.system, req.user)
    let res: Response
    try {
      res = await (o.fetch ?? fetch)(url, { ...init, signal: g.signal })
    } catch {
      return g.ended() ?? fail({ kind: "network" })
    }
    const stopped = g.ended() // aborted while the headers arrived: a reader made now would never see the abort
    if (stopped) return stopped
    g.poke()
    // awaited here, so `close` runs only once the body is read
    return await reply(res, req, o, g)
  } finally {
    g.close() // closes the connection on every early return
  }
}

/** The TL;DR request: the note clipped to `maxChars` (the target's), cleaned to plain text, at most MAX_SUMMARY. */
export function summaryRequest(text: string, maxChars: number): ChatReq {
  return { system: SYSTEM_PROMPT, user: clip(text, maxChars), maxOut: MAX_SUMMARY, clean: cleanSummary }
}

/** The TL;DR: `summaryRequest` for the target, as a `SummaryResult`. */
export async function summarize(t: AITarget, text: string, o: ChatOpts = {}): Promise<SummaryResult> {
  const r = await chat(t, summaryRequest(text, t.maxChars), o)
  return r.ok ? { ok: true, text: r.text } : r
}
