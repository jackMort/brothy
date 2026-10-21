import { themes } from "./theme"

export interface Args {
  path: string
  theme?: string
  transparent: boolean
  help: boolean
  version: boolean
}

/** Pure CLI argument parser: returns the parsed options or `{ error }`. */
export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = { path: ".", theme: undefined, transparent: false, help: false, version: false }
  const paths: string[] = []
  const names = themes.map((t) => t.name)
  let theme: string | undefined
  let transparent = false
  let optionsDone = false
  let error: string | undefined
  const fail = (msg: string) => {
    error ??= msg
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (optionsDone || !a.startsWith("-") || a === "-") {
      paths.push(a)
    } else if (a === "--") {
      optionsDone = true
    } else if (a === "-h" || a === "--help") {
      return { ...out, help: true }
    } else if (a === "-v" || a === "--version") {
      return { ...out, version: true }
    } else if (a === "--transparent") {
      transparent = true
    } else if (a === "-t" || a === "--theme" || a.startsWith("--theme=")) {
      const eq = a.startsWith("--theme=")
      const value = eq ? a.slice(8) : argv[++i]
      if (!value || (!eq && value.startsWith("-"))) {
        fail(`option ${eq ? "--theme" : a} requires a value (one of: ${names.join(", ")})`)
        if (!eq && value?.startsWith("-")) i--
      } else theme = value
    } else {
      fail(`unknown option: ${a}`)
    }
  }
  if (error) return { error }
  if (theme !== undefined && !names.includes(theme)) return { error: `unknown theme "${theme}" (one of: ${names.join(", ")})` }
  if (paths.length > 1) return { error: "expected at most one path" }
  return { ...out, path: paths[0] ?? ".", theme, transparent }
}
