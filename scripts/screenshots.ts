// Reproducible README screenshots: bun scripts/screenshots.ts [name ...]
//   1. runs scripts/snapshot.tsx in a sandbox (fake $HOME with a few demo folders, throwaway config), colored spans out as JSON
//   2. draws each frame as an SVG terminal window (docs/<name>.svg) on an exact monospace grid (scripts/pipeline.ts)
//   3. converts to PNG (docs/<name>.png, 2x) with resvg (required)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { WORDMARK } from "../src/status"
import { themes } from "../src/theme"
import { DOCS, FAMILY, MARGIN, ROOT, STACK, esc, luma, mix, sandbox, svgDoc, toPng, window, type Win } from "./pipeline"
import type { Frame } from "./session"

const HERO_KEYS = "tab k enter j j enter" // focus the panel, expand notes/, open simmering.md

/** `path` is the folder opened, relative to the sandbox $HOME (default examples; made if missing). */
interface Shot { name: string; size: string; keys: string; theme?: string; title: string; path?: string }
const SHOTS: Shot[] = [
  { name: "screenshot", size: "120x36", keys: HERO_KEYS, title: "brothy ~/examples" },
  { name: "outline-light", size: "110x30", keys: `${HERO_KEYS} 2 j j`, theme: "brothy-light", title: "brothy ~/examples" },
  { name: "switcher", size: "110x30", keys: `${HERO_KEYS} C-p type:heat`, title: "brothy ~/examples" },
  { name: "open", size: "110x30", keys: `${HERO_KEYS} o`, title: "brothy ~/examples" },
  { name: "zen", size: "110x30", keys: `${HERO_KEYS} z ${"j ".repeat(16).trim()}`, title: "brothy ~/examples" },
  { name: "links", size: "110x30", keys: `${HERO_KEYS} wait:800 f`, title: "brothy ~/examples" },
  { name: "themes", size: "120x34", keys: `${HERO_KEYS} t down down`, title: "brothy ~/examples" }, // the board on dracula, all 22 families
  { name: "welcome", size: "120x34", keys: "", title: "brothy ~/drafts", path: "drafts" }, // an empty folder: the welcome page, recents from the sandbox
  { name: "keys", size: "110x30", keys: `${HERO_KEYS} ?`, title: "brothy ~/examples" },
  { name: "keys-light", size: "110x30", keys: `${HERO_KEYS} ?`, theme: "brothy-light", title: "brothy ~/examples" }, // the docs site's Keys page in light mode
]

// ---------- capture ----------
async function capture(s: Shot, home: string, dir: string): Promise<Frame> {
  const json = join(dir, `${s.name}.json`)
  const cfg = join(dir, `config-${s.name}`) // fresh copy per shot: the app saves view/theme/recents
  cpSync(join(home, ".config"), cfg, { recursive: true })
  const root = join(home, s.path ?? "examples")
  mkdirSync(root, { recursive: true })
  const args = ["bun", join(ROOT, "scripts/snapshot.tsx"), root, "--size", s.size, "--keys", s.keys, "--json", json, "--config", cfg]
  if (s.theme) args.push("--theme", s.theme)
  const p = Bun.spawn(args, { cwd: ROOT, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" })
  await p.exited
  if (p.exitCode !== 0) throw new Error(`snapshot ${s.name} failed:\n${await new Response(p.stderr).text()}`)
  return tilde(JSON.parse(readFileSync(json, "utf8")) as Frame, home)
}

/** The sandbox $HOME as `~` wherever the app prints a full path (the welcome page), padded both sides so centred text stays put. */
function tilde(f: Frame, home: string): Frame {
  for (const cells of f.lines)
    for (const c of cells) {
      if (!c.t.includes(home)) continue
      const t = c.t.replaceAll(home, "~"), d = c.t.length - t.length
      c.t = " ".repeat(Math.floor(d / 2)) + t + " ".repeat(Math.ceil(d / 2))
    }
  return f
}

// ---------- social preview ----------
function social(hero: Win): string {
  const W = 1280, H = 640
  const sc = 0.62
  const wx = W - hero.w * sc - 40, wy = 96
  const wm = WORDMARK.map((l, i) => `<text x="64" y="${150 + i * 50}" font-size="${40}" fill="${hero.accent}">${esc(l)}</text>`).join("")
  const dark = luma(hero.bg) < 128
  const base = dark ? mix(hero.bg, "#000000", 0.55) : mix(hero.bg, "#000000", 0.08)
  const sub = mix(hero.fg, base, 0.15)
  const mute = mix(hero.fg, base, 0.5)
  return svgDoc(W, H, `
  <defs><radialGradient id="g" cx="0.78" cy="0.55" r="0.8"><stop offset="0" stop-color="${mix(base, hero.accent, 0.16)}"/><stop offset="1" stop-color="${base}"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <g font-family="${STACK}">
    <g text-rendering="geometricPrecision" font-weight="700">${wm}</g>
    <text x="64" y="${150 + 3 * 50 + 28}" font-size="21" fill="${sub}">A calm terminal Markdown reader.</text>
    <text x="64" y="${150 + 3 * 50 + 66}" font-size="18" fill="${mute}">folder tree · outline · live reload</text>
    <text x="64" y="${150 + 3 * 50 + 94}" font-size="18" fill="${mute}">Obsidian wikilinks · callouts · zen mode</text>
    <text x="64" y="${150 + 3 * 50 + 122}" font-size="18" fill="${mute}">42 themes</text>
  </g>
  <g transform="translate(${wx} ${wy}) scale(${sc})">${hero.body}</g>`)
}

// ---------- main ----------
const want = process.argv.slice(2)
const shots = SHOTS.filter((s) => !want.length || want.includes(s.name) || (want.includes("social") && s.name === "screenshot"))
mkdirSync(DOCS, { recursive: true })
const { dir, home } = sandbox()
try {
  let hero: Win | null = null
  for (const s of shots) {
    const frame = await capture(s, home, dir)
    // the theme's text color, not the frame's commonest (the welcome bowl, zen's dimmed lines): every title bar alike
    const win = window(frame, s.title, s.name, { fg: themes.find((t) => t.name === (s.theme ?? "brothy"))!.text })
    if (s.name === "screenshot") hero = win
    const out = svgDoc(win.w + 2 * MARGIN, win.h + 2 * MARGIN, `<g transform="translate(${MARGIN} ${MARGIN})">${win.body}</g>`)
    const svg = join(DOCS, `${s.name}.svg`)
    writeFileSync(svg, out)
    toPng(svg, join(DOCS, `${s.name}.png`))
    console.log(`docs/${s.name}.{svg,png}`)
  }
  if (hero && (!want.length || want.includes("social"))) {
    const svg = join(DOCS, "social.svg")
    writeFileSync(svg, social(hero))
    toPng(svg, join(DOCS, "social.png"), 1)
    console.log("docs/social.{svg,png}")
  }
  console.log(`png via resvg, font ${FAMILY}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
