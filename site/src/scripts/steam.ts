// The welcome bowl's steam: the braille frames scripts/site-art.ts took from steamRows, drawn as small squares in the
// bowl's SVG. With reduced motion (or off screen) it holds the still frame the app draws with motion off.

interface Steam {
  x: number
  y: number
  still: number
  frames: string[][]
}

export function mountSteam(g: SVGGElement, steam: Steam, cell: { w: number; h: number }, ms = 240) {
  const dx = cell.w / 2,
    dy = cell.h / 4,
    r = Math.min(dx, dy) * 0.55
  const rows = steam.frames[0]!.length
  const draw = (k: number) => {
    let out = ""
    steam.frames[k]!.forEach((row, cy) =>
      [...row].forEach((ch, cx) => {
        const b = ch.charCodeAt(0) - 0x2800
        if (b <= 0) return // braille dot bits by [row][column] inside a cell
        ;[
          [0x01, 0x08],
          [0x02, 0x10],
          [0x04, 0x20],
          [0x40, 0x80],
        ].forEach((bits, py) =>
          bits.forEach((bit, px) => {
            if (!(b & bit)) return
            const x = steam.x + cx * cell.w + px * dx + (dx - r) / 2,
              y = steam.y + cy * cell.h + py * dy + (dy - r) / 2
            out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${r.toFixed(1)}" height="${r.toFixed(1)}" opacity="${(0.35 + (0.65 * (cy + 1)) / rows).toFixed(2)}"/>`
          }),
        )
      }),
    )
    g.innerHTML = out
  }
  let k = steam.still
  draw(k)
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
  let timer = 0
  new IntersectionObserver(([e]) => {
    clearInterval(timer)
    if (e?.isIntersecting) timer = window.setInterval(() => draw((k = (k + 1) % steam.frames.length)), ms)
  }).observe(g.ownerSVGElement!)
}
