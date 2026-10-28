// Headless <App> session shared by scripts/snapshot.tsx (one frame) and scripts/demo.ts (a recorded walkthrough).
import { testRender } from "@opentui/react/test-utils"
import { App } from "../src/App"

export interface Cell { t: string; fg: string | null; bg: string | null; a: number }
/** A captured frame: colored spans per row (null colors are transparent). */
export interface Frame { cols: number; rows: number; lines: Cell[][] }

export type Session = Awaited<ReturnType<typeof testRender>>

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function mount(o: { root: string; initialFile?: string; theme?: string; transparent?: boolean; stdin?: string; motion?: boolean; fetch?: typeof fetch; width: number; height: number }): Promise<Session> {
  const s = await testRender(<App root={o.root} initialFile={o.initialFile} themeName={o.theme} transparent={o.transparent} stdin={o.stdin} motion={o.motion ?? false} fetch={o.fetch} />, { width: o.width, height: o.height })
  await s.renderOnce()
  return s
}

/**
 * One key: `tab`, `enter`, `esc`, `up`/`down`/`left`/`right`, `space`, `type:<text>` (`\s` is a space), `C-<key>` (ctrl) or any single key
 * (`wait:<ms>` sleeps). Does not render.
 */
export async function press(s: Session, k: string) {
  if (k === "tab") s.mockInput.pressTab()
  else if (k === "enter") s.mockInput.pressEnter()
  else if (k === "esc") s.mockInput.pressEscape()
  else if (["down", "up", "left", "right"].includes(k)) s.mockInput.pressArrow(k as "down" | "up" | "left" | "right")
  else if (k === "space") s.mockInput.pressKey(" ")
  else if (k.startsWith("wait:")) await sleep(Number(k.slice(5))) // e.g. let code highlighting land
  else if (k.startsWith("type:")) await s.mockInput.typeText(k.slice(5).replaceAll("\\s", " ")) // `\s` types a space (keys are space-separated)
  else if (k.startsWith("C-")) s.mockInput.pressKey(k.slice(2), { ctrl: true })
  else s.mockInput.pressKey(k)
}

/** Text plus colors: equal keys mean an identical picture. */
export const frameKey = (s: Session) => s.captureCharFrame() + JSON.stringify(s.captureSpans().lines.map((l) => l.spans.map((x) => [x.fg, x.bg, x.attributes])))

/**
 * Render until the frame has not changed for `quiet` ms (at most 5 s): code blocks fill in asynchronously, parsers answer in
 * ~100 ms but the worker's first start takes longer on a busy machine (a shorter wait captured shots without highlighting).
 */
export async function settle(s: Session, quiet = 600) {
  await sleep(50)
  await s.renderOnce()
  await s.renderOnce()
  let prev = frameKey(s), since = performance.now()
  for (const end = since + 5000; performance.now() < end && performance.now() - since < quiet;) {
    await sleep(50)
    await s.renderOnce()
    const cur = frameKey(s)
    if (cur !== prev) { prev = cur; since = performance.now() }
  }
}

export function frame(s: Session): Frame {
  const f = s.captureSpans()
  const toHex = (c: { r: number; g: number; b: number; a: number }) =>
    c.a === 0 ? null : "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")
  return { cols: f.cols, rows: f.rows, lines: f.lines.map((l) => l.spans.map((x) => ({ t: x.text, fg: toHex(x.fg), bg: toHex(x.bg), a: x.attributes }))) }
}
