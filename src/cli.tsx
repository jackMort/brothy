#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { readdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { App, VERSION } from "./App"
import { parseArgs } from "./args"
import { loadConfig } from "./config"
import { isMarkdown } from "./files"
import { WORDMARK } from "./status"
import { themes } from "./theme"

const die = (msg: string): never => {
  console.error(`brothy: ${msg}`)
  process.exit(1)
}
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))

const parsed = parseArgs(process.argv.slice(2))
if ("error" in parsed) die(`${parsed.error}\ntry 'brothy --help'`)
const args = parsed as Exclude<typeof parsed, { error: string }>

/** `mode:` followed by the theme names, wrapped at 80 columns under the option column. */
function themeLines(mode: "dark" | "light"): string {
  const pad = " ".repeat(17)
  const lines: string[] = []
  let line = `${pad}${mode}:`.padEnd(pad.length + 7)
  const names = themes.filter((t) => t.mode === mode).map((t) => t.name)
  names.forEach((n, i) => {
    const word = n + (i < names.length - 1 ? "," : "")
    if (line.trimEnd().length + 1 + word.length > 80) {
      lines.push(line.trimEnd())
      line = pad + " ".repeat(7)
    }
    line += (line.endsWith(" ") ? "" : " ") + word
  })
  lines.push(line)
  return lines.join("\n")
}

if (args.help) {
  console.log(`brothy ${VERSION} — a terminal Markdown reader

usage: brothy [path] [--theme <name>] [--transparent]

  path           a Markdown file or a folder to browse (default: .)
  -t, --theme    a theme name:
${themeLines("dark")}
${themeLines("light")}
  --transparent  let the terminal background show through (toggle: T)
  -v, --version  print version

Press ? inside the app for keys.`)
  process.exit(0)
}
if (args.version) {
  console.log(WORDMARK.join("\n").replace(/ +$/gm, ""))
  console.log(VERSION)
  process.exit(0)
}

const abs = resolve(args.path)
let isFile: boolean
try {
  const st = statSync(abs)
  isFile = st.isFile()
  if (!isFile && !st.isDirectory()) die(`${args.path} is not a file or folder`)
  if (!isFile) readdirSync(abs) // surface EACCES now instead of an empty "No Markdown files found"
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code
  die(code === "ENOENT" ? `no such file or directory: ${args.path}` : `cannot read ${args.path}: ${reason(e)}`)
}
if (isFile! && !isMarkdown(abs)) console.error(`brothy: ${args.path} doesn't look like Markdown, opening anyway`)
const root = isFile! ? dirname(abs) : abs

if (!process.stdout.isTTY || !process.stdin.isTTY) die("needs an interactive terminal (stdin and stdout must be a TTY)")

try {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true, targetFps: 30 })
  createRoot(renderer).render(
    <App root={root} initialFile={isFile! ? abs : undefined} themeName={args.theme ?? loadConfig().theme} transparent={args.transparent || undefined} />,
  )
} catch (e) {
  die(`failed to start the terminal UI: ${reason(e)}`)
}
