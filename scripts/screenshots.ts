// Reproducible README screenshots: bun scripts/screenshots.ts [name ...]
//   1. runs scripts/snapshot.tsx in a sandbox (fake $HOME with a few demo folders, throwaway config), colored spans out as JSON
//   2. draws each frame as an SVG terminal window (docs/<name>.svg) on an exact monospace grid
//   3. converts to PNG (docs/<name>.png, 2x) with resvg, falling back to rsvg-convert, then magick
// Font: JetBrainsMono Nerd Font Mono (found with fc-list; the logo U+F0617 is a Nerd Font glyph). The SVGs only *reference* the
// family, so they render with fallback glyphs where it is not installed; the PNGs are made here, where it is.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { WORDMARK } from "../src/status"

interface Cell { t: string; fg: string | null; bg: string | null; a: number }
interface Frame { cols: number; rows: number; lines: Cell[][] }

const ROOT = resolve(import.meta.dir, "..")
const DOCS = join(ROOT, "docs")
const FAMILY = "JetBrainsMono Nerd Font Mono"
const STACK = `'${FAMILY}', 'JetBrains Mono', 'DejaVu Sans Mono', monospace`
const FS = 16, CW = FS * 0.6, CH = 21 // font size, cell width (JetBrains Mono advance is 0.6 em), cell height
const BAR = 38, PAD = 14, MARGIN = 36, RADIUS = 12
const SCALE = 2

const HERO_KEYS = "tab k enter j j enter" // focus the panel, expand notes/, open simmering.md

interface Shot { name: string; size: string; keys: string; theme?: string; title: string; path?: string }
const SHOTS: Shot[] = [
  { name: "screenshot", size: "120x36", keys: HERO_KEYS, title: "brothy ~/examples" },
  { name: "outline-light", size: "110x30", keys: `${HERO_KEYS} 2 j j`, theme: "brothy-light", title: "brothy ~/examples" },
  { name: "switcher", size: "110x30", keys: `${HERO_KEYS} C-p type:heat`, title: "brothy ~/examples" },
  { name: "open", size: "110x30", keys: `${HERO_KEYS} o`, title: "brothy ~/examples" },
  { name: "zen", size: "110x30", keys: `${HERO_KEYS} z ${"j ".repeat(16).trim()}`, title: "brothy ~/examples" },
  { name: "links", size: "110x30", keys: `${HERO_KEYS} wait:800 f`, title: "brothy ~/examples" },
]

// ---------- colors ----------
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const hex = (c: number[]) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")
const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i]! - v) * t)) }
const luma = (h: string) => { const [r, g, b] = rgb(h) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function mostCommon(xs: (string | null)[]): string | null {
  const n = new Map<string, number>()
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

// ---------- frame → SVG ----------
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function grid(f: Frame, bg: string, fg: string): string {
  const rects: string[] = []
  const texts: string[] = []
  const lines: string[] = []
  f.lines.forEach((cells, row) => {
    const y = row * CH
    let col = 0
    let run: { x: number; w: number; c: string } | null = null
    const flush = () => { if (run) rects.push(`<rect x="${run.x}" y="${y}" width="${run.w}" height="${CH}" fill="${run.c}"/>`); run = null }
    for (const s of cells) {
      const inv = (s.a & 32) !== 0
      let f0 = s.fg ?? fg, b0 = s.bg ?? bg
      if (inv) [f0, b0] = [b0, f0]
      const w = Bun.stringWidth(s.t)
      if (b0 !== bg) {
        if (run && run.c === b0 && Math.abs(run.x + run.w - col * CW) < 0.01) run.w += w * CW
        else { flush(); run = { x: col * CW, w: w * CW, c: b0 } }
      } else flush()
      const color = s.a & 2 ? mix(f0, b0, 0.45) : f0 // dim
      const attrs = (s.a & 1 ? ' font-weight="700"' : "") + (s.a & 4 ? ' font-style="italic"' : "")
      const single: { x: number; ch: string }[] = []
      const multi: string[] = []
      let c = col
      for (const { segment: g } of seg.segment(s.t)) {
        const gw = Bun.stringWidth(g)
        if (g.trim() !== "" && gw > 0) {
          if ([...g].length === 1) single.push({ x: c * CW, ch: g })
          else multi.push(`<text x="${c * CW}" y="${y + CH - 5.5}" fill="${color}"${attrs}>${esc(g)}</text>`)
        }
        c += gw
      }
      const base = y + CH - 5.5
      if (single.length)
        texts.push(`<text x="${single.map((p) => +p.x.toFixed(2)).join(" ")}" y="${base}" fill="${color}"${attrs}>${esc(single.map((p) => p.ch).join(""))}</text>`)
      texts.push(...multi)
      if (s.a & 8 && s.t.trim()) lines.push(`<rect x="${col * CW}" y="${y + CH - 3}" width="${w * CW}" height="1" fill="${color}"/>`)
      if (s.a & 128 && s.t.trim()) lines.push(`<rect x="${col * CW}" y="${y + CH / 2 - 0.5}" width="${w * CW}" height="1" fill="${color}"/>`)
      col += w
    }
    flush()
  })
  return `<g shape-rendering="crispEdges">${rects.join("")}${lines.join("")}</g><g text-rendering="geometricPrecision">${texts.join("")}</g>`
}

interface Win { w: number; h: number; body: string; bg: string; fg: string; accent: string }

function window(f: Frame, title: string, id: string): Win {
  const bg = mostCommon(f.lines.flat().map((c) => c.bg)) ?? "#000000"
  const fg = mostCommon(f.lines.flat().filter((c) => c.t.trim()).map((c) => c.fg)) ?? "#ffffff"
  const logo = f.lines.flat().find((c) => c.t.includes("\u{F0617}"))
  const accent = logo?.fg ?? fg
  const dark = luma(bg) < 128
  const chrome = mix(bg, dark ? "#ffffff" : "#000000", dark ? 0.06 : 0.05)
  const edge = mix(bg, dark ? "#ffffff" : "#000000", dark ? 0.16 : 0.14)
  const gw = f.cols * CW, gh = f.rows * CH
  const w = gw + 2 * PAD, h = BAR + gh + 2 * PAD
  const dots = ["#ff5f57", "#febc2e", "#28c840"].map((c, i) => `<circle cx="${20 + i * 20}" cy="${BAR / 2}" r="6" fill="${c}"/>`).join("")
  const body = `
  <defs>
    <clipPath id="c-${id}"><rect width="${w}" height="${h}" rx="${RADIUS}"/></clipPath>
    <filter id="s-${id}" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect x="0" y="22" width="${w}" height="${h}" rx="${RADIUS}" fill="#000" opacity="${dark ? 0.55 : 0.28}" filter="url(#s-${id})"/>
  <g clip-path="url(#c-${id})">
    <rect width="${w}" height="${h}" fill="${bg}"/>
    <rect width="${w}" height="${BAR}" fill="${chrome}"/>
    <rect y="${BAR - 1}" width="${w}" height="1" fill="${edge}"/>
    ${dots}
    <text x="${w / 2}" y="${BAR / 2 + 4.5}" text-anchor="middle" font-size="13" fill="${mix(fg, bg, 0.45)}" font-family="${STACK}">${esc(title)}</text>
    <g transform="translate(${PAD} ${BAR + PAD})" font-family="${STACK}" font-size="${FS}" xml:space="preserve">${grid(f, bg, fg)}</g>
  </g>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${RADIUS}" fill="none" stroke="${edge}"/>`
  return { w, h, body, bg, fg, accent }
}

const svgDoc = (w: number, h: number, inner: string, bg = "none") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg === "none" ? "" : `<rect width="${w}" height="${h}" fill="${bg}"/>`}${inner}</svg>\n`

// ---------- sandbox + capture ----------
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "brothy-shots-"))
  const home = join(dir, "home")
  const note = (p: string, body: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body) }
  cpSync(join(ROOT, "examples"), join(home, "examples"), { recursive: true })
  note(join(home, "notes/inbox.md"), "# Inbox\n")
  note(join(home, "notes/reading-list.md"), "# Reading list\n")
  note(join(home, "work/handbook/onboarding.md"), "# Onboarding\n")
  note(join(home, "code/recipes/stock.md"), "# Stock\n")
  const day = 86_400_000, now = Date.now()
  const rec = [["notes", "inbox.md", 1], ["work/handbook", "onboarding.md", 3], ["code/recipes", "stock.md", 9]] as const
  const projects = rec.map(([r, n, d]) => ({ root: join(home, r), lastNote: join(home, r, n), top: 0, at: now - d * day }))
  note(join(home, ".config/brothy/projects.json"), JSON.stringify({ projects }))
  return { dir, home }
}

async function capture(s: Shot, home: string, dir: string): Promise<Frame> {
  const json = join(dir, `${s.name}.json`)
  const cfg = join(dir, `config-${s.name}`) // fresh copy per shot: the app saves view/theme/recents
  cpSync(join(home, ".config"), cfg, { recursive: true })
  const args = ["bun", join(ROOT, "scripts/snapshot.tsx"), join(home, "examples"), "--size", s.size, "--keys", s.keys, "--json", json, "--config", cfg]
  if (s.theme) args.push("--theme", s.theme)
  const p = Bun.spawn(args, { cwd: ROOT, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" })
  await p.exited
  if (p.exitCode !== 0) throw new Error(`snapshot ${s.name} failed:\n${await new Response(p.stderr).text()}`)
  const raw = JSON.parse(readFileSync(json, "utf8")) as { cols: number; rows: number; lines: { t: string; fg: string | null; bg: string | null; a: number }[][] }
  return raw
}

// ---------- svg → png ----------
const FONT_FILES = ["Regular", "Bold", "Italic", "BoldItalic"].map((v) => `/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-${v}.ttf`)

function toPng(svg: string, png: string, zoom = SCALE) {
  const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" })
  const tries: string[][] = [
    ["resvg", "--zoom", String(zoom), ...FONT_FILES.flatMap((f) => ["--use-font-file", f]), "--font-family", FAMILY, svg, png],
    ["rsvg-convert", "-z", String(zoom), "-o", png, svg],
    ["magick", "-density", String(96 * zoom), "-background", "none", svg, png],
  ]
  for (const t of tries) {
    if (!Bun.which(t[0]!)) continue
    const r = run(t)
    if (r.exitCode === 0) return t[0]!
  }
  throw new Error(`no SVG→PNG converter worked (tried resvg, rsvg-convert, magick) for ${svg}`)
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
    <text x="64" y="${150 + 3 * 50 + 122}" font-size="18" fill="${mute}">26 themes</text>
  </g>
  <g transform="translate(${wx} ${wy}) scale(${sc})">${hero.body}</g>`)
}

// ---------- main ----------
const want = process.argv.slice(2)
const shots = SHOTS.filter((s) => !want.length || want.includes(s.name) || (want.includes("social") && s.name === "screenshot"))
mkdirSync(DOCS, { recursive: true })
const { dir, home } = sandbox()
let used = ""
try {
  let hero: Win | null = null
  for (const s of shots) {
    const frame = await capture(s, home, dir)
    const win = window(frame, s.title, s.name)
    if (s.name === "screenshot") hero = win
    const out = svgDoc(win.w + 2 * MARGIN, win.h + 2 * MARGIN, `<g transform="translate(${MARGIN} ${MARGIN})">${win.body}</g>`)
    const svg = join(DOCS, `${s.name}.svg`)
    writeFileSync(svg, out)
    used = toPng(svg, join(DOCS, `${s.name}.png`))
    console.log(`docs/${s.name}.{svg,png}`)
  }
  if (hero && (!want.length || want.includes("social"))) {
    const svg = join(DOCS, "social.svg")
    writeFileSync(svg, social(hero))
    toPng(svg, join(DOCS, "social.png"), 1)
    console.log("docs/social.{svg,png}")
  }
  console.log(`png via ${used}, font ${FAMILY}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
