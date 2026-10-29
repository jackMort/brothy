// Shared harness for the tests/app-*.test.tsx files: temp XDG dirs, mounting <App> headless, key and frame helpers, fixtures.
// Nothing here runs at import: a test file calls `useAppHarness()` at its top level, which registers the hooks and
// returns the helpers bound to that file's temp dirs (bun runs every test file in one process, so import-time env would leak).
import { afterAll, afterEach, beforeAll, setSystemTime } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { App, type AppProps } from "../../src/App"
import { noteText } from "../../src/ai"
import { glossKey, glossTarget } from "../../src/gloss"
import { shutdownHighlighter } from "../../src/highlight"
import { themeByName } from "../../src/theme"
import { textHash } from "../../src/summaries"
import { quietAct } from "../quiet-act"
import { setEnv } from "./env"
import { makeTmp } from "./tmp"

export type Setup = Awaited<ReturnType<typeof testRender>>
export interface Size {
  width: number
  height: number
}
/** What a test may change about the mounted app; everything else is the default `<App>`. */
export interface MountOpts {
  /** terminal size (default 100x30) */
  size?: Size
  fetch?: AppProps["fetch"]
  /** `themeName` */
  theme?: string
  motion?: boolean
  stdin?: string
  linkScanDelay?: number
  edit?: AppProps["edit"]
}

// ------------------------------------------------------------- waiting and keys

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Render until `pred` holds. App timers (OPEN_DELAY, fades, the teleprompter) run late under load: wait, don't sleep. */
export async function waitFor(s: Setup, pred: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    await s.renderOnce()
    if (pred()) return
  }
  throw new Error("never matched:\n" + s.captureCharFrame())
}
/** Resolves with the frame that matched. */
export const waitFrame = (s: Setup, pred: (f: string) => boolean, ms = 2000) => waitFor(s, () => pred(s.captureCharFrame()), ms).then(() => s.captureCharFrame())

/**
 * OpenTUI's stdin parser holds a lone ESC for 20 ms (it may start a sequence) before it becomes a
 * key. Waiting past that first lets the next sleep give React its commit; a sleep that merely
 * ties with the flush timer can capture the frame before esc lands.
 */
const ESC_HOLD = 30

/** Press `ks` in order (names as in the snapshot script: `tab`, `enter`, `esc`, `type:<text>`, `C-<key>`, or one key); resolves with the frame. */
export async function keys(s: Setup, ...ks: string[]) {
  for (const k of ks) {
    if (k === "tab") s.mockInput.pressTab()
    else if (k === "enter") s.mockInput.pressEnter()
    else if (k === "esc") {
      s.mockInput.pressEscape()
      await sleep(ESC_HOLD)
    }
    else if (k === "down" || k === "up" || k === "left" || k === "right") s.mockInput.pressArrow(k)
    else if (k === "space") s.mockInput.pressKey(" ")
    else if (k === "backspace") s.mockInput.pressBackspace()
    else if (k.startsWith("type:")) await s.mockInput.typeText(k.slice(5))
    else if (k.startsWith("C-")) s.mockInput.pressKey(k.slice(2), { ctrl: true })
    else s.mockInput.pressKey(k)
    await sleep(5)
    await s.renderOnce()
  }
  await sleep(20)
  await s.renderOnce()
  return s.captureCharFrame()
}

/** Run `fn` with `vars` set in `process.env` (`undefined` deletes), then put the previous values back. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  const apply = (v: Record<string, string | undefined>) => Object.entries(v).forEach(([k, x]) => setEnv(k, x))
  apply(vars)
  try {
    return await fn()
  } finally {
    apply(prev)
  }
}

/** Run `fn` with the system clock set to `at`, then back to real time. */
export async function withClock<T>(at: Date, fn: () => T | Promise<T>): Promise<T> {
  setSystemTime(at)
  try {
    return await fn()
  } finally {
    setSystemTime()
  }
}

// ------------------------------------------------------------- frames

/** brothy's primary: the fill of a selected sidebar row */
export const B = themeByName("brothy") // the default theme the tests render in
export const PRIMARY = B.primary
export const hex = (c: { r: number; g: number; b: number; a: number }) =>
  c.a === 0 ? null : "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")
/** Per screen row, the text drawn on background `bg` (rows without any are dropped). */
export function onBg(s: Setup, bg = PRIMARY) {
  return s
    .captureSpans()
    .lines.map((l) => l.spans.filter((sp) => hex(sp.bg) === bg).map((sp) => sp.text).join(""))
    .filter(Boolean)
}
/** Rows of the frame as colored spans, flattened. */
export const spansOf = (s: Setup) => s.captureSpans().lines.flatMap((l) => l.spans)

/** 1-based top line of a `numbered` fixture: the first body row shows `row N` (document line N + 2). */
export const topLine = (frame: string) => Number(/\brow (\d+)/.exec(frame.split("\n")[2]!)?.[1]) + 2
/** Ghost line row at 100x30: top line, gap, 26 body rows, ghost line (28), progress line (29). */
export const HINT_ROW = 28
/** The document rows of a frame (no status, ghost or progress lines). */
export const bodyRows = (f: string) => f.split("\n").slice(2, HINT_ROW).join("\n")
export const firstDocRow = (f: string) => f.split("\n")[2]!
/** Widest text run in the rows that contain `lorem`. */
export const loremWidth = (frame: string) =>
  Math.max(
    ...frame
      .split("\n")
      .filter((l) => l.includes("lorem"))
      .map((r) => r.trimEnd().length - r.search(/lorem|ipsum|dolor/)),
  )
/** Screen row of the typewriter reading line at 100x30: 2 chrome rows + floor(26 / 2). */
export const READING_ROW = 15

/** `?` shows hints first when none are visible; press again until the popup opens. */
export async function openHelp(s: Setup) {
  const f = await keys(s, "?")
  return f.includes("Keybindings") ? f : keys(s, "?")
}

/** The panel's tab strip is on screen (compact `¹Files  ²Outline` or full `¹Files   ²Outline`). */
export const panelShown = (f: string) => /Files\s+²Outline/.test(f)

export const W120 = { width: 120, height: 30 }

// ------------------------------------------------------------- fixtures

/** A code block of numbered lines with `needle` on the given ones. */
export function numbered(n: number, needles: number[]) {
  const body = Array.from({ length: n }, (_, i) => (needles.includes(i) ? `row ${i} needle` : `row ${i}`))
  return "```\n" + body.join("\n") + "\n```\n"
}

export function sections(n: number, para = "text") {
  return Array.from({ length: n }, (_, i) => `## Section ${i + 1}\n\n${(para + "\n\n").repeat(12)}`).join("")
}
/** Sections whose paragraphs wrap differently at each measure. */
export const wrapped = () => sections(12, "lorem ipsum dolor sit amet ".repeat(9).trim())
export const parts = (n: number) => Array.from({ length: n }, (_, i) => `## Part ${i + 1}\n\nbody ${i + 1}\n`).join("\n")
export const longB = "# Bee\n\n" + Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n\n") + "\n\n## Part two\n\nend\n"
export const filler = (n: number) => Array.from({ length: n }, (_, i) => `filler ${i}`).join("\n\n")

// ------------------------------------------------------------- AI

export const OLLAMA = { provider: "ollama", model: "llama3.2" }

/** A fetch whose streams the test feeds: send(i, text), fail(i, message), end(i). */
export function aiStub() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const calls: { url: string; body: { messages: { content: string }[] }; signal?: AbortSignal | null }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), signal: init.signal })
    const body = new ReadableStream<Uint8Array>({ start: (c) => void streams.push(c) })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }) as unknown as typeof fetch
  const enc = new TextEncoder()
  const data = (i: number, obj: unknown) => streams[i]!.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
  return {
    f,
    calls,
    send: (i: number, content: string) => data(i, { choices: [{ delta: { content } }] }),
    fail: (i: number, message: string) => data(i, { error: { message } }),
    end: (i: number) => {
      streams[i]!.enqueue(enc.encode("data: [DONE]\n\n"))
      streams[i]!.close()
    },
  }
}

// ------------------------------------------------------------- the harness

/**
 * Call once at the top level of an app test file. Points `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` at temp dirs for the
 * file's tests (restored after them), registers the hooks that tear every mounted app down and clean the dirs after
 * each test, and returns the helpers that touch those dirs.
 */
export function useAppHarness() {
  const cfgDir = makeTmp("brothy-cfg-")
  const cacheDir = makeTmp("brothy-cache-")
  const prevXdg = process.env.XDG_CONFIG_HOME
  const prevCache = process.env.XDG_CACHE_HOME
  const live: Setup[] = []
  const dirs: string[] = []

  /** Destroy every app mounted so far in this test. */
  const unmount = () => {
    for (const s of live.splice(0)) s.renderer.destroy()
  }
  beforeAll(() => {
    setEnv("XDG_CONFIG_HOME", cfgDir) // keep the theme picker and the recents from touching the real ~/.config
    setEnv("XDG_CACHE_HOME", cacheDir)
  })
  afterEach(() => {
    unmount()
    rmSync(join(cacheDir, "brothy"), { recursive: true, force: true })
    rmSync(join(cfgDir, "brothy"), { recursive: true, force: true }) // folds and theme persist; keep tests independent
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  afterAll(async () => {
    await shutdownHighlighter() // the parser worker would otherwise keep the process alive
    setEnv("XDG_CONFIG_HOME", prevXdg)
    setEnv("XDG_CACHE_HOME", prevCache)
    rmSync(cfgDir, { recursive: true, force: true })
    rmSync(cacheDir, { recursive: true, force: true })
  })

  /** A temp folder holding `files` (paths relative to it); removed after the test. */
  function tmp(files: Record<string, string>) {
    const d = makeTmp("brothy-app-", files)
    dirs.push(d)
    return d
  }

  /** Mount `<App>` headless on `root`, opening `file` (relative to it); every mount is destroyed after the test. */
  async function mount(root: string, file?: string, opts: MountOpts = {}) {
    const { size = { width: 100, height: 30 }, theme, ...props } = opts
    const s = quietAct(await testRender(<App root={root} initialFile={file ? join(root, file) : undefined} themeName={theme} {...props} />, size))
    const destroy = s.renderer.destroy
    let gone = false
    s.renderer.destroy = () => { // a test may end an app early (a restart, a signal); the teardown must not destroy it twice
      if (gone) return
      gone = true
      destroy()
    }
    live.push(s)
    await s.renderOnce()
    return s
  }

  /** `mount` with a stubbed AI endpoint: resolves with the app and the stub. */
  async function mountAI(root: string, file?: string, opts: Omit<MountOpts, "fetch"> = {}) {
    const ai = aiStub()
    return { s: await mount(root, file, { ...opts, fetch: ai.f }), ai }
  }

  // config and cache files, written before mounting or read back after
  const configFile = () => join(cfgDir, "brothy", "config.json")
  /** Write `config.json`: an object is merged over what is there (a string is written as is, to test a file that doesn't parse). */
  function writeConfig(cfg: unknown) {
    mkdirSync(join(cfgDir, "brothy"), { recursive: true })
    if (typeof cfg === "string") return writeFileSync(configFile(), cfg)
    const old = existsSync(configFile()) ? JSON.parse(readFileSync(configFile(), "utf8")) : {}
    writeFileSync(configFile(), JSON.stringify({ ...old, ...(cfg as object) }))
  }
  const aiConfig = (ai: object) => writeConfig({ ai })
  /** Write a `zen` section into the test config before mounting. */
  const zenConfig = (zen: Record<string, unknown>) => writeConfig({ zen })
  const savedConfig = () => JSON.parse(readFileSync(configFile(), "utf8"))

  const projectsFile = () => join(cfgDir, "brothy", "projects.json")
  function writeProjects(projects: { root: string; lastNote?: string | null; top?: number; at?: number }[]) {
    mkdirSync(join(cfgDir, "brothy"), { recursive: true })
    writeFileSync(projectsFile(), JSON.stringify({ projects }))
  }
  function seedProjects(entries: { root: string; at: number; lastNote?: string }[]) {
    writeProjects(entries.map((e) => ({ lastNote: null, top: 0, ...e })))
  }
  const readProjects = (): { root: string; lastNote: string | null; top: number }[] => JSON.parse(readFileSync(projectsFile(), "utf8")).projects

  const cacheFile = () => join(cacheDir, "brothy", "summaries.json")
  const cached = () => (existsSync(cacheFile()) ? (JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, { summary: string }>) : {})
  function seedSummary(path: string, summary: string, hash = textHash(noteText(readFileSync(path, "utf8"))), model = "llama3.2") {
    mkdirSync(join(cacheDir, "brothy"), { recursive: true })
    writeFileSync(join(cacheDir, "brothy", "summaries.json"), JSON.stringify({ [path]: { hash, v: 1, summary, model, at: Date.now() } }))
  }
  const glossFile = () => join(cacheDir, "brothy", "glosses.json")
  const glossCache = () => (existsSync(glossFile()) ? (JSON.parse(readFileSync(glossFile(), "utf8")) as Record<string, { gloss: string }>) : {})
  /** Cache a gloss for section `index` of the note at `path`, fresh unless `hash` is given. */
  function seedGloss(path: string, index: number, gloss: string, hash?: string) {
    const g = glossTarget(readFileSync(path, "utf8"), index, path, "a")!
    const all = glossCache()
    all[glossKey(g.id, "explain")] = { hash: hash ?? textHash(g.text), v: 1, gloss, model: "llama3.2", at: Date.now() } as never
    mkdirSync(join(cacheDir, "brothy"), { recursive: true })
    writeFileSync(glossFile(), JSON.stringify(all))
  }

  /** Open a note through the Files filter; the first esc clears the query the last open left there. */
  const openNote = (s: Setup, name: string) => keys(s, "1", "/", "esc", "/", `type:${name}`, "enter")

  /** A folder of six notes in three folders, for the Files tree and the switcher. */
  const vault = () =>
    tmp({
      "Readme.md": "# readme",
      "Journal/day one.md": "# one",
      "Journal/day two.md": "# two",
      "Journal/day three.md": "# three",
      "Work/Projects/Soup Base Stock.md": "# simmer",
      "Work/Projects/Soup Garnish.md": "# garnish",
    })

  return {
    cfgDir, cacheDir, tmp, mount, mountAI, unmount, vault, openNote,
    configFile, writeConfig, aiConfig, zenConfig, savedConfig,
    projectsFile, writeProjects, seedProjects, readProjects,
    cacheFile, cached, seedSummary, glossFile, glossCache, seedGloss,
  }
}
