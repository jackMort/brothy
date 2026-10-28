// The cinematic layer of scripts/demo.ts, pure: easing, the virtual camera, the 3D intro/outro poses, keycap captions,
// theme sweeps and the accent glow, turned into one `Shot` per output frame that scripts/stage.html draws.
// Units: seconds; window points are in the window's own pixels (scripts/pipeline.ts `window()` at zoom 1).

// ---------- easing ----------
export const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const inOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
export const inOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
export const outQuart = (t: number) => 1 - (1 - t) ** 4
export const outCubic = (t: number) => 1 - (1 - t) ** 3
export const inCubic = (t: number) => t * t * t
export const outBack = (t: number) => { const c = 1.6; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2 }
/** `x` between `a` and `b` as eased 0..1. */
export const span = (x: number, a: number, b: number, e: (t: number) => number = inOutCubic) => e(clamp01((x - a) / (b - a)))

// ---------- colors ----------
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
export const mixHex = (a: string, b: string, t: number) => {
  const x = rgb(a), y = rgb(b)
  return "#" + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")
}

// ---------- camera ----------
export interface Rect { x: number; y: number; w: number; h: number }
/** Window point (fx, fy) lands on screen point (ax, ay), at `z` times the fitted scale. */
export interface Cam { z: number; fx: number; fy: number; ax: number; ay: number }

export const lerpCam = (a: Cam, b: Cam, t: number): Cam => ({
  z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), t)), // zoom feels even in log space
  fx: lerp(a.fx, b.fx, t), fy: lerp(a.fy, b.fy, t), ax: lerp(a.ax, b.ax, t), ay: lerp(a.ay, b.ay, t),
})

export interface Layout {
  /** output canvas (CSS px) */
  W: number; H: number
  /** the window's natural size */
  ww: number; wh: number
  /** fitted scale (zoom 1) and the window's centre on screen at zoom 1 */
  fit: number; home: { x: number; y: number }
  /** the most the camera zooms in */
  zmax: number
}

export const homeCam = (L: Layout): Cam => ({ z: 1, fx: L.ww / 2, fy: L.wh / 2, ax: L.home.x, ay: L.home.y })

/** The camera framing `r` (window px): fit it in 80% × 66% of the canvas, centred, never showing past the window's edges. */
export function frameRect(L: Layout, r: Rect, zoom?: number): Cam {
  const z = Math.max(1, Math.min(zoom ?? L.zmax, L.zmax, (L.W * 0.8) / (r.w * L.fit), (L.H * 0.66) / (r.h * L.fit)))
  const s = L.fit * z, ax = L.W / 2, ay = L.H * 0.47
  const half = (v: number, a: number, size: number, c: number, m: number) => {
    // keep the viewport [c - a/s, c + (v - a)/s] inside [-m, size + m] when it fits
    const lo = a / s - m, hi = size + m - (v - a) / s
    return lo > hi ? size / 2 : Math.max(lo, Math.min(hi, c))
  }
  return { z, fx: half(L.W, ax, L.ww, r.x + r.w / 2, 18), fy: half(L.H, ay, L.wh, r.y + r.h / 2, 18), ax, ay }
}

/** Screen rect of window rect `r` under camera `c` (flat window). */
export function onScreen(L: Layout, c: Cam, r: Rect): Rect {
  const s = L.fit * c.z
  return { x: c.ax + (r.x - c.fx) * s, y: c.ay + (r.y - c.fy) * s, w: r.w * s, h: r.h * s }
}

export interface Move { t: number; d: number; to: Cam }
/** Eased camera moves; each starts from wherever the camera is at its start (a move cut short hands over smoothly in position). */
export function camTrack(start: Cam, moves: Move[]) {
  const ms = [...moves].sort((a, b) => a.t - b.t)
  const from: Cam[] = []
  ms.forEach((m, i) => { from.push(i === 0 ? start : lerpCam(from[i - 1]!, ms[i - 1]!.to, inOutCubic(clamp01((m.t - ms[i - 1]!.t) / ms[i - 1]!.d)))) })
  return (t: number): Cam => {
    let j = -1
    for (let i = 0; i < ms.length && ms[i]!.t <= t; i++) j = i
    if (j < 0) return start
    return lerpCam(from[j]!, ms[j]!.to, inOutCubic(clamp01((t - ms[j]!.t) / ms[j]!.d)))
  }
}

// ---------- 3D pose ----------
/** Rotation / depth applied about the window centre on top of the camera; `o` is opacity. */
export interface Pose { rx: number; ry: number; rz: number; tz: number; ty: number; o: number }
export const FLAT: Pose = { rx: 0, ry: 0, rz: 0, tz: 0, ty: 0, o: 1 }
export const INTRO_FROM: Pose = { rx: 56, ry: 0, rz: -32, tz: -1500, ty: 260, o: 0 }
export const OUTRO_TO: Pose = { rx: 24, ry: -38, rz: 6, tz: -1700, ty: -40, o: 0 }
export const lerpPose = (a: Pose, b: Pose, t: number, to = t): Pose => ({
  rx: lerp(a.rx, b.rx, t), ry: lerp(a.ry, b.ry, t), rz: lerp(a.rz, b.rz, t), tz: lerp(a.tz, b.tz, t), ty: lerp(a.ty, b.ty, t), o: lerp(a.o, b.o, to),
})
/** How tilted a pose is, 0 (flat) .. 1. */
export const tilt = (p: Pose) => clamp01((Math.abs(p.rx) + Math.abs(p.ry) + Math.abs(p.rz) * 0.5) / 40)

/** The CSS transform of the window element (transform-origin 0 0, natural size). */
export function transform(L: Layout, c: Cam, p: Pose): string {
  const s = L.fit * c.z
  const cx = (L.ww / 2 - c.fx) * s, cy = (L.wh / 2 - c.fy) * s // window centre relative to the anchor
  const n = (x: number) => +x.toFixed(4)
  return `translate3d(${n(c.ax + cx)}px, ${n(c.ay + cy + p.ty)}px, ${n(p.tz)}px) rotateX(${n(p.rx)}deg) rotateY(${n(p.ry)}deg) rotateZ(${n(p.rz)}deg) ` +
    `scale(${n(s)}) translate(${n(-L.ww / 2)}px, ${n(-L.wh / 2)}px)`
}

// ---------- keycaps ----------
/** How far a key is down `dt` seconds after it was pressed: quick press, a short hold, softer release. */
export const pressDepth = (dt: number) => (dt < 0 ? 0 : dt < 0.05 ? dt / 0.05 : dt < 0.13 ? 1 : Math.max(0, 1 - (dt - 0.13) / 0.16))

/** The caps a storyboard key presses (`C-p` presses both `ctrl` and `p`, `down` the `↓` cap). */
export function capsOf(key: string): string[] {
  if (key === "enter") return ["⏎"]
  if (key === "space") return ["space"]
  const arrow = ({ up: "↑", down: "↓", left: "←", right: "→" } as Record<string, string>)[key]
  if (arrow) return [arrow]
  if (key.startsWith("C-")) return ["ctrl", key.slice(2)]
  return [key]
}

// ---------- frames shown in the window ----------
/** One app frame as the window shows it: its image, when it appears, how (sweep = theme change) and the theme accent. */
export interface Still { src: string; t: number; sweep: boolean; accent: string }
export const SWEEP = 0.6

/**
 * The images stacked in the window at time `t` (bottom first), each with its sweep progress (1 = fully shown). A sweep belongs
 * to the run of frames that starts with it, so later frames of that run (a fading hint, a moving cursor) keep sweeping in.
 */
export function layersAt(stills: Still[], t: number, max = 6): { src: string; p: number; accent: string }[] {
  let k = 0
  for (let i = 0; i < stills.length && stills[i]!.t <= t; i++) k = i
  const out: { src: string; p: number; accent: string }[] = []
  for (let j = k; j >= 0 && out.length < max;) {
    let g = j // first frame of j's run
    while (g > 0 && !stills[g]!.sweep) g--
    const p = stills[g]!.sweep && g > 0 ? inOutSine(clamp01((t - stills[g]!.t) / SWEEP)) : 1
    out.unshift({ src: stills[j]!.src, p, accent: stills[j]!.accent })
    if (p >= 1) break
    j = g - 1
  }
  out[0]!.p = 1
  return out
}
