// Reproducible walkthrough videos: bun scripts/demo.ts [short|full] [--keep] [--reuse <dir>]
//   short → docs/demo.gif (README hero) + docs/demo-short.mp4 (~20 s); full → docs/demo.mp4 (~60 s); no argument makes both.
//   1. records: a child process (fake $HOME from the sandbox, fresh config) drives ONE <App> session (scripts/session.tsx)
//      through the cut's storyboard in real time, so app timers (toasts, hint fades, the reload flash) play as they would; it
//      keeps a frame whenever the picture changes, and notes when each step starts and each key is pressed
//   2. draws each kept frame as the screenshot window (scripts/pipeline.ts, no shadow) to a PNG at ZOOM× so camera zooms stay crisp
//   3. composites: scripts/cinema.ts turns the recording into one `Shot` per output frame (3D intro/outro, eased camera
//      moves onto each beat, keycap captions, theme sweeps, accent glow); headless Chromium (Playwright) draws each through
//      scripts/stage.html with CSS 3D transforms and screenshots it at 1920×1080
//   4. encodes with ffmpeg: H.264 MP4s and a palette GIF
// --keep leaves the temp dir and prints where it is; --reuse <dir> takes the recordings and window PNGs from a kept dir;
// --only 0,90,400 composites just those output frames (to look at) and encodes nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { join } from "node:path"
import { WORDMARK } from "../src/status"
import { themes } from "../src/theme"
import {
  type Cam, type Layout, type Move, type Pose, type Rect, type Still,
  FLAT, INTRO_FROM, OUTRO_TO, camTrack, capsOf, clamp01, frameRect, homeCam, inCubic, inOutCubic, layersAt, lerp, lerpPose,
  mixHex, onScreen, outBack, outCubic, outQuart, pressDepth, span, tilt, transform,
} from "./cinema"
import { STOCK, fakeFetch, stockEdit, writeAIConfig } from "./fakeai"
import { BAR, CH, CW, DOCS, PAD, ROOT, mix, pngCommand, sandbox, svgDoc, bare } from "./pipeline"
import type { Frame } from "./session"

const COLS = 110, ROWS = 26
const W = 1920, H = 1080
const ZOOM = 2.75 // window PNG scale: fit (1.42) × the deepest camera zoom (1.9) still samples at ≤ 1:1
const TITLE = "brothy ~/examples"
const TYPE_GAP = 120 // ms between typed characters (± jitter)
const GIF_MAX = 8_000_000 // bytes: docs/demo.gif is the README hero

/** A keystroke caption: key caps, then what they do. `null` hides it. */
type Cap = { keys: string[]; text: string } | null
/** Camera target in cells: [col, row, width, height] of the app grid, or back to the whole window. */
type Aim = [number, number, number, number] | "full"
interface Step {
  /** space-separated keys (scripts/session.tsx `press`); `type:<text>` types one character at a time */
  keys?: string
  /** edit a sandbox file on disk (path relative to $HOME) */
  write?: [string, (s: string) => string]
  /** shown from this step on; omitted keeps the previous caption */
  cap?: Cap
  /** where the camera goes as this step starts (it leaves a little early); omitted keeps it */
  cam?: Aim
  /** the camera's zoom cap for `cam` (default: the layout's) */
  zoom?: number
  /** ms between keys */
  gap?: number
  /** ms to wait after the last key */
  hold: number
}

const cap = (keys: string | string[], text: string): Cap => ({ keys: Array.isArray(keys) ? keys : [keys], text })

// stock.md is edited on disk (scripts/fakeai.ts): Info lists the changed sections, D explains them
const RELOAD: Step = {
  write: [STOCK, stockEdit],
  cap: { keys: [], text: "saved in your editor: live reload" },
  cam: [0, 3, 34, 14],
  hold: 2300,
}

const FULL: Step[] = [
  { cap: null, hold: 900 },
  // read
  { keys: "j j j j j j", gap: 150, cap: cap(["j", "k"], "scroll"), hold: 400 },
  { keys: "space", cap: cap("space", "page down"), hold: 1000 },
  // the folder tree
  { keys: "tab", cap: cap("tab", "focus the panel"), hold: 700 },
  { keys: "k", cap: cap(["j", "k"], "move"), hold: 400 },
  { keys: "enter", cap: cap("⏎", "open the folder"), hold: 600 },
  { keys: "j j", gap: 300, cap: cap(["j", "k"], "move"), hold: 300 },
  { keys: "enter", cap: cap("⏎", "read the note"), hold: 1200 },
  // links and history
  { keys: "f", cap: cap("f", "label the links"), cam: [33, 2, 77, 5], hold: 1500 },
  { keys: "a", cap: cap("a", "follow a link"), hold: 1500 },
  { keys: "H", cap: cap("H", "back"), cam: "full", hold: 1100 },
  { keys: "L", cap: cap("L", "forward"), hold: 1100 },
  // outline
  { keys: "2", cap: cap("2", "outline"), hold: 800 },
  { keys: "j j j j", gap: 260, cap: cap(["j", "k"], "move"), hold: 300 },
  { keys: "enter", cap: cap("⏎", "jump to the heading"), hold: 1300 },
  // switcher: with its peek pane the popup is as wide as the theme picker, so both get the same frame
  { keys: "C-p", cap: cap(["ctrl", "p"], "go to a note, heading or text"), cam: [6, 1, 98, 21], hold: 800 },
  { keys: "type:heat", hold: 900 },
  { keys: "enter", cap: cap("⏎", "open the heading"), cam: "full", hold: 1300 },
  // themes
  { keys: "t", cap: cap("t", "pick a theme"), cam: [6, 1, 98, 22], hold: 800 },
  { keys: "down down down", gap: 650, cap: cap(["↑", "↓"], "family, shown in the pane"), hold: 600 },
  { keys: "right", cap: cap(["←", "→"], "dark / light"), hold: 1100 },
  { keys: "enter", cap: cap("⏎", "apply"), cam: "full", hold: 1300 },
  // the picker opens on the theme in use (tokyonight-light), so typing a name keeps its light side: ← takes the dark
  { keys: "t type:brothy", gap: 120, cap: cap("t", "type to filter"), cam: [6, 1, 98, 22], hold: 500 },
  { keys: "left", cap: cap("←", "dark"), hold: 600 },
  { keys: "enter", cap: cap("⏎", "back to brothy"), cam: "full", hold: 1000 },
  // source
  { keys: "s", cap: cap("s", "Markdown source"), hold: 1500 },
  { keys: "s", cap: cap("s", "back to the preview"), hold: 800 },
  // projects
  { keys: "o", cap: cap("o", "open a recent project or a path"), cam: [24, 8, 62, 8], hold: 1300 },
  { keys: "type:~/examples", hold: 600 },
  { keys: "enter", cap: cap("⏎", "open"), cam: "full", hold: 1100 },
  // AI: the config's `ai` block points at scripts/fakeai.ts, which answers offline
  { keys: "g", cap: cap("g", "top"), hold: 500 },
  { keys: "a", cap: cap("a", "TL;DR from your own model"), cam: [0, 3, 34, 14], hold: 4800 },
  { keys: "C-p", cap: cap(["ctrl", "p"], "go to anything"), cam: [6, 1, 98, 21], hold: 800 },
  { keys: "type:?how\\slong\\sshould\\sbroth\\ssimmer", cap: cap("?", "ask a question"), hold: 700 },
  { keys: "enter", cap: cap("⏎", "ask: only the question is sent"), hold: 3000 },
  { keys: "enter", cap: cap("⏎", "open the answer"), cam: "full", hold: 1800 },
  // live reload, then D explains what changed
  RELOAD,
  { keys: "3", cap: cap("3", "info lists what changed"), hold: 1400 },
  { keys: "D", cap: cap("D", "explain the change"), hold: 4600 },
  { keys: "enter", cap: cap("⏎", "jump to it"), cam: "full", hold: 1800 },
  // zen, with a gloss under the reading line
  { keys: "z", cap: cap("z", "zen mode"), cam: [19, 12, 70, 10], hold: 1100 },
  { keys: "j j j j j j j j j j j j j j j", gap: 230, cap: cap(["j", "k"], "read"), hold: 800 },
  { keys: "a", cap: cap("a", "gloss this section"), hold: 5000 },
  { keys: "esc", cap: cap("esc", "hide it"), hold: 1000 },
  { keys: "z", cap: cap("z", "leave zen"), cam: "full", hold: 1300 },
]

const SHORT: Step[] = [
  { cap: null, hold: 400 },
  { keys: "f", cap: cap("f", "label the links"), cam: [33, 2, 77, 5], hold: 1000 },
  { keys: "a", cap: cap("a", "follow"), hold: 900 },
  { keys: "C-p", cap: cap(["ctrl", "p"], "go to anything"), cam: [6, 1, 98, 21], hold: 450 },
  { keys: "type:heat", hold: 600 },
  { keys: "enter", cap: cap("⏎", "open"), cam: "full", hold: 800 },
  { keys: "t", cap: cap("t", "pick a theme · ←→ dark / light"), cam: [6, 1, 98, 22], hold: 600 },
  // the pane shows the family; esc keeps brothy: applying (the full cut does) sweeps the window twice and the GIF
  // outgrows GIF_MAX (a TL;DR step in this cut did too: the AI features are in the full cut and the site casts)
  { keys: "down down down", gap: 450, cap: cap(["↑", "↓"], "family, shown in the pane"), hold: 700 },
  { keys: "esc", cap: cap("esc", "keep yours"), cam: "full", hold: 450 },
  { keys: "z", cap: cap("z", "zen mode"), cam: [19, 3, 70, 14], hold: 700 }, // from row 3 the zen heading row stays in the frame
  { keys: "j j j j", gap: 260, cap: cap(["j", "k"], "read"), hold: 500 },
  { keys: "z", cap: null, cam: "full", hold: 700 },
]

interface Cut {
  name: "short" | "full"
  story: Step[]
  initialFile?: string
  /** title card alone, intro flight, outro, end card (s) */
  title: number; intro: number; outro: number; end: number
}
const CUTS: Record<Cut["name"], Cut> = {
  short: { name: "short", story: SHORT, initialFile: "examples/notes/simmering.md", title: 1.2, intro: 1.25, outro: 0.95, end: 1.8 },
  full: { name: "full", story: FULL, title: 2.0, intro: 1.8, outro: 1.3, end: 3.0 },
}

interface Rec { t: number; f: Frame }
interface Recording { frames: Rec[]; marks: number[]; presses: { t: number; key: string }[]; end: number }

// ---------- record (child process: $HOME is the sandbox) ----------
async function record(cut: Cut, home: string, out: string) {
  const { frame, frameKey, mount, press, settle, sleep } = await import("./session")
  const { shutdownHighlighter } = await import("../src/highlight")
  writeAIConfig(home)
  const s = await mount({ root: join(home, "examples"), initialFile: cut.initialFile && join(home, cut.initialFile), width: COLS, height: ROWS, fetch: fakeFetch(), transparent: true })
  await settle(s)
  let rnd = 42 // mulberry32: same jitter every run
  const jitter = () => { rnd = (rnd + 0x6d2b79f5) | 0; let x = Math.imul(rnd ^ (rnd >>> 15), 1 | rnd); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296 - 0.5 }
  const frames: Rec[] = [], marks: number[] = [], presses: Recording["presses"] = []
  const t0 = performance.now()
  const now = () => (performance.now() - t0) / 1000
  let last = ""
  const sample = async () => {
    await s.renderOnce()
    const key = frameKey(s)
    if (key !== last) { frames.push({ t: now(), f: frame(s) }); last = key }
  }
  const run = async (ms: number) => {
    const end = performance.now() + ms
    do {
      const at = performance.now()
      await sample()
      await sleep(Math.max(1, Math.min(1000 / 60 - (performance.now() - at), end - performance.now())))
    } while (performance.now() < end)
  }
  for (const st of cut.story) {
    marks.push(now())
    if (st.write) { const p = join(home, st.write[0]); writeFileSync(p, st.write[1](readFileSync(p, "utf8"))) }
    for (const k of (st.keys ?? "").split(" ").filter(Boolean)) {
      if (k.startsWith("type:")) for (const ch of k.slice(5).replaceAll("\\s", " ")) { await press(s, `type:${ch}`); await run(TYPE_GAP * (1 + jitter())) }
      else { presses.push({ t: now(), key: k }); await press(s, k); await run(st.gap ?? 200) }
    }
    await run(st.hold)
  }
  writeFileSync(out, JSON.stringify({ frames, marks, presses, end: now() } satisfies Recording))
  s.renderer.destroy()
  await shutdownHighlighter()
}

// ---------- window PNGs ----------
const base = themes[0]! // brothy: the canvas is the same whatever theme the app shows
const BACK = mix(base.background, "#000000", 0.55)

/** The theme a frame is drawn in: the one whose colors cover the most cells (a scrim or popup dims some, never all). */
function themeOf(f: Frame) {
  let best = base, most = -1
  for (const th of themes) {
    const bgs = new Set([th.background, th.backgroundPanel, th.backgroundElement]), fgs = new Set([th.text, th.textMuted, th.primary, th.secondary, th.accent])
    let n = 0
    for (const c of f.lines.flat()) { const w = Bun.stringWidth(c.t); if (c.bg && bgs.has(c.bg)) n += w; if (c.fg && fgs.has(c.fg) && c.t.trim()) n += w }
    if (n > most) { most = n; best = th }
  }
  return best
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => { for (let i = next++; i < items.length; i = next++) await fn(items[i]!, i) }))
}

/** Each frame as a window PNG (ZOOM×), plus how it enters (a change of theme or transparency sweeps) and the theme's accent. */
async function stills(rec: Recording, dir: string): Promise<{ stills: Still[]; ww: number; wh: number }> {
  mkdirSync(dir, { recursive: true })
  let prev = ""
  let ww = 0, wh = 0
  const jobs: { svg: string; png: string }[] = []
  const rgba = (hex: string, a: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",")},${a})`
  const out = rec.frames.map((r, i): Still => {
    const theme = themeOf(r.f), accent = theme.primary
    const win = bare(r.f, theme.background, theme.text)
    ww = win.w; wh = BAR + win.h
    const look = theme.name
    const png = join(dir, `${String(i).padStart(5, "0")}.png`)
    if (!existsSync(png)) {
      const svg = png.replace(/\.png$/, ".svg")
      writeFileSync(svg, svgDoc(win.w, win.h, win.body))
      jobs.push({ svg, png })
    }
    const st: Still = { src: `file://${png}`, t: r.t, sweep: i > 0 && look !== prev, accent, glass: rgba(theme.background, theme.mode === "light" ? 0.8 : 0.74), ink: mix(theme.text, theme.background, 0.45) }
    prev = look
    return st
  })
  await pool(jobs, cpus().length, async ({ svg, png }) => {
    const cmd = pngCommand(svg, png, ZOOM)
    const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" })
    if ((await p.exited) !== 0) throw new Error(`resvg failed on ${svg}:\n${await new Response(p.stderr).text()}`)
  })
  return { stills: out, ww, wh }
}

// ---------- shots ----------
/** One output frame, as scripts/stage.html draws it. */
interface Shot {
  t: number
  title: { o: number; y: number; s: number } | null
  end: { o: number; y: number; s: number } | null
  win: { o: number; tf: string; reflect: number; glow: string; glowA: number; layers: { src: string; p: number; accent: string; glass?: string; ink?: string }[] } | null
  cap: { keys: { k: string; d: number }[]; text: string; o: number; y: number; s: number } | null
}

const CAP_LOW = 1000, CAP_HIGH = 76
const LEAD = 0.28 // the camera and the caption move this long before a step starts

function shots(cut: Cut, rec: Recording, st: Still[], L: Layout, fps: number): Shot[] {
  const cell = ([c, r, w, h]: [number, number, number, number]): Rect => ({ x: PAD + c * CW, y: BAR + PAD + r * CH, w: w * CW, h: h * CH })
  // camera moves and caption placement, in recording time
  const moves: Move[] = []
  const capY: { t: number; y: number }[] = [{ t: 0, y: CAP_LOW }]
  cut.story.forEach((s, i) => {
    if (!s.cam) return
    const to: Cam = s.cam === "full" ? homeCam(L) : frameRect(L, cell(s.cam), s.zoom)
    moves.push({ t: rec.marks[i]! - LEAD, d: s.cam === "full" ? 0.8 : 0.95, to })
    // a target that would sit under a bottom caption sends the caption to the top
    const r = s.cam === "full" ? null : onScreen(L, to, cell(s.cam))
    capY.push({ t: rec.marks[i]! - LEAD, y: r && r.y + r.h > CAP_LOW - 50 ? CAP_HIGH : CAP_LOW })
  })
  const cam = camTrack(homeCam(L), moves)
  const capYAt = (r: number) => {
    let y = CAP_LOW, from = CAP_LOW, at = 0
    for (const c of capY) if (c.t <= r) { from = lerp(from, y, span(c.t, at, at + 0.45)); y = c.y; at = c.t }
    return lerp(from, y, span(r, at, at + 0.45))
  }
  // captions: the caption in effect per step, and when it last changed
  const caps: { cap: Cap; since: number }[] = []
  cut.story.forEach((s, i) => {
    const prev = caps[i - 1]
    caps.push(s.cap === undefined && prev ? prev : { cap: s.cap ?? null, since: rec.marks[i]! - LEAD })
  })

  const introAt = cut.title - 0.35, tour = introAt + cut.intro, outro = tour + rec.end, total = outro + cut.outro + cut.end
  const n = Math.round(total * fps)
  const out: Shot[] = []
  let glow = st[0]!.accent
  for (let i = 0; i < n; i++) {
    const t = i / fps
    const r = Math.max(0, Math.min(rec.end, t - tour))
    // title card: rises in, then the camera pushes through it as the window arrives
    const tIn = span(t, 0.1, 0.8, outCubic), tOut = span(t, introAt - 0.15, introAt + 0.4, inOutCubic)
    const title = t < introAt + 0.5 ? { o: tIn * (1 - tOut), y: lerp(24, 0, tIn) - 70 * tOut, s: lerp(0.96, 1, tIn) * lerp(1, 1.12, tOut) } : null
    const eIn = span(t, outro + cut.outro * 0.7, outro + cut.outro * 0.7 + 0.8, outCubic)
    const end = eIn > 0 ? { o: eIn, y: lerp(30, 0, eIn), s: lerp(0.96, 1, eIn) } : null

    let pose: Pose = FLAT
    if (t < tour) { const p = clamp01((t - introAt) / cut.intro); pose = lerpPose(INTRO_FROM, FLAT, outQuart(p), span(p, 0.12, 0.5, outCubic)) }
    else if (t > outro) { const p = clamp01((t - outro) / cut.outro); pose = lerpPose(FLAT, OUTRO_TO, inOutCubic(p) * 0.35 + inCubic(p) * 0.65, span(p, 0.2, 0.8, inOutCubic)) }
    const c = t < tour || t > outro ? homeCam(L) : cam(r)
    const layers = layersAt(st, r)
    glow = mixHex(glow, layers.at(-1)!.accent, 1 - Math.exp(-1 / fps / 0.3))
    const win = t >= introAt && pose.o > 0.001
      ? { o: pose.o, tf: transform(L, c, pose), reflect: tilt(pose) * pose.o, glow, glowA: pose.o, layers }
      : null

    let capShot: Shot["cap"] = null
    if (t >= tour && t < outro + 0.3) {
      let k = -1
      for (let j = 0; j < caps.length && caps[j]!.since <= r; j++) k = j
      // a caption that goes away fades out; a new one pops in
      const gone = k > 0 && !caps[k]!.cap && r - caps[k]!.since < 0.2
      const cur = gone ? caps[k - 1]! : k >= 0 ? caps[k]! : null
      if (cur?.cap) {
        const dt = r - cur.since
        const keys = cur.cap.keys.map((label) => {
          const p = rec.presses.filter((q) => q.t <= r && q.t >= cur.since && capsOf(q.key).includes(label)).at(-1)
          return { k: label, d: p ? pressDepth(r - p.t) : 0 }
        })
        const fade = (1 - span(t, outro, outro + 0.3)) * (gone ? 1 - span(r, caps[k]!.since, caps[k]!.since + 0.2) : 1)
        capShot = { keys, text: cur.cap.text, o: span(dt, 0, 0.16, outCubic) * fade, y: capYAt(r), s: lerp(0.82, 1, outBack(clamp01(dt / 0.3))) }
      }
    }
    out.push({ t, title, end, win, cap: capShot })
  }
  return out
}

// ---------- composite (headless Chromium) ----------
async function composite(frames: Shot[], L: Layout, dir: string, only?: number[]) {
  const { chromium } = await import("playwright")
  const launch = () => chromium.launch({ args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--allow-file-access-from-files"] })
  try { await (await launch()).close() } catch (e) {
    if (!String(e).includes("Executable doesn't exist")) throw e
    console.log("downloading headless Chromium (playwright install chromium-headless-shell)…")
    const p = Bun.spawnSync(["bunx", "playwright", "install", "chromium-headless-shell"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" })
    if (p.exitCode !== 0) throw new Error("playwright install failed")
  }
  mkdirSync(dir, { recursive: true })
  const config = {
    ww: L.ww, wh: L.wh, wordmark: WORDMARK, tagline: "a calm terminal Markdown reader", url: "github.com/jackMort/brothy · releases",
    title: TITLE, bar: BAR,
    install: "download a binary, then <b>brothy ~/notes</b>",
    vars: {
      back: BACK, primary: base.primary, ink: mix(base.text, BACK, 0.08), mute: mix(base.text, BACK, 0.45),
      "cap-hi": mix(BACK, "#ffffff", 0.2), "cap-lo": mix(BACK, "#ffffff", 0.11), "cap-side": mix(BACK, "#ffffff", 0.03),
      // the site's wallpaper (site/src/styles/brothy.css .stage .wall), brothy dark
      bg: base.background, element: base.backgroundElement, text: base.text, secondary: base.secondary, accent: base.accent,
    },
  }
  const workers = Math.max(1, Math.min(8, cpus().length - 2))
  const chunk = Math.ceil(frames.length / workers)
  let done = 0
  const t0 = performance.now()
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const browser = await launch() // one browser each: a shared one serialises on its single GPU (SwiftShader) process
    const page = await browser.newPage({ viewport: { width: W, height: H } })
    await page.goto(`file://${join(import.meta.dir, "stage.html")}`)
    await page.evaluate((c) => (window as any).init(c), config)
    await page.evaluate(() => document.fonts.ready)
    for (let i = w * chunk; i < Math.min(frames.length, (w + 1) * chunk); i++) {
      if (only && !only.includes(i)) continue
      await page.evaluate((s) => (window as any).draw(s), frames[i]!)
      await page.screenshot({ path: join(dir, `${String(i).padStart(6, "0")}.png`) })
      if (++done % 300 === 0) console.log(`  ${done}/${frames.length} frames (${((performance.now() - t0) / 1000).toFixed(0)} s)`)
    }
    await browser.close()
  }))
}

// ---------- main ----------
if (process.argv[2] === "--record") {
  await record(CUTS[process.argv[3] as Cut["name"]], process.argv[4]!, process.argv[5]!)
  process.exit(0)
}

const argv = process.argv.slice(2)
const keep = argv.includes("--keep")
const reuse = argv.includes("--reuse") ? argv[argv.indexOf("--reuse") + 1] : undefined
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1]!.split(",").map(Number) : undefined
const which = (["short", "full"] as const).filter((c) => argv.includes(c))
const todo = which.length ? which : (["short", "full"] as const)
mkdirSync(DOCS, { recursive: true })
const dir = reuse ?? mkdtempSync(join(tmpdir(), "brothy-demo-"))
const started = performance.now()
try {
  for (const name of todo) {
    const cut = CUTS[name]
    const work = join(dir, name)
    mkdirSync(work, { recursive: true })
    // 1. record (each cut in a fresh sandbox: the full tour edits a note and changes the theme)
    const recFile = join(work, "recording.json")
    if (!existsSync(recFile)) {
      const { home } = sandbox()
      const child = Bun.spawn(["bun", import.meta.path, "--record", name, home, recFile], {
        cwd: ROOT,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
        stdout: "pipe",
        stderr: "pipe",
      })
      await child.exited
      rmSync(join(home, ".."), { recursive: true, force: true })
      if (child.exitCode !== 0) throw new Error(`recording failed:\n${await new Response(child.stderr).text()}`)
    }
    const rec = JSON.parse(readFileSync(recFile, "utf8")) as Recording
    console.log(`${name}: recorded ${rec.frames.length} frames over ${rec.end.toFixed(1)} s`)

    // 2. window PNGs
    const { stills: st, ww, wh } = await stills(rec, join(work, "win"))
    const fit = 1.42
    const L: Layout = { W, H, ww, wh, fit, home: { x: W / 2, y: 52 + (wh * fit) / 2 }, zmax: 1.9 }

    // 3. composite
    const fps = 60
    const frames = shots(cut, rec, st, L, fps)
    const out = join(work, "out")
    rmSync(out, { recursive: true, force: true })
    console.log(`${name}: compositing ${frames.length} frames (${(frames.length / fps).toFixed(1)} s at ${fps} fps)`)
    await composite(frames, L, out, only)
    if (only) { console.log(`${name}: frames ${only.join(", ")} in ${out}`); continue }

    // 4. encode
    const ff = (args: string[]) => {
      const r = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(out, "%06d.png"), ...args], { stdout: "inherit", stderr: "pipe" })
      if (r.exitCode !== 0) throw new Error(`ffmpeg failed:\n${r.stderr.toString()}`)
    }
    const mb = (p: string) => (statSync(p).size / 1048576).toFixed(2)
    const x264 = (o: string, w: number, crf: number) => ["-vf", `scale=${w}:-2:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-movflags", "+faststart", o]
    if (name === "full") {
      const mp4 = join(DOCS, "demo.mp4")
      ff(x264(mp4, 1920, 26)) // under the 10 MB the README player loads comfortably
      console.log(`docs/demo.mp4 ${mb(mp4)} MB`)
    } else {
      const mp4 = join(DOCS, "demo-short.mp4"), gif = join(DOCS, "demo.gif")
      ff(x264(mp4, 1920, 22))
      // 12 fps, coarse ordered dither (it stays put where the picture does); fewer colours until it fits the README budget
      for (const colors of [112, 96, 80, 64]) {
        ff(["-vf", `fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gif])
        if (statSync(gif).size <= GIF_MAX) break
      }
      console.log(`docs/demo-short.mp4 ${mb(mp4)} MB · docs/demo.gif ${mb(gif)} MB`)
    }
  }
  console.log(`done in ${((performance.now() - started) / 1000).toFixed(0)} s`)
} finally {
  if (keep || reuse) console.log(`kept ${dir}`)
  else rmSync(dir, { recursive: true, force: true })
}
