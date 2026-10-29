// The `ai` block of config.json: providers and their presets, validation (`normalizeAI`), the request
// target (`resolveAI`) and the prompt versions (`PROMPTS`). Pure, and it imports nothing of the renderer, so config.ts can load it cheaply;
// ai.ts re-exports everything here.

import { isRecord } from "./json"

/** Prompt versions per feature: bump one whenever its prompt changes, and its cached results show as outdated. */
export const PROMPTS = { tldr: 1, gloss: 1, delta: 2, ask: 1, rerank: 1 } as const
/** The TL;DR's version (`SYSTEM_PROMPT`); what `summaries.json` entries carry as `v`. */
export const PROMPT_V = PROMPTS.tldr

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

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** `ai.gloss`: how zen explains a section. Lives here, not in gloss.ts, so config.ts never imports gloss.ts (gloss.ts imports `clip` from ai.ts). */
export type GlossStyle = "explain" | "simplify" | `translate:${string}`
/** a BCP 47-ish language tag: `pl`, `pt-BR`, `zh-Hant-TW` */
const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/** A valid style, else `fallback`; with no fallback, undefined (`normalizeAI` drops the field then). */
export function parseGlossStyle(v: unknown): GlossStyle | undefined
export function parseGlossStyle(v: unknown, fallback: GlossStyle): GlossStyle
export function parseGlossStyle(v: unknown, fallback?: GlossStyle): GlossStyle | undefined {
  if (v === "explain" || v === "simplify") return v
  if (typeof v === "string" && v.startsWith("translate:") && LANG_TAG.test(v.slice("translate:".length))) return v as GlossStyle
  return fallback
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
  if (!isRecord(raw)) return undefined
  const provider = raw.provider as Provider
  if (!PROVIDERS.includes(provider)) return undefined
  if (typeof raw.model !== "string" || !raw.model.trim()) return undefined
  const base = baseURL(raw.baseURL)
  if (provider === "custom" && !base) return undefined
  const out: AIConfig = { provider, model: raw.model }
  if (base) out.baseURL = base
  if (typeof raw.keyEnv === "string" && ENV_NAME.test(raw.keyEnv)) out.keyEnv = raw.keyEnv
  if (typeof raw.maxChars === "number" && Number.isInteger(raw.maxChars) && raw.maxChars >= 1000) out.maxChars = raw.maxChars
  if (isRecord(raw.headers)) {
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
