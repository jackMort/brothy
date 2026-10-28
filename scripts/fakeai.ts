// An offline stand-in for the AI endpoint, for the recording scripts (scripts/cast.ts, scripts/demo.ts): no network, no keys.
//   `fakeFetch` answers brothy's chat requests with OpenAI-compatible SSE at about 30–60 ms per token after a short first-token
//   delay; `fakeReply` picks the text from the request (the system prompt says which feature asks, the user message which note).
//   The replies are written by hand against examples/: a request for a note, section or change that is not listed here gets a
//   400, so a changed example shows up as a failed recording rather than a made-up answer.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ASK_PROMPT, RERANK_PROMPT } from "../src/ask"
import { DELTA_PROMPT } from "../src/delta"
import { SYSTEM_PROMPT } from "../src/ai"
import { glossSystem } from "../src/gloss"

/** The `ai` block the tour runs with: a local model, so no key is involved. */
export const FAKE_AI = { provider: "ollama", model: "llama3.2" } as const

/** Write config.json (the `ai` block, and `theme` when given) into the fake $HOME's brothy config dir. */
export function writeAIConfig(home: string, extra: Record<string, unknown> = {}) {
  const dir = join(home, ".config/brothy")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ai: FAKE_AI, ...extra }, null, 2))
}

/** The note the tour edits on disk (path relative to $HOME) and the edit: chicken simmers longer, a Storing section is added. */
export const STOCK = "examples/notes/stock.md"
export const stockEdit = (s: string) =>
  s
    .replace("**3 to 4 hours**", "**4 to 6 hours**")
    .replace("| chicken | 3–4 h | hourly |", "| chicken | 4–6 h | hourly |")
    .trimEnd() + "\n\n## Storing\n\nCool the pot in an ice bath, then keep the broth for four days in the fridge or three months in the freezer.\n"

export type Kind = "tldr" | "gloss" | "delta" | "ask" | "rerank"

/** Which feature sent the request, by its system prompt; null for anything else. */
export function kindOf(system: string): Kind | null {
  if (system === SYSTEM_PROMPT) return "tldr"
  if (system === DELTA_PROMPT) return "delta"
  if (system === ASK_PROMPT) return "ask"
  if (system === RERANK_PROMPT) return "rerank"
  if (system === glossSystem("explain")) return "gloss"
  return null
}

// ---------- replies ----------
const TLDR: Record<string, string> = {
  "Welcome to brothy":
    "brothy is a terminal Markdown reader with a panel-based interface: a folder tree beside a rendered note, with preview, source, outline and info views, find, and live reload when the file changes on disk. The note also covers a quick start and a short task list.",
  "Getting started":
    "How to install brothy with Bun, open a folder or a single file, and where the theme choice is remembered. It lists the thirteen theme families, each with a dark and a light variant.",
  "Keybindings":
    "A short reference for moving around: j and k scroll, d and u go half a page, g and G jump to the ends, and [ and ] move between headings. In the file tree the arrow keys or j and k move, and enter focuses the document.",
  "Simmering notes":
    "A small tour of what brothy renders the way Obsidian users expect: wikilinks, callouts, highlights, a TypeScript snippet and a table of heat levels with the time each is good for.",
  Changelog: "The changelog so far has a single entry: version 0.1.0, the first release, with the tree, preview, source, outline and info tabs.",
  "Weekly sync — October 12":
    "Two decisions came out of the sync: ship the outline tab this week and keep the themes in step with brothy's palette. The follow-ups are release notes, still open, and the table wrapping fix on narrow terminals, which is done.",
  "Slow broth":
    "A good broth takes patience: bones and cold water held at a heat where the surface barely moves. Chicken simmers for 3 to 4 hours, beef for 8 to 12 and fish for 45 minutes, skimming the foam early and salting only at the end.",
}

/** Zen gloss, by `Note title|Section` (the last heading of the trail). */
const GLOSS: Record<string, string> = {
  "Slow broth|What you need":
    "The shopping list: chicken bones, onions, a carrot and celery, and cold water. The first two are ticked, so only the water is left to add.",
  "Slow broth|Skim as you go":
    "Remove the grey foam that rises in the first hour with a flat spoon, and keep the fat aside: it holds flavor and sets on top once the broth is cold.",
  "Slow broth|Salt late":
    "Hold the salt until the end, because simmering reduces the liquid and concentrates it. A broth that tasted right at hour two will be too salty by hour four.",
  "Simmering notes|A tiny stock":
    "A short TypeScript example: given a list of notes, it keeps those whose links include a title, which is how a backlink list is built.",
  "Simmering notes|Heat levels":
    "Three heat settings and what each suits: low for reading at 8 minutes, medium for editing at 20, and high for a quick 2-minute search.",
}

/** What the model says about each changed section of the tour's reload, by heading: a summary line and the quoted + line. */
const DELTA: Record<string, { what: string; quote?: string }> = {
  "How long to simmer": { what: "simmer time: 4–6 h", quote: "4 to 6 hours" },
  Storing: { what: "storage times added", quote: "four days in the fridge" },
}
const DELTA_SUMMARY = "Simmer time went up for chicken, and a Storing section was added."

/** Tier 0: the search terms for a question. */
const QUERIES: Record<string, string[]> = {
  "how long should broth simmer": ["simmer", "how long", "hours", "broth", "time"],
}

/** Tier 1: the ids (c1…) whose excerpt holds these words are kept, in this order, with a reason. */
const RERANK: { word: string; why: string }[] = [
  { word: "3 to 4 hours", why: "chicken, beef and fish times" },
  { word: "hour two", why: "salt timing changes with time" },
  { word: "first hour", why: "when to skim while it simmers" },
]

const lines = (s: string) => s.split("\n")

/** `## Heading` lines → ids: the reload message numbers its sections §1… in order, `§n <status> · <path>`. */
function deltaSections(user: string): { id: number; heading: string; plus: string }[] {
  const out: { id: number; heading: string; plus: string }[] = []
  let cur: (typeof out)[number] | null = null
  for (const l of lines(user)) {
    const m = /^§(\d+) \S+ · (.*)$/.exec(l)
    if (m) {
      cur = { id: Number(m[1]), heading: m[2]!.split(" › ").at(-1)!, plus: "" }
      out.push(cur)
    } else if (cur && l.startsWith("+ ")) cur.plus += " " + l.slice(2)
  }
  return out
}

/** The whole reply for a request, or null when nothing is written for it. */
export function fakeReply(system: string, user: string): string | null {
  switch (kindOf(system)) {
    case "tldr": {
      const title = /^# (.+)$/m.exec(user)?.[1]?.trim()
      return (title && TLDR[title]) || null
    }
    case "gloss": {
      const note = /^Note: (.*)$/m.exec(user)?.[1]
      const section = /^Section: (.*)$/m.exec(user)?.[1]?.split(" › ").at(-1)
      return (note && section && GLOSS[`${note}|${section}`]) || null
    }
    case "delta": {
      const secs = deltaSections(user)
      const notes = secs.map((s) => ({ s, d: DELTA[s.heading] }))
      if (!secs.length || notes.some((n) => !n.d)) return null
      const body = notes.map(({ s, d }) => {
        const q = d!.quote && s.plus.replace(/\s+/g, " ").includes(d!.quote) ? ` | "${d!.quote}"` : ""
        return `§${s.id}: ${d!.what}${q}`
      })
      return [DELTA_SUMMARY, ...body].join("\n")
    }
    case "ask": {
      const q = QUERIES[user.trim().toLowerCase()]
      return q ? JSON.stringify({ queries: q }) : null
    }
    case "rerank": {
      const q = /^Question: (.*)$/m.exec(user)?.[1]?.trim().toLowerCase()
      if (!q || !QUERIES[q]) return null
      const cands = user.split(/\n\n(?=c\d+ · )/).slice(1)
      const answers = RERANK.flatMap((r) => {
        const at = cands.findIndex((c) => c.includes(r.word))
        return at < 0 ? [] : [{ id: `c${at + 1}`, why: r.why }]
      })
      return answers.length ? JSON.stringify({ answers }) : null
    }
    default:
      return null
  }
}

// ---------- streaming ----------
/** The reply cut into token-sized pieces: a word with its space, long words in halves of at most 6 characters. */
export function tokensOf(text: string): string[] {
  return (text.match(/\s*\S+\s?/g) ?? [text]).flatMap((w) => (w.length > 7 ? w.match(/[\s\S]{1,6}/g)! : [w]))
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms)
    signal?.addEventListener("abort", () => { clearTimeout(t); res() }, { once: true })
  })

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const chunk = (content: string) => sse({ choices: [{ index: 0, delta: { content } }] })

export interface FakeOpts {
  /** ms before the first token */
  first?: number
  /** ms per token: base + jitter × (0..1) */
  pace?: [number, number]
}

/** A `fetch` for App's `fetch` prop (and `chat`'s `fetch`): same jitter every run. */
export function fakeFetch({ first = 450, pace = [30, 60] }: FakeOpts = {}): typeof fetch {
  let rnd = 11
  const jitter = () => { rnd = (rnd + 0x6d2b79f5) | 0; let x = Math.imul(rnd ^ (rnd >>> 15), 1 | rnd); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296 }
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = body.messages.find((m) => m.role === "system")?.content ?? ""
    const user = body.messages.find((m) => m.role === "user")?.content ?? ""
    const reply = fakeReply(system, user)
    if (process.env.FAKEAI_LOG) console.error(`[fakeai] ${kindOf(system)} ${reply === null ? "NO REPLY" : "ok"}\n${user}`)
    if (reply === null)
      return new Response(JSON.stringify({ error: { message: `fakeai: no reply written for this ${kindOf(system) ?? "unknown"} request` } }), { status: 400, headers: { "content-type": "application/json" } })
    const signal = init?.signal ?? undefined
    const enc = new TextEncoder()
    const parts = tokensOf(reply)
    let i = 0
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(ctl) {
          if (signal?.aborted) return ctl.close()
          await sleep(i === 0 ? first : pace[0] + (pace[1] - pace[0]) * jitter(), signal)
          if (signal?.aborted) return ctl.close()
          if (i < parts.length) ctl.enqueue(enc.encode(chunk(parts[i++]!)))
          else {
            ctl.enqueue(enc.encode(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n"))
            ctl.close()
          }
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  }) as typeof fetch
}
