import { A, type Span } from "../lib/spans"
import type { Theme } from "../theme/theme"

/**
 * Code highlighting for fenced blocks.
 *
 * Languages with a bundled OpenTUI tree-sitter parser (JS/TS/JSX/TSX/Zig) are
 * highlighted asynchronously by the parser worker; everything else gets a
 * deliberately small per-line fallback. `render()` is synchronous, so it only
 * ever reads the cache (`codeSpans`) and reports what is missing; the caller
 * awaits `ensureHighlights` and re-renders.
 *
 * The cache stores *semantic* tokens, not colors, so switching themes never
 * needs a re-parse.
 */

export type Kind =
  | "keyword"
  | "string"
  | "escape"
  | "comment"
  | "number"
  | "constant"
  | "function"
  | "type"
  | "property"
  | "operator"
  | "punctuation"
  | "tag"
  | "attribute"
  | "variable"

export interface Tok {
  text: string
  /** Undefined means plain text. */
  kind?: Kind
}

export interface HighlightRequest {
  /** Canonical language (see `canonicalLang`). */
  lang: string
  /** Exactly the text that will be rendered (tabs already expanded). */
  code: string
}

// ------------------------------------------------------------ colors

/** The one place that decides which theme color each token kind gets. */
export function kindStyle(kind: Kind | undefined, t: Theme): Omit<Span, "text"> {
  switch (kind) {
    case "keyword":
      return { fg: t.secondary }
    case "string":
      return { fg: t.success }
    case "escape":
      return { fg: t.accent }
    case "comment":
      return { fg: t.textMuted, attr: A.ITALIC }
    case "number":
    case "constant":
      return { fg: t.warning }
    case "function":
      return { fg: t.primary }
    case "type":
      return { fg: t.info }
    case "tag":
      return { fg: t.secondary }
    case "attribute":
      return { fg: t.accent }
    case "punctuation":
    case "operator":
      return { fg: t.textMuted }
    default:
      return { fg: t.text }
  }
}

const colorize = (toks: Tok[], t: Theme): Span[] => toks.map((k) => ({ text: k.text, ...kindStyle(k.kind, t) }))

// ------------------------------------------------------------ languages

/** Info-string aliases -> filetypes that OpenTUI ships a parser for. */
const PARSER_LANGS: Record<string, string> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  javascriptreact: "javascriptreact",
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  typescriptreact: "typescriptreact",
  zig: "zig",
}

/** Canonical filetypes with a bundled parser; kept in sync with OpenTUI by a test. */
export const PARSER_FILETYPES: readonly string[] = [...new Set(Object.values(PARSER_LANGS))]

/** Lowercased first word of a fence info string, mapped to a parser filetype when one exists. */
export function canonicalLang(info: string): string {
  const word = (info.trim().split(/[\s{]/)[0] ?? "").toLowerCase()
  return Object.hasOwn(PARSER_LANGS, word) ? PARSER_LANGS[word]! : word
}

const hasParser = (lang: string) => PARSER_FILETYPES.includes(lang)

// ------------------------------------------------------------ capture names

/** Longest matching prefix wins. Groups that map to nothing (spell, conceal, ...) are ignored. */
const GROUP_KIND = new Map<string, Kind>(
  Object.entries<Kind>({
    comment: "comment",
    string: "string",
    "string.escape": "escape",
    "string.special": "escape",
    character: "string",
    number: "number",
    float: "number",
    boolean: "constant",
    constant: "constant",
    keyword: "keyword",
    conditional: "keyword",
    repeat: "keyword",
    include: "keyword",
    exception: "keyword",
    storageclass: "keyword",
    "variable.builtin": "keyword",
    function: "function",
    method: "function",
    type: "type",
    class: "type",
    module: "type",
    namespace: "type",
    property: "property",
    field: "property",
    "variable.member": "property",
    variable: "variable",
    operator: "operator",
    punctuation: "punctuation",
    tag: "tag",
    attribute: "attribute",
  }),
)
GROUP_KIND.set("constructor", "type") // not a literal key: it collides with Object.prototype typing

export function groupKind(group: string): Kind | undefined {
  for (let g = group; ; ) {
    const k = GROUP_KIND.get(g)
    if (k) return k
    const dot = g.lastIndexOf(".")
    if (dot < 0) return undefined
    g = g.slice(0, dot)
  }
}

type Range = [number, number, string, unknown?]

/**
 * The kind of every character of `code`. Overlaps resolve by
 * specificity (more dotted segments wins), then by later position in the
 * query, as OpenTUI itself does. The shipped queries' `#match?` predicates
 * are not applied by the worker, so every identifier arrives as variable +
 * type + constant; those two are re-checked against the text here.
 */
function paintKinds(code: string, ranges: Range[]): (Kind | undefined)[] {
  const kinds: (Kind | undefined)[] = new Array(code.length)
  const spec: number[] = new Array(code.length).fill(0)
  for (const [start, end, group] of ranges) {
    const kind = groupKind(group)
    if (!kind || end <= start) continue
    if (group === "constant" && !/^[A-Z_][A-Z0-9_]*$/.test(code.slice(start, end))) continue
    if (group === "type" && !/^[A-Z]/.test(code.slice(start, end))) continue
    const s = group.split(".").length
    for (let i = Math.max(0, start); i < Math.min(end, code.length); i++) {
      if (s >= spec[i]!) {
        spec[i] = s
        kinds[i] = kind === "variable" ? undefined : kind
      }
    }
  }
  return kinds
}

/** Turn tree-sitter ranges into per-line tokens (`paintKinds`, then runs of one kind per line). */
export function tokenize(code: string, ranges: Range[]): Tok[][] {
  const kinds = paintKinds(code, ranges)
  const lines: Tok[][] = [[]]
  let line = lines[0]!
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    if (ch === "\n") {
      line = []
      lines.push(line)
      continue
    }
    const last = line[line.length - 1]
    if (last && last.kind === kinds[i]) last.text += ch
    else line.push({ text: ch, kind: kinds[i] })
  }
  return lines
}

// ------------------------------------------------------------ fallback

type Family = "slash" | "hash" | "dash" | "data"

const FAMILIES: Record<Family, string> = {
  slash:
    "c cpp c++ cc cxx h hpp cs csharp java kotlin kt swift go golang rust rs scala dart php objc objective-c groovy scss sass less jsonc json5 glsl hlsl proto protobuf",
  hash: "py python sh bash zsh shell console fish ruby rb yaml yml toml r perl pl make makefile mk dockerfile docker conf nginx elixir ex exs powershell ps1 gitignore",
  dash: "sql lua haskell hs elm",
  data: "json",
}
const FAMILY_OF = new Map<string, Family>(
  (Object.entries(FAMILIES) as [Family, string][]).flatMap(([f, names]) =>
    names.split(" ").map((n) => [n, f] as const),
  ),
)
/** each family's line comment, as a regex source (JSON has none) */
const COMMENT: Record<Family, string | null> = {
  slash: "\\/\\/.*$",
  hash: "(?<![^\\s])#.*$",
  dash: "--.*$",
  data: null,
}
const QUOTED = { double: `"(?:\\\\.|[^"\\\\])*"`, single: `'(?:\\\\.|[^'\\\\])*'`, back: "`(?:\\\\.|[^`\\\\])*`" }
/** each family's string literals: JSON only double-quotes, the slash family also has template literals */
const STRING: Record<Family, string> = {
  slash: `${QUOTED.double}|${QUOTED.single}|${QUOTED.back}`,
  hash: `${QUOTED.double}|${QUOTED.single}`,
  dash: `${QUOTED.double}|${QUOTED.single}`,
  data: QUOTED.double,
}

/**
 * Fallback for languages without a parser: comments (only the syntax the
 * language actually uses), strings, numbers and a few literals. Unknown or
 * absent languages are left plain: guessing comment or string syntax for them
 * mangles prose, logs and shell output.
 */
export function fallbackTokens(line: string, lang: string): Tok[] {
  const family = FAMILY_OF.get(lang)
  if (!family) return line ? [{ text: line }] : []
  const comment = COMMENT[family]
  const re = new RegExp(
    `${comment ? `(${comment})` : "((?!))"}|(${STRING[family]})|(\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)|(\\b(?:true|false|null|nil|None|True|False|undefined)\\b)|([\\s\\S])`,
    "gm",
  )
  const out: Tok[] = []
  const add = (text: string, kind?: Kind) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ text, kind })
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m[1]) {
      add(m[1], "comment")
      break
    }
    if (m[2]) add(m[2], "string")
    else if (m[3]) add(m[3], "number")
    else if (m[4]) add(m[4], "constant")
    else add(m[5]!)
  }
  return out
}

// ------------------------------------------------------------ cache

const MAX_ENTRIES = 300
const MAX_CODE = 60_000
/** null = parser has nothing for this block; use the fallback. */
const cache = new Map<string, Tok[][] | null>()
const keyOf = (lang: string, code: string) => `${lang}\0${code}`

function remember(key: string, value: Tok[][] | null) {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!)
}

/** undefined = not looked up yet; null = known to need the fallback. */
export function cachedHighlight(lang: string, code: string): Tok[][] | null | undefined {
  return cache.get(keyOf(lang, code))
}

export function clearHighlightCache() {
  cache.clear()
}

/**
 * Colored spans for each line of `code`, always exactly `code.split("\n").length`
 * lines. `pending` is set when a parser exists but its result is not cached yet.
 */
export function codeSpans(info: string, code: string, t: Theme): { lines: Span[][]; pending?: HighlightRequest } {
  const lang = canonicalLang(info)
  const src = code.split("\n")
  const hit = cachedHighlight(lang, code)
  if (hit && hit.length === src.length) return { lines: hit.map((l) => colorize(l, t)) }
  const lines = src.map((l) => colorize(fallbackTokens(l, lang), t))
  const needs = hit === undefined && hasParser(lang) && code.length <= MAX_CODE
  return needs ? { lines, pending: { lang, code } } : { lines }
}

// ------------------------------------------------------------ async side

type Client = {
  initialize(): Promise<void>
  highlightOnce(content: string, filetype: string): Promise<{ highlights?: Range[]; warning?: string; error?: string }>
}
let clientP: Promise<Client | null> | null = null
let shutdown: (() => Promise<void>) | null = null
const TIMEOUT_MS = 8000

function getClient(): Promise<Client | null> {
  clientP ??= (async () => {
    try {
      const core = await import("@opentui/core")
      const client = core.getTreeSitterClient() as unknown as Client
      await client.initialize()
      shutdown = core.destroyTreeSitterClient
      return client
    } catch {
      return null
    }
  })()
  return clientP
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(null)),
    )
  })

const inflight = new Map<string, Promise<boolean>>()

async function load(req: HighlightRequest): Promise<boolean> {
  const key = keyOf(req.lang, req.code)
  const client = await getClient()
  let dropped = false
  const ask = client?.highlightOnce(req.code, req.lang).catch(() => ((dropped = true), null))
  const res = ask ? await withTimeout(ask, TIMEOUT_MS) : null
  // a rejected request means the worker went away under it (shutdownHighlighter, or OpenTUI's
  // renderer.destroy(), which destroys the shared client): that says nothing about the block, so
  // it stays uncached and the next ensureHighlights asks again
  if (dropped) return false
  if (!res?.highlights) {
    remember(key, null)
    return false
  }
  remember(key, tokenize(req.code, res.highlights))
  return true
}

/**
 * Parse the requested blocks (deduplicated, cached). Resolves true when at
 * least one block now has real highlighting, i.e. when re-rendering will look
 * different. Never rejects.
 */
export async function ensureHighlights(reqs: HighlightRequest[]): Promise<boolean> {
  const jobs: Promise<boolean>[] = []
  for (const r of reqs) {
    const key = keyOf(r.lang, r.code)
    if (cache.has(key) || !hasParser(r.lang)) continue
    let job = inflight.get(key)
    if (!job) {
      job = load(r).finally(() => inflight.delete(key))
      inflight.set(key, job)
    }
    jobs.push(job)
  }
  return (await Promise.all(jobs)).some(Boolean)
}

/** Stop the parser worker; it keeps the process alive otherwise. Safe to call anytime. */
export async function shutdownHighlighter() {
  const p = clientP
  clientP = null
  if (!p) return
  await p
  const stop = shutdown
  shutdown = null
  await stop?.().catch(() => {})
}
