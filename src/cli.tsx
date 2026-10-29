#!/usr/bin/env bun
import { openSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { ReadStream } from "node:tty"
// The CLI entry: parse args, stat the path, check the TTY, read a piped document, create the renderer and mount <App>.
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App, VERSION } from "./App"
import { isMarkdown } from "./notes/files"
import { readCapped } from "./notes/stdin"
import { parseArgs } from "./system/args"
import { loadConfig } from "./system/config"
import { FAMILIES, onlyMode } from "./theme/themepick"
import { WORDMARK } from "./ui/status"

const die: (msg: string) => never = (msg) => {
  console.error(`brothy: ${msg}`)
  process.exit(1)
}
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))

const parsed = parseArgs(process.argv.slice(2))
if ("error" in parsed) die(`${parsed.error}\ntry 'brothy --help'`)
const args = parsed

/** Width `--help` wraps at, and the indent of its option descriptions. */
const HELP_WRAP_W = 80
const HELP_INDENT = 17

/** The family names, wrapped at HELP_WRAP_W columns under the option column; a single-mode family says which. */
function familyLines(): string {
  const pad = " ".repeat(HELP_INDENT)
  const lines: string[] = []
  let line = pad
  FAMILIES.forEach((f, i) => {
    const word = f.name + (onlyMode(f) ? ` (${onlyMode(f)} only)` : "") + (i < FAMILIES.length - 1 ? "," : "")
    if (line.trimEnd().length + 1 + word.length > HELP_WRAP_W) {
      lines.push(line.trimEnd())
      line = pad
    }
    line += (line.endsWith(" ") ? "" : " ") + word
  })
  lines.push(line)
  return lines.join("\n")
}

if (args.help) {
  console.log(`brothy ${VERSION} — a terminal Markdown reader

usage: brothy [path] [--theme <name>] [--transparent]
       command | brothy [-]

  path           a Markdown file or a folder to browse (default: .)
  -              read Markdown from stdin (also when piped and no path is given)
  -t, --theme    a family (its dark theme) or a theme: <family>-light, one-dark
${familyLines()}
  --transparent  let the terminal background show through (toggle: T)
  -h, --help     show this help
  -v, --version  print version

Press ? inside the app for keys.`)
  process.exit(0)
}
if (args.version) {
  console.log(WORDMARK.join("\n").replace(/ +$/gm, ""))
  console.log(VERSION)
  process.exit(0)
}

/** Markdown on stdin: `-`, or a pipe with no path. Keys then come from the controlling terminal. */
const piped = args.stdin || (!args.given && !process.stdin.isTTY)
let abs = ""
let isFile = false
let root = process.cwd()
let stdinText: string | undefined
let keys: ReadStream | undefined

if (piped) {
  if (!process.stdout.isTTY) die("needs an interactive terminal (stdout must be a TTY)")
  try {
    keys = new ReadStream(openSync("/dev/tty", "r"))
  } catch (e) {
    die(`needs a terminal for keys when reading stdin (cannot open /dev/tty: ${reason(e)})`)
  }
  stdinText = (await readCapped(Bun.stdin.stream())) ?? die("input too large (limit 5 MB)")
  if (!stdinText.trim()) die("nothing on stdin")
} else {
  abs = resolve(args.path)
  try {
    const st = statSync(abs)
    isFile = st.isFile()
    if (!isFile && !st.isDirectory()) die(`${args.path} is not a file or folder`)
    if (!isFile) readdirSync(abs) // surface EACCES now instead of an empty "No Markdown files found"
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    die(code === "ENOENT" ? `no such file or directory: ${args.path}` : `cannot read ${args.path}: ${reason(e)}`)
  }
  if (isFile && !isMarkdown(abs)) console.error(`brothy: ${args.path} doesn't look like Markdown, opening anyway`)
  root = isFile ? dirname(abs) : abs
  if (!process.stdout.isTTY || !process.stdin.isTTY) die("needs an interactive terminal (stdin and stdout must be a TTY)")
}

try {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true, targetFps: 30, ...(keys && { stdin: keys }) })
  createRoot(renderer).render(
    <App
      root={root}
      initialFile={isFile ? abs : undefined}
      stdin={stdinText}
      themeName={args.theme ?? loadConfig().theme}
      transparent={args.transparent || undefined}
    />,
  )
} catch (e) {
  die(`failed to start the terminal UI: ${reason(e)}`)
}
