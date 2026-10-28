import { expect } from "bun:test"

const time = (f: () => unknown) => {
  const s = performance.now()
  f()
  return performance.now() - s
}

/** Linear work grows ~8× from 1/8 size, quadratic ~64×; see "pathological inline input stays fast" (markdown-fixes). */
export const SCALE = 8
const MAX_RATIO = 30

/**
 * `f` on the full-size input and on the 1/8-size one, alternately (best of 3), so a busy machine
 * slows both; fails when the ratio looks quadratic. A full-size run under 20 ms passes whatever its ratio.
 */
export function expectLinear(label: string, f: (big: boolean) => unknown) {
  f(false) // warm up
  let a = Infinity
  let b = Infinity
  for (let i = 0; i < 3; i++) {
    a = Math.min(a, time(() => f(false)))
    b = Math.min(b, time(() => f(true)))
  }
  if (b > 20) expect(b / Math.max(a, 1), `${label}: ${b.toFixed(0)} ms vs ${a.toFixed(1)} ms at 1/${SCALE}`).toBeLessThan(MAX_RATIO)
}

/** A note with `n` headings at depths 1–3, each with one line of text. */
export function manyHeadings(n: number, prefix = "Heading") {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(`${"#".repeat(1 + (i % 3))} ${prefix} ${i}\nbody ${i}\n`)
  return out.join("\n")
}
