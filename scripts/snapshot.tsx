// Render the app headlessly and print the frame. Usage:
//   bun scripts/snapshot.tsx [path] [--size 120x36] [--keys "j j tab 3"] [--json out.json] [--theme name] [--transparent] [--config dir] [--stdin file]
// Config (theme, folds) lives in a throwaway temp dir unless --config <dir> points at a real XDG_CONFIG_HOME.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { shutdownHighlighter } from "../src/markdown/highlight"
import { frame, mount, press, settle, sleep } from "./session"

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
const stdinFile = opt("--stdin") // render that file as the piped document (root = the path argument)
const tempConfig = configDir ? undefined : mkdtempSync(join(tmpdir(), "brothy-snap-"))
process.env.XDG_CONFIG_HOME = configDir ? resolve(configDir) : tempConfig // read lazily by src/system/config.ts
const abs = resolve(args[0] ?? "examples")
const isFile = !stdinFile && statSync(abs).isFile()

const setup = await mount({
  root: isFile ? dirname(abs) : abs,
  initialFile: isFile ? abs : undefined,
  theme,
  transparent,
  stdin: stdinFile ? readFileSync(stdinFile, "utf8") : undefined,
  width: w!,
  height: h!,
})
for (const k of keys) {
  await press(setup, k)
  await sleep(30)
  await setup.renderOnce()
}
await settle(setup)
if (json) writeFileSync(json, JSON.stringify(frame(setup)))
console.log(setup.captureCharFrame())
setup.renderer.destroy()
await shutdownHighlighter()
if (tempConfig) rmSync(tempConfig, { recursive: true, force: true })
process.exit(0)
