// Render the app headlessly and print the frame. Usage:
//   bun scripts/snapshot.tsx [path] [--size 120x36] [--keys "j j tab 3"] [--json out.json] [--theme name] [--transparent] [--config dir]
// Config (theme, folds) lives in a throwaway temp dir unless --config <dir> points at a real XDG_CONFIG_HOME.
import { testRender } from "@opentui/react/test-utils"
import { resolve, dirname } from "node:path"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { App } from "../src/App"
import { shutdownHighlighter } from "../src/highlight"

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const [w, h] = (opt("--size") ?? "120x36").split("x").map(Number)
const keys = (opt("--keys") ?? "").split(" ").filter(Boolean)
const json = opt("--json")
const theme = opt("--theme")
const transparent = args.includes("--transparent") ? (args.splice(args.indexOf("--transparent"), 1), true) : undefined
const configDir = opt("--config")
const tempConfig = configDir ? undefined : mkdtempSync(join(tmpdir(), "brothy-snap-"))
process.env.XDG_CONFIG_HOME = configDir ? resolve(configDir) : tempConfig // read lazily by src/config.ts
const abs = resolve(args[0] ?? "examples")
const isFile = statSync(abs).isFile()

const setup = await testRender(
  <App root={isFile ? dirname(abs) : abs} initialFile={isFile ? abs : undefined} themeName={theme} transparent={transparent} />,
  { width: w, height: h },
)
await setup.renderOnce()
for (const k of keys) {
  if (k === "tab") setup.mockInput.pressTab()
  else if (k === "enter") setup.mockInput.pressEnter()
  else if (k === "esc") setup.mockInput.pressEscape()
  else if (["down", "up", "left", "right"].includes(k)) setup.mockInput.pressArrow(k as "down" | "up" | "left" | "right")
  else if (k === "space") setup.mockInput.pressKey(" ")
  else if (k.startsWith("wait:")) await new Promise((r) => setTimeout(r, Number(k.slice(5)))) // e.g. let code highlighting land
  else if (k.startsWith("type:")) await setup.mockInput.typeText(k.slice(5))
  else if (k.startsWith("C-")) setup.mockInput.pressKey(k.slice(2), { ctrl: true })
  else setup.mockInput.pressKey(k)
  await new Promise((r) => setTimeout(r, 30))
  await setup.renderOnce()
}
await new Promise((r) => setTimeout(r, 50))
await setup.renderOnce()
await setup.renderOnce()
// code blocks fill in asynchronously: wait until the frame stops changing (parsers answer in ~100 ms)
for (let prev = "", i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 50))
  await setup.renderOnce()
  const cur = setup.captureCharFrame() + JSON.stringify(setup.captureSpans().lines.map((l) => l.spans.map((s) => s.fg)))
  if (cur === prev && i >= 3) break
  prev = cur
}
if (json) {
  const f = setup.captureSpans()
  const toHex = (c: { r: number; g: number; b: number; a: number }) =>
    c.a === 0 ? null : "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")
  writeFileSync(
    json,
    JSON.stringify({
      cols: f.cols,
      rows: f.rows,
      lines: f.lines.map((l) => l.spans.map((s) => ({ t: s.text, fg: toHex(s.fg), bg: toHex(s.bg), a: s.attributes }))),
    }),
  )
}
console.log(setup.captureCharFrame())
setup.renderer.destroy()
await shutdownHighlighter()
if (tempConfig) rmSync(tempConfig, { recursive: true, force: true })
process.exit(0)
