// The demo player: a small canvas terminal that plays the recorded tour (site/public/casts/tour-{dark,light}.cast,
// asciicast v2 from scripts/cast.ts). The casts use only cursor moves, clear, and SGR with truecolor, so this handles
// exactly those. Box-drawing and block glyphs are drawn as rectangles, never from a font, so the cells line up in every
// browser. Cells in the theme's own background stay clear: the frosted window behind the canvas shows through.

interface Cast { cols: number; rows: number; ev: { t: number; d: string }[]; dur: number }
type Mode = "dark" | "light"

/** brothy / brothy-light background and text, as the cast's SGR writes them */
const BG: Record<Mode, string> = { dark: "24,23,20", light: "251,247,239" }
const FG: Record<Mode, string> = { dark: "243,239,231", light: "42,38,33" }
/** box-drawing arms: l r u d, upper case for heavy */
const BOX: Record<string, string> = { "─": "lr", "│": "ud", "┌": "dr", "┐": "dl", "└": "ur", "┘": "ul", "├": "udr", "┤": "udl", "┬": "dlr", "┴": "ulr", "┼": "udlr", "━": "LR" }
/** block elements as [left, right] fractions of the cell */
const BLOCK: Record<string, [number, number]> = { "▌": [0, 0.5], "▐": [0.5, 1], "▎": [0, 0.25], "▏": [0, 0.125], "▕": [0.875, 1], "█": [0, 1] }

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

class Screen {
  ch: string[]; fg: (string | null)[]; bg: (string | null)[]; at: Uint8Array
  x = 0; y = 0
  cur = { fg: null as string | null, bg: null as string | null, at: 0 }
  constructor(readonly cols: number, readonly rows: number) {
    const n = cols * rows
    this.ch = new Array(n).fill(" "); this.fg = new Array(n).fill(null); this.bg = new Array(n).fill(null); this.at = new Uint8Array(n)
  }
  clear() { this.ch.fill(" "); this.fg.fill(null); this.bg.fill(null); this.at.fill(0) }
  write(d: string) {
    const re = /\x1b\[([?0-9;]*)([A-Za-z])|([^\x1b])/gsu
    for (let m; (m = re.exec(d)); ) {
      const c = m[3]
      if (c !== undefined) {
        if (c === "\n") { this.y++; continue }
        if (c === "\r") { this.x = 0; continue }
        if (this.x < this.cols && this.y < this.rows) {
          const i = this.y * this.cols + this.x
          this.ch[i] = c; this.fg[i] = this.cur.fg; this.bg[i] = this.cur.bg; this.at[i] = this.cur.at
        }
        this.x++
        continue
      }
      const p = m[1]!.split(";").map(Number), f = m[2]
      if (f === "H") { this.y = (p[0] || 1) - 1; this.x = (p[1] || 1) - 1 }
      else if (f === "J" && p[0] === 2) this.clear()
      else if (f === "m")
        for (let k = 0; k < p.length; k++) {
          const v = p[k] || 0
          if (v === 0) this.cur = { fg: null, bg: null, at: 0 }
          else if (v === 1) this.cur.at |= 1
          else if (v === 3) this.cur.at |= 2
          else if (v === 4) this.cur.at |= 4
          else if (v === 9) this.cur.at |= 8
          else if ((v === 38 || v === 48) && p[k + 1] === 2) {
            const rgb = `${p[k + 2]},${p[k + 3]},${p[k + 4]}`
            if (v === 38) this.cur.fg = rgb
            else this.cur.bg = rgb
            k += 4
          }
        }
    }
  }
}

const clock = (v: number) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`

/** Mount on a `[data-cast]` element holding a canvas, `[data-play]`, `[data-bar]` and `[data-time]`. */
export async function mountCast(el: HTMLElement) {
  const canvas = el.querySelector("canvas")!, ctx = canvas.getContext("2d")!
  const btn = el.querySelector<HTMLElement>("[data-play]"), time = el.querySelector<HTMLElement>("[data-time]"), bar = el.querySelector<HTMLElement>("[data-bar]")
  const font = getComputedStyle(el).getPropertyValue("--cast-font").trim() || "monospace"
  const casts: Record<Mode, Cast> = await Promise.all([load(el.dataset.dark!), load(el.dataset.light!)]).then(([dark, light]) => ({ dark, light }))
  try { await Promise.all([document.fonts.load(`16px ${font}`), document.fonts.load(`600 16px ${font}`), document.fonts.load(`italic 16px ${font}`)]) } catch {}
  let m = mode(), c = casts[m], s = new Screen(c.cols, c.rows), applied = 0, t = 0, playing = false, last = 0
  let cw = 8, rh = 16, fs = 13

  function seek(to: number) {
    if (to < t || applied === 0) { s = new Screen(c.cols, c.rows); applied = 0 }
    t = Math.max(0, Math.min(c.dur, to))
    while (applied < c.ev.length && c.ev[applied]!.t <= t) s.write(c.ev[applied++]!.d)
  }
  function size() {
    const W = canvas.parentElement!.clientWidth, dpr = Math.min(2, devicePixelRatio || 1)
    cw = W / c.cols; fs = cw / 0.6; rh = Math.round(fs * 1.28 * 100) / 100
    canvas.style.height = `${rh * c.rows}px`
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(rh * c.rows * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw()
  }
  function draw() {
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
        if (box) {
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
    if (time) time.textContent = `${clock(t)} / ${clock(c.dur)}`
    bar?.style.setProperty("--p", `${(t / c.dur) * 100}%`)
    if (btn) btn.textContent = playing ? "pause" : t >= c.dur ? "replay" : "play"
    el.classList.toggle("is-playing", playing)
  }
  function tick(now: number) {
    if (!playing) return
    seek(t + Math.min(0.1, (now - last) / 1000))
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
    m = mode(); c = casts[m]
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
