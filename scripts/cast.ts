// The docs site's demo: bun scripts/cast.ts [dark|light] [--keep]
//   Drives ONE <App> session (scripts/session.tsx, a fake $HOME from scripts/pipeline.ts) through a scripted tour in real time,
//   like scripts/demo.ts, and writes it as an asciicast v2 file: site/public/casts/tour-<dark|light>.cast (brothy / brothy-light).
//   Each kept frame is ANSI truecolor at COLS×ROWS; only the rows that changed are redrawn, so a minute is well under 1 MB.
//   The Nerd Font logo (U+F0617) is swapped for a plain bowl: the player's font has no private-use glyphs.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, sandbox } from "./pipeline"
import { STOCK, fakeFetch, stockEdit, writeAIConfig } from "./fakeai"
import type { Frame } from "./session"

const COLS = 104, ROWS = 30
const TYPE_GAP = 110
const OUT = join(ROOT, "site/public/casts")
const THEMES = { dark: "brothy", light: "brothy-light" } as const
type Mode = keyof typeof THEMES

interface Step { keys?: string; gap?: number; hold: number; write?: [string, (s: string) => string] }

// read, panel, links and history, outline, switcher, themes, AI (TL;DR, ask), live reload + D, zen + gloss
const TOUR: Step[] = [
  { hold: 1500 },
  { keys: "j j j j j j", gap: 150, hold: 500 },
  { keys: "space", hold: 1000 },
  { keys: "tab", hold: 700 },
  { keys: "k", hold: 400 },
  { keys: "enter", hold: 600 },
  { keys: "j j", gap: 300, hold: 300 },
  { keys: "enter", hold: 1400 },
  { keys: "f", hold: 1600 },
  { keys: "a", hold: 1500 },
  { keys: "H", hold: 1100 },
  { keys: "L", hold: 1100 },
  { keys: "2", hold: 800 },
  { keys: "j j j j", gap: 260, hold: 300 },
  { keys: "enter", hold: 1300 },
  { keys: "C-p", hold: 900 },
  { keys: "type:heat", hold: 1100 },
  { keys: "enter", hold: 1400 },
  { keys: "t", hold: 900 },
  { keys: "down down down", gap: 650, hold: 700 },
  { keys: "right", hold: 1200 },
  { keys: "esc", hold: 1000 },
  // AI: the TL;DR streams into Info, then a question finds its section
  { keys: "g", hold: 500 },
  { keys: "a", hold: 5000 },
  { keys: "C-p", hold: 900 },
  { keys: "type:?how\\slong\\sshould\\sbroth\\ssimmer", hold: 900 },
  { keys: "enter", hold: 3200 },
  { keys: "enter", hold: 2000 },
  // saved in another window: Info lists what changed, D explains it, ⏎ jumps
  {
    write: [STOCK, stockEdit],
    hold: 2400,
  },
  { keys: "3", hold: 1800 },
  { keys: "D", hold: 4800 },
  { keys: "enter", hold: 2200 },
  // zen: a gloss under the reading line
  { keys: "z", hold: 1200 },
  { keys: "j j j j j j j j j j j j j j j", gap: 230, hold: 900 },
  { keys: "a", hold: 5200 },
  { keys: "esc", hold: 1200 },
  { keys: "z", hold: 1500 },
]

// ---------- frames → ANSI ----------
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";")

/** One row as SGR runs; the colors are left to the player's theme where the frame has none. */
function row(cells: Frame["lines"][number]): string {
  let out = "", cur = ""
  for (const c of cells) {
    let fg = c.fg, bg = c.bg
    if (c.a & 32) [fg, bg] = [bg, fg]
    const sgr = [
      c.a & 1 ? "1" : "", c.a & 2 ? "2" : "", c.a & 4 ? "3" : "", c.a & 8 ? "4" : "", c.a & 128 ? "9" : "",
      fg ? `38;2;${rgb(fg)}` : "", bg ? `48;2;${rgb(bg)}` : "",
    ].filter(Boolean).join(";")
    if (sgr !== cur) { out += `\x1b[0${sgr ? ";" + sgr : ""}m`; cur = sgr }
    out += c.t.replaceAll("\u{F0617}", "◡")
  }
  return out + "\x1b[0m"
}

function cast(frames: { t: number; f: Frame }[], mode: Mode): string {
  const header = { version: 2, width: COLS, height: ROWS, title: `brothy tour (${THEMES[mode]})`, idle_time_limit: 2 }
  const lines = [JSON.stringify(header)]
  let prev: string[] = []
  for (const { t, f } of frames) {
    const rows = f.lines.map(row)
    let data = prev.length ? "" : "\x1b[?25l\x1b[2J"
    rows.forEach((r, i) => { if (r !== prev[i]) data += `\x1b[${i + 1};1H${r}` })
    prev = rows
    if (data) lines.push(JSON.stringify([+t.toFixed(3), "o", data]))
  }
  return lines.join("\n") + "\n"
}

// ---------- record (child process: $HOME is the sandbox) ----------
async function record(mode: Mode, home: string, out: string) {
  const { frame, frameKey, mount, press, settle, sleep } = await import("./session")
  const { shutdownHighlighter } = await import("../src/highlight")
  writeAIConfig(home)
  const s = await mount({ root: join(home, "examples"), theme: THEMES[mode], width: COLS, height: ROWS, fetch: fakeFetch() })
  await settle(s)
  let rnd = 7 // mulberry32: same jitter every run
  const jitter = () => { rnd = (rnd + 0x6d2b79f5) | 0; let x = Math.imul(rnd ^ (rnd >>> 15), 1 | rnd); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296 - 0.5 }
  const frames: { t: number; f: Frame }[] = []
  const t0 = performance.now()
  let last = ""
  const sample = async () => {
    await s.renderOnce()
    const key = frameKey(s)
    if (key !== last) { frames.push({ t: (performance.now() - t0) / 1000, f: frame(s) }); last = key }
  }
  const run = async (ms: number) => {
    const end = performance.now() + ms
    do {
      const at = performance.now()
      await sample()
      await sleep(Math.max(1, Math.min(1000 / 30 - (performance.now() - at), end - performance.now())))
    } while (performance.now() < end)
  }
  let n = 0
  for (const st of TOUR) {
    if (st.write) { const p = join(home, st.write[0]); writeFileSync(p, st.write[1](readFileSync(p, "utf8"))) }
    for (const k of (st.keys ?? "").split(" ").filter(Boolean)) {
      if (k.startsWith("type:")) for (const ch of k.slice(5).replaceAll("\\s", " ")) { await press(s, `type:${ch}`); await run(TYPE_GAP * (1 + jitter())) }
      else { await press(s, k); await run(st.gap ?? 200) }
    }
    await run(st.hold)
    if (process.env.CAST_TEXT) { mkdirSync(process.env.CAST_TEXT, { recursive: true }); writeFileSync(join(process.env.CAST_TEXT, `${String(n++).padStart(2, "0")}.txt`), `${st.keys ?? "write"} @${((performance.now() - t0) / 1000).toFixed(1)}s\n${s.captureCharFrame()}`) }
  }
  const text = cast(frames, mode)
  mkdirSync(OUT, { recursive: true })
  writeFileSync(out, text)
  s.renderer.destroy()
  await shutdownHighlighter()
}

if (process.argv[2] === "--record") {
  await record(process.argv[3] as Mode, process.argv[4]!, process.argv[5]!)
  process.exit(0)
}

const argv = process.argv.slice(2)
const modes = (["dark", "light"] as const).filter((m) => argv.includes(m))
for (const mode of modes.length ? modes : (["dark", "light"] as const)) {
  const { dir, home } = sandbox()
  const out = join(OUT, `tour-${mode}.cast`)
  mkdirSync(OUT, { recursive: true })
  const child = Bun.spawn(["bun", import.meta.path, "--record", mode, home, out], {
    cwd: ROOT, stdout: "inherit", stderr: "inherit",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", XDG_CACHE_HOME: "" }, // relative paths are ignored: config and cache stay in the sandbox
  })
  if ((await child.exited) !== 0) throw new Error(`recording ${mode} failed`)
  if (!argv.includes("--keep")) rmSync(dir, { recursive: true, force: true })
  const last = JSON.parse(readFileSync(out, "utf8").trim().split("\n").at(-1)!)[0] as number
  console.log(`${out}: ${(statSync(out).size / 1024).toFixed(0)} KB, ${last.toFixed(1)} s`)
}
