/**
 * AI: one OpenAI-compatible client over `fetch` (`chat`), used by the TL;DR (`summarize`) and
 * the features built on it. Everything but `chat` is pure; caches live in `summaries.ts`.
 */

import { parseFrontMatter, stripComments } from "./markdown"
import { safeLine } from "./spans"
import { truncate } from "./status"

export type Provider = "openai" | "openrouter" | "anthropic" | "gemini" | "ollama" | "lmstudio" | "custom"
export interface Preset {
  baseURL: string
  /** env var holding the key; none for local servers */
  keyEnv?: string
  /** input limit in code points */
  maxChars: number
}

export const PRESETS: Record<Exclude<Provider, "custom">, Preset> = {
  openai: { baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", maxChars: 48_000 },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", maxChars: 48_000 },
  anthropic: { baseURL: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", maxChars: 48_000 },
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", maxChars: 48_000 },
  // the OpenAI API can't set Ollama's context size, and it cuts an over-long prompt from the front
  ollama: { baseURL: "http://localhost:11434/v1", maxChars: 8_000 },
  lmstudio: { baseURL: "http://localhost:1234/v1", maxChars: 8_000 },
}
const PROVIDERS: readonly Provider[] = [...(Object.keys(PRESETS) as Provider[]), "custom"]
const CUSTOM_MAX = 48_000

/** Prompt versions per feature: bump one whenever its prompt changes, and its cached results show as outdated. */
export const PROMPTS = { tldr: 1, gloss: 1, delta: 2, ask: 1, rerank: 1 } as const
/** The TL;DR's version (`SYSTEM_PROMPT`); what `summaries.json` entries carry as `v`. */
export const PROMPT_V = PROMPTS.tldr

/** The validated `ai` block of config.json. */
export interface AIConfig {
  provider: Provider
  model: string
  baseURL?: string
  keyEnv?: string
  maxChars?: number
  headers?: Record<string, string>
  /** zen gloss style; absent means "explain" */
  gloss?: GlossStyle
}

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v)
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** `ai.gloss`: how zen explains a section. Lives here, not in gloss.ts, so ai.ts never imports gloss.ts (gloss.ts imports chat from here). */
export type GlossStyle = "explain" | "simplify" | `translate:${string}`
/** a BCP 47-ish language tag: `pl`, `pt-BR`, `zh-Hant-TW` */
const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

export function parseGlossStyle(v: unknown): GlossStyle | undefined {
  if (v === "explain" || v === "simplify") return v
  if (typeof v === "string" && v.startsWith("translate:") && LANG_TAG.test(v.slice("translate:".length))) return v as GlossStyle
  return undefined
}

/** An http(s) base without userinfo (fetch refuses credentials in URLs). */
function baseURL(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  try {
    const u = new URL(v)
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * `provider`, `model` and (for custom) `baseURL` are required: one bad and the block is dropped
 * (AI off). Every other field that is invalid is dropped alone.
 */
export function normalizeAI(raw: unknown): AIConfig | undefined {
  if (!isObj(raw)) return undefined
  const provider = raw.provider as Provider
  if (!PROVIDERS.includes(provider)) return undefined
  if (typeof raw.model !== "string" || !raw.model.trim()) return undefined
  const base = baseURL(raw.baseURL)
  if (provider === "custom" && !base) return undefined
  const out: AIConfig = { provider, model: raw.model }
  if (base) out.baseURL = base
  if (typeof raw.keyEnv === "string" && ENV_NAME.test(raw.keyEnv)) out.keyEnv = raw.keyEnv
  if (typeof raw.maxChars === "number" && Number.isInteger(raw.maxChars) && raw.maxChars >= 1000) out.maxChars = raw.maxChars
  if (isObj(raw.headers)) {
    const h: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.headers))
      if (HEADER_NAME.test(k) && k.toLowerCase() !== "authorization" && typeof v === "string" && !/[\r\n\0]/.test(v)) h[k] = v
    if (Object.keys(h).length) out.headers = h
  }
  const gloss = parseGlossStyle(raw.gloss)
  if (gloss) out.gloss = gloss
  return out
}

/** Where a request goes and what it carries; `key` is kept only to redact it from messages. */
export interface AITarget {
  url: string
  /** `URL.host`: never userinfo */
  host: string
  headers: Record<string, string>
  model: string
  maxChars: number
  keyEnv?: string
  key?: string
}

const loopback = (h: string) => h === "localhost" || h === "[::1]" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)

/** The request target, or the toast for why there is none (missing key, key or custom headers over plain http). */
export function resolveAI(cfg: AIConfig, env: Record<string, string | undefined> = process.env): AITarget | { error: string } {
  const preset = cfg.provider === "custom" ? undefined : PRESETS[cfg.provider]
  const base = cfg.baseURL ?? preset!.baseURL
  const u = new URL(base)
  const keyEnv = cfg.keyEnv ?? preset?.keyEnv
  const key = keyEnv ? env[keyEnv]?.trim() || undefined : undefined
  if (keyEnv && !key) return { error: `AI: set ${keyEnv}` }
  if (key && u.protocol === "http:" && !loopback(u.hostname)) return { error: `AI: won't send the key over http to ${u.host}` }
  if (cfg.headers && u.protocol === "http:" && !loopback(u.hostname)) return { error: `AI: won't send headers over http to ${u.host}` }
  const headers: Record<string, string> = { "Content-Type": "application/json", ...cfg.headers }
  if (key) headers.Authorization = `Bearer ${key}`
  // the path goes before a query (`?api-version=…`); a fragment is never sent
  u.pathname = u.pathname.replace(/\/+$/, "") + "/chat/completions"
  u.hash = ""
  return {
    url: u.href,
    host: u.host,
    headers,
    model: cfg.model,
    maxChars: cfg.maxChars ?? preset?.maxChars ?? CUSTOM_MAX,
    keyEnv,
    key,
  }
}

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

function cleanStep(s: string): string {
  s = s.trimStart()
  if (s && "<think>".startsWith(s)) return "" // the tag is still arriving
  if (s.startsWith("<think>")) {
    const end = s.indexOf("</think>")
    if (end < 0) return "" // still thinking: show nothing yet
    s = s.slice(end + "</think>".length)
  }
  s = s
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, (m, x: string) => (/^\w+$/.test(x) ? m : x)) // `__init__` is a name, not emphasis
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]*#+[ \t]*/gm, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/^\s*(?:TL;?DR|Summary)\s*:\s*/i, "")
  return s.replace(/\s+/g, " ").trim()
}

/** Model output as plain text; applied to the accumulated stream on every render, so it is idempotent. */
export function cleanSummary(raw: string): string {
  let s = raw
  for (let i = 0; i < 8; i++) {
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
  let s = raw.trim()
  if (s.startsWith("<think>")) {
    const end = s.indexOf("</think>")
    if (end < 0) return undefined
    s = s.slice(end + "</think>".length)
  }
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

export type AIEvent = { kind: "text"; text: string } | { kind: "error"; message: string } | { kind: "finish"; reason: string } | { kind: "done" }

/** `error.message`, `error` as a string, or `message`; Gemini wraps errors in an array. */
export function errMessage(body: unknown): string | undefined {
  const b = Array.isArray(body) ? body[0] : body
  if (!isObj(b)) return undefined
  const e = b.error
  if (isObj(e) && typeof e.message === "string" && e.message) return e.message
  if (typeof e === "string" && e) return e
  if (typeof b.message === "string" && b.message) return b.message
  return undefined
}

const firstChoice = (o: Raw): Raw | undefined => (Array.isArray(o.choices) && isObj(o.choices[0]) ? o.choices[0] : undefined)

function chunkEvents(obj: unknown): AIEvent[] {
  if (!isObj(obj)) return []
  if (obj.error !== undefined) return [{ kind: "error", message: errMessage(obj) ?? "stream error" }]
  const ch = firstChoice(obj)
  if (!ch) return []
  const out: AIEvent[] = []
  const content = isObj(ch.delta) ? ch.delta.content : undefined
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
    const data = l.slice(5).trimStart()
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
    push: (chunk: Uint8Array | string) => feed(typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true }), false),
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
  const ch = isObj(body) ? firstChoice(body) : undefined
  const content = ch && isObj(ch.message) ? ch.message.content : undefined
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

/** The error toast for a failure (spec: Errors table). */
export function aiError(f: Failure, ctx: ErrCtx): string {
  const tell = (m: string) => truncate(safeLine(ctx.key ? m.replaceAll(ctx.key, "…") : m).trim(), MSG_W)
  const noun = ctx.noun ?? "summary"
  const what = (): string => {
    switch (f.kind) {
      case "status":
        if (f.status === 401 || f.status === 403) return ctx.key ? `key rejected (${ctx.keyEnv})` : "unauthorized · set keyEnv"
        if (f.status === 404) return "model or endpoint not found"
        if (f.status === 429) return "rate limited"
        return f.message?.trim() ? tell(f.message) : `${f.status} from ${ctx.host}`
      case "message":
        return tell(f.message)
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
        return "no answer for 60 s"
      case "total":
        return `no ${noun} after 180 s`
      case "empty":
        return `empty ${noun}`
      case "invalid":
        return `no usable ${noun}`
    }
  }
  return (ctx.note ? `AI · ${ctx.note}: ` : "AI: ") + what()
}

export const IDLE_MS = 60_000
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
/** The TL;DR's name for `ChatOpts`. */
export type SummarizeOpts = ChatOpts

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
export type ChatResult = { ok: true; text: string; raw: string } | { ok: false; failure: Failure } | { ok: false; cancelled: true }
export type SummaryResult = { ok: true; text: string } | { ok: false; failure: Failure } | { ok: false; cancelled: true }

const fail = (failure: Failure): ChatResult => ({ ok: false, failure })
const finish = (raw: string, req: ChatReq): ChatResult => {
  const text = req.clean(raw)
  return !text ? fail({ kind: "empty" }) : text.length > req.maxOut ? fail({ kind: "tooLong" }) : { ok: true, text, raw }
}

/**
 * The only network I/O. Never throws: every outcome is a result. The idle timer is re-armed by
 * any bytes (reasoning deltas and `:` comments count); aborting `o.signal` resolves `cancelled`.
 */
export async function chat(t: AITarget, req: ChatReq, o: ChatOpts = {}): Promise<ChatResult> {
  const r = await send(t, req, o)
  if (r.ok || !("failure" in r)) return r
  const f = r.failure
  const text = f.kind === "message" ? f.message : f.kind === "status" ? f.message : undefined
  if (!text) return r
  // a server may echo a secret back: the key and every custom header value never reach a message
  let out = text
  for (const v of [t.key, ...Object.values(t.headers)]) if (v && v.length >= 4 && v !== "application/json") out = out.replaceAll(v, "…")
  return out === text ? r : { ok: false, failure: { ...f, message: out } as Failure }
}

async function send(t: AITarget, req: ChatReq, o: ChatOpts): Promise<ChatResult> {
  if (o.signal?.aborted) return { ok: false, cancelled: true }
  const ctl = new AbortController()
  let why: "idle" | "total" | null = null
  const stop = (w: "idle" | "total") => {
    why ??= w
    ctl.abort()
  }
  let idle: ReturnType<typeof setTimeout> | undefined
  const poke = () => {
    clearTimeout(idle)
    idle = setTimeout(() => stop("idle"), o.idleMs ?? IDLE_MS)
  }
  const total = setTimeout(() => stop("total"), o.totalMs ?? TOTAL_MS)
  const onAbort = () => ctl.abort()
  o.signal?.addEventListener("abort", onAbort)
  /** why the request stopped early, if it was stopped */
  const ended = (): ChatResult | null => (why ? fail({ kind: why }) : ctl.signal.aborted ? { ok: false, cancelled: true } : null)
  // a whole-body read that ignores the fetch signal (stubs, some proxies) still settles on abort
  const aborted = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error("aborted"))))
  aborted.catch(() => {})
  const whole = <T>(p: Promise<T>) => Promise.race([p, aborted])
  try {
    poke()
    const { url, init } = buildRequest(t, req.system, req.user)
    let res: Response
    try {
      res = await (o.fetch ?? fetch)(url, { ...init, signal: ctl.signal })
    } catch {
      return ended() ?? fail({ kind: "network" })
    }
    const stopped = ended() // aborted while the headers arrived: a reader made now would never see the abort
    if (stopped) return stopped
    poke()
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return fail({ kind: "redirect" })
    if (!res.ok) {
      const body = await whole(res.text()).catch(() => "")
      let message: string | undefined
      try {
        message = errMessage(JSON.parse(body))
      } catch {
        // not JSON (an HTML error page): status only
      }
      return ended() ?? fail({ kind: "status", status: res.status, message })
    }
    const type = res.headers.get("content-type") ?? ""
    if (type.includes("application/json")) {
      let body: unknown
      try {
        body = await whole(res.json())
      } catch {
        return ended() ?? fail({ kind: "unexpected" })
      }
      const r = jsonReply(body)
      return "failure" in r ? fail(r.failure) : finish(r.text, req)
    }
    if (!type.includes("text/event-stream") || !res.body) return fail({ kind: "unexpected" })
    const reader = res.body.getReader()
    // a body that ignores the fetch signal still ends: a cancelled read resolves done
    ctl.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}))
    const p = sseParser()
    let raw = ""
    const take = (evs: AIEvent[]): Failure | "done" | null => {
      for (const ev of evs) {
        if (ev.kind === "error") return { kind: "message", message: ev.message }
        if (ev.kind === "done") return "done"
        if (ev.kind === "finish") {
          if (ev.reason === "length") return { kind: "length" }
          if (ev.reason === "error") return { kind: "message", message: "stream failed" }
          continue
        }
        raw += ev.text
        if (raw.length > MAX_RAW || req.clean(raw).length > req.maxOut) return { kind: "tooLong" }
        o.onDelta?.(raw)
      }
      return null
    }
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch {
        return ended() ?? fail({ kind: "network" })
      }
      const early = ended()
      if (early) return early
      const r = chunk.done ? take(p.end()) : (poke(), take(p.push(chunk.value)))
      if (r && r !== "done") return fail(r)
      if (r === "done" || chunk.done) break
    }
    return finish(raw, req)
  } finally {
    clearTimeout(idle)
    clearTimeout(total)
    o.signal?.removeEventListener("abort", onAbort)
    ctl.abort() // closes the connection on every early return (stops billing where supported)
  }
}

/** The TL;DR: the note clipped to the target's limit, cleaned to plain text. Same result shape as before `chat`. */
export async function summarize(t: AITarget, text: string, o: ChatOpts = {}): Promise<SummaryResult> {
  const r = await chat(t, { system: SYSTEM_PROMPT, user: clip(text, t.maxChars), maxOut: MAX_SUMMARY, clean: cleanSummary }, o)
  return r.ok ? { ok: true, text: r.text } : r
}
