// Shared by scripts/screenshots.ts and scripts/demo.ts: the sandbox (fake $HOME, demo folders, recent projects), a captured
// frame drawn as an SVG terminal window on an exact monospace grid, and SVG → PNG.
// Font: JetBrainsMono Nerd Font Mono (the logo U+F0617 is a Nerd Font glyph). The SVGs only *reference* the family, so they
// render with fallback glyphs where it is not installed; the PNGs are made here, where it is.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Frame } from "./session"

export const ROOT = resolve(import.meta.dir, "..")
export const DOCS = join(ROOT, "docs")
export const FAMILY = "JetBrainsMono Nerd Font Mono"
export const STACK = `'${FAMILY}', 'JetBrains Mono', 'DejaVu Sans Mono', monospace`
export const FS = 16, CW = FS * 0.6, CH = 21 // font size, cell width (JetBrains Mono advance is 0.6 em), cell height
export const BAR = 38, PAD = 14, MARGIN = 36, RADIUS = 12

// ---------- colors ----------
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const hex = (c: number[]) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")
export const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i]! - v) * t)) }
export const luma = (h: string) => { const [r, g, b] = rgb(h) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b }
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function mostCommon(xs: (string | null)[]): string | null {
  const n = new Map<string, number>()
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

// ---------- frame → SVG ----------
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Block elements as quadrant bits (1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right): drawn as rects, since a font's block glyphs show seams between cells. */
const BLOCKS: Record<string, number> = { "▘": 1, "▝": 2, "▀": 3, "▖": 4, "▌": 5, "▞": 6, "▛": 7, "▗": 8, "▚": 9, "▐": 10, "▜": 11, "▄": 12, "▙": 13, "▟": 14, "█": 15 }
/** how far a block rect reaches into its neighbours, in px: no hairline between touching cells */
const HAIR = 0.4

/** The rects of block glyph `ch` in a `w`×`h` cell at (x, y), as SVG `<rect>`s; "" for anything else. */
export function blockRects(ch: string, x: number, y: number, w: number, h: number, fill: string): string {
  const bits = BLOCKS[ch]
  if (!bits) return ""
  const hw = w / 2, hh = h / 2
  return ([[0, 0, 1], [1, 0, 2], [0, 1, 4], [1, 1, 8]] as const)
    .filter(([, , b]) => bits & b)
    .map(([dx, dy]) => `<rect x="${+(x + dx * hw - (dx ? HAIR : HAIR)).toFixed(2)}" y="${+(y + dy * hh - HAIR).toFixed(2)}" width="${+(hw + 2 * HAIR).toFixed(2)}" height="${+(hh + 2 * HAIR).toFixed(2)}" fill="${fill}"/>`)
    .join("")
}

/** The cells: background runs (cells whose bg is `bg` or transparent draw none), text, underline / strikethrough. */
function grid(f: Frame, bg: string, fg: string): string {
  const rects: string[] = []
  const texts: string[] = []
  const lines: string[] = []
  const blocks: string[] = []
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
        if (BLOCKS[g]) blocks.push(blockRects(g, c * CW, y, CW, CH, color))
        else if (g.trim() !== "" && gw > 0) {
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
  return `<g shape-rendering="crispEdges">${rects.join("")}${lines.join("")}</g><g>${blocks.join("")}</g><g text-rendering="geometricPrecision">${texts.join("")}</g>`
}

/**
 * Just the cells, on a transparent canvas (`PAD` around): the video compositor (scripts/stage.html) draws the frosted window and
 * its title bar in HTML, so only the text and the painted fills (code, popups) are in the image. `bg` is the theme's background:
 * cells with it draw nothing, and dim text mixes toward it.
 */
export function bare(f: Frame, bg: string, fg: string): { w: number; h: number; body: string } {
  const w = f.cols * CW + 2 * PAD, h = f.rows * CH + 2 * PAD
  return { w, h, body: `<g transform="translate(${PAD} ${PAD})" font-family="${STACK}" font-size="${FS}" xml:space="preserve">${grid(f, bg, fg)}</g>` }
}

export interface Win { w: number; h: number; body: string; bg: string; fg: string; accent: string }

/** The frame's background and text colors (most common), and the accent (the logo's color). */
export function palette(f: Frame) {
  const bg = mostCommon(f.lines.flat().map((c) => c.bg)) ?? "#000000"
  const fg = mostCommon(f.lines.flat().filter((c) => c.t.trim()).map((c) => c.fg)) ?? "#ffffff"
  const logo = f.lines.flat().find((c) => c.t.includes("\u{F0617}"))
  return { bg, fg, accent: logo?.fg ?? fg }
}

/**
 * The frame as a terminal window (title bar with traffic lights). `bg`/`fg` override the detected colors; `wallpaper` is SVG
 * drawn behind the cells instead of the plain background (a transparent terminal over a desktop). `shadow: false` leaves out the
 * drop shadow (the window is exactly `w`×`h`; scripts/demo.ts draws its own).
 */
export function window(f: Frame, title: string, id: string, o: { bg?: string; fg?: string; wallpaper?: (w: number, h: number) => string; shadow?: boolean } = {}): Win {
  const p = palette(f)
  const bg = o.bg ?? p.bg, fg = o.fg ?? p.fg, accent = p.accent
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
  ${o.shadow === false ? "" : `<rect x="0" y="22" width="${w}" height="${h}" rx="${RADIUS}" fill="#000" opacity="${dark ? 0.55 : 0.28}" filter="url(#s-${id})"/>`}
  <g clip-path="url(#c-${id})">
    ${o.wallpaper ? o.wallpaper(w, h) : `<rect width="${w}" height="${h}" fill="${bg}"/>`}
    <rect width="${w}" height="${BAR}" fill="${chrome}"/>
    <rect y="${BAR - 1}" width="${w}" height="1" fill="${edge}"/>
    ${dots}
    <text x="${w / 2}" y="${BAR / 2 + 4.5}" text-anchor="middle" font-size="13" fill="${mix(fg, bg, 0.45)}" font-family="${STACK}">${esc(title)}</text>
    <g transform="translate(${PAD} ${BAR + PAD})" font-family="${STACK}" font-size="${FS}" xml:space="preserve">${grid(f, bg, fg)}</g>
  </g>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${RADIUS}" fill="none" stroke="${edge}"/>`
  return { w, h, body, bg, fg, accent }
}

export const svgDoc = (w: number, h: number, inner: string, bg = "none") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg === "none" ? "" : `<rect width="${w}" height="${h}" fill="${bg}"/>`}${inner}</svg>\n`

// ---------- sandbox ----------
/** A temp dir holding a fake $HOME: ~/examples (a copy), a few demo folders and three recent projects for the `o` picker. */
export function sandbox() {
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

// ---------- svg → png ----------
const FONT_FILES = ["Regular", "Bold", "Italic", "BoldItalic"].map((v) => `/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-${v}.ttf`)

export const NO_RESVG = "resvg not found: install it (official release: https://github.com/linebender/resvg/releases, or your package manager: `pacman -S resvg`, `brew install resvg`, `cargo install resvg`). rsvg-convert and ImageMagick render the cell grid wrong (merged words, ligatures), so they are not used."

/** The converter command (resvg gets the font files directly); throws `NO_RESVG` when it is not installed. */
export function pngCommand(svg: string, png: string, zoom: number): string[] {
  if (!Bun.which("resvg")) throw new Error(NO_RESVG)
  return ["resvg", "--zoom", String(zoom), ...FONT_FILES.flatMap((f) => ["--use-font-file", f]), "--font-family", FAMILY, svg, png]
}

export function toPng(svg: string, png: string, zoom = 2) {
  const p = Bun.spawnSync(pngCommand(svg, png, zoom), { stdout: "ignore", stderr: "pipe" })
  if (p.exitCode !== 0) throw new Error(`resvg failed on ${svg}:\n${p.stderr}`)
}
