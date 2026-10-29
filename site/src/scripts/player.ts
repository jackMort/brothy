// The demo player: a small canvas terminal that plays the recorded tour (site/public/casts/tour-{dark,light}.cast,
// asciicast v2 from the recording tool in brothy-studio), replayed into the screen model of ./ansi.ts (exactly the sequences the casts
// use; tests/site/casts.test.ts keeps it that way). Box-drawing and block glyphs are drawn as rectangles, never from a font, so the cells line up in every
// browser. Cells in the theme's own background stay clear: the frosted window behind the canvas shows through.

import { BLOCK, BOX, Screen } from "./ansi"

interface Cast { cols: number; rows: number; ev: { t: number; d: string }[]; dur: number }
type Mode = "dark" | "light"

/** brothy / brothy-light background and text, as the cast's SGR writes them */
const BG: Record<Mode, string> = { dark: "23,22,21", light: "246,244,240" }
const FG: Record<Mode, string> = { dark: "231,226,218", light: "36,32,28" }
const mode = (): Mode => (document.documentElement.dataset.theme === "light" ? "light" : "dark")

async function load(url: string): Promise<Cast> {
  const text = await (await fetch(url)).text()
  const [head, ...lines] = text.trim().split("\n")
  const h = JSON.parse(head!) as { width: number; height: number; idle_time_limit?: number }
  const limit = h.idle_time_limit ?? 2
  let prev = 0, shift = 0
  const ev = lines.map((l) => {
    const [t, , d] = JSON.parse(l) as [number, string, string]
    shift += Math.max(0, t - prev - limit) // idle gaps are cut to the cast's limit, as asciinema does
    prev = t
    return { t: t - shift, d }
  })
  return { cols: h.width, rows: h.height, ev, dur: ev.at(-1)!.t + 1 }
}

const clock = (v: number) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`

/** Mount on a `[data-cast]` element holding a canvas, `[data-play]`, `[data-bar]` and `[data-time]`. */
export async function mountCast(el: HTMLElement) {
  const canvas = el.querySelector("canvas")!, ctx = canvas.getContext("2d")!
  const btn = el.querySelector<HTMLElement>("[data-play]"), time = el.querySelector<HTMLElement>("[data-time]"), bar = el.querySelector<HTMLElement>("[data-bar]")
  const font = getComputedStyle(el).getPropertyValue("--cast-font").trim() || "monospace"
  const casts: Record<Mode, Cast> = await Promise.all([load(el.dataset.dark!), load(el.dataset.light!)]).then(([dark, light]) => ({ dark, light }))
  // the faces, and the symbol subset the casts take from the fallback (↻ ⏎ ␣ …), before the first paint
  const sample = "Aa ↪↻⌫⏎␣◡◦★▸▾●"
  try { await Promise.all([document.fonts.load(`16px ${font}`, sample), document.fonts.load(`600 16px ${font}`, sample), document.fonts.load(`italic 16px ${font}`)]) } catch {}
  let m = mode(), c = casts[m], s = new Screen(c.cols, c.rows), applied = 0, t = 0, playing = false, last = 0
  let cw = 8, rh = 16, fs = 13
  /** the screen changed since it was last painted */
  let dirty = true

  function seek(to: number) {
    if (to < t || applied === 0) { s = new Screen(c.cols, c.rows); applied = 0; dirty = true }
    t = Math.max(0, Math.min(c.dur, to))
    while (applied < c.ev.length && c.ev[applied]!.t <= t) { s.write(c.ev[applied++]!.d); dirty = true }
  }
  function size() {
    const W = canvas.parentElement!.clientWidth, dpr = Math.min(2, devicePixelRatio || 1)
    cw = W / c.cols; fs = cw / 0.6; rh = Math.round(fs * 1.28 * 100) / 100
    canvas.style.height = `${rh * c.rows}px`
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(rh * c.rows * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    dirty = true
    draw()
  }
  /** the canvas, only when the screen changed: the casts change it a few times a second at most */
  function paint() {
    if (!dirty) return
    dirty = false
    ctx.clearRect(0, 0, c.cols * cw, c.rows * rh)
    const lw = Math.max(1, Math.round(fs * 0.075))
    for (let y = 0; y < c.rows; y++)
      for (let x = 0; x < c.cols; x++) {
        const bg = s.bg[y * c.cols + x]
        if (bg && bg !== BG[m]) { ctx.fillStyle = `rgb(${bg})`; ctx.fillRect(Math.floor(x * cw), y * rh, Math.ceil(cw) + 1, Math.ceil(rh)) }
      }
    ctx.textBaseline = "middle"
    for (let y = 0; y < c.rows; y++)
      for (let x = 0; x < c.cols; x++) {
        const i = y * c.cols + x, ch = s.ch[i]!
        if (ch === " ") continue
        const X = x * cw, Y = y * rh, a = s.at[i]!
        ctx.fillStyle = `rgb(${s.fg[i] ?? FG[m]})`
        const box = BOX[ch], blk = BLOCK[ch]
        if (box === "dash") {
          const cy = Math.round(Y + rh / 2) - lw / 2, seg = cw / 4
          for (let k = 0; k < 4; k++) ctx.fillRect(X + k * seg + seg * 0.15, cy, seg * 0.6, lw)
        } else if (box) {
          const w = box === "LR" ? lw * 2 : lw, cx = X + cw / 2, cy = Math.round(Y + rh / 2) - w / 2, arms = box.toLowerCase()
          if (arms.includes("l")) ctx.fillRect(X, cy, cw / 2 + w / 2, w)
          if (arms.includes("r")) ctx.fillRect(cx - w / 2, cy, cw / 2 + w / 2 + 0.5, w)
          if (arms.includes("u")) ctx.fillRect(Math.round(cx - w / 2), Y, w, rh / 2 + w / 2)
          if (arms.includes("d")) ctx.fillRect(Math.round(cx - w / 2), cy, w, rh / 2 + w / 2 + 0.5)
        } else if (blk) ctx.fillRect(X + blk[0] * cw, Y, (blk[1] - blk[0]) * cw, rh)
        else {
          ctx.font = `${a & 2 ? "italic " : ""}${a & 1 ? "600 " : ""}${fs}px ${font}`
          ctx.fillText(ch, X, Y + rh / 2)
          if (a & 4) ctx.fillRect(X, Y + rh * 0.86, cw + 0.5, lw)
          if (a & 8) ctx.fillRect(X, Y + rh / 2, cw + 0.5, lw)
        }
      }
  }
  function draw() {
    paint()
    if (time) time.textContent = `${clock(t)} / ${clock(c.dur)}`
    bar?.style.setProperty("--p", `${(t / c.dur) * 100}%`)
    if (btn) btn.textContent = playing ? "pause" : t >= c.dur ? "replay" : "play"
    el.classList.toggle("is-playing", playing)
  }
  function tick() {
    if (!playing) return
    const now = performance.now() // the wall clock: rAF's frame timestamps can run ahead of it
    // a long gap (a background tab) counts as a quarter second, so the tour resumes where it was
    seek(t + Math.min(0.25, Math.max(0, now - last) / 1000))
    last = now
    if (t >= c.dur) playing = false
    draw()
    if (playing) requestAnimationFrame(tick)
  }
  const toggle = () => {
    if (t >= c.dur) seek(0)
    playing = !playing
    last = performance.now()
    draw()
    if (playing) requestAnimationFrame(tick)
  }
  el.addEventListener("click", (e) => {
    const target = e.target as HTMLElement
    if (target.closest("canvas, [data-play]")) toggle()
  })
  el.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle() }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); seek(t + (e.key === "ArrowRight" ? 5 : -5)); draw() }
  })
  bar?.addEventListener("click", (e) => {
    const r = bar.getBoundingClientRect()
    seek(((e.clientX - r.left) / r.width) * c.dur)
    draw()
  })
  // follow the site's theme, keeping the position
  new MutationObserver(() => {
    if (mode() === m) return
    m = mode(); c = casts[m]; dirty = true
    const at = t
    applied = 0; t = 0
    seek(at); draw()
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
  new ResizeObserver(size).observe(canvas.parentElement!)
  seek(+(el.dataset.poster ?? 5))
  size()
  el.classList.add("is-ready")
  ;(el as HTMLElement & { toggle?: () => void }).toggle = toggle
}
