// The command line: `parseArgs` turns argv into `Args` or an error message. Pure; cli.tsx prints the errors and `--help`.
import { FAMILIES, resolveTheme } from "../theme/themepick"

export interface Args {
  path: string
  /** `-`: read the document from stdin */
  stdin: boolean
  /** a path (or `-`) was on the command line; without one the CLI reads a piped stdin */
  given: boolean
  /** a theme or family name (`resolveTheme`), kept as typed */
  theme?: string
  transparent: boolean
  help: boolean
  version: boolean
}

/** Pure CLI argument parser: returns the parsed options or `{ error }`. */
export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = { path: ".", stdin: false, given: false, theme: undefined, transparent: false, help: false, version: false }
  const paths: string[] = []
  const names = `a family (${FAMILIES.map((f) => f.name).join(", ")}) or one of its themes (<family>-light, one-dark)`
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
        fail(`option ${eq ? "--theme" : a} requires a value: ${names}`)
        if (!eq && value?.startsWith("-")) i--
      } else theme = value
    } else {
      fail(`unknown option: ${a}`)
    }
  }
  if (error) return { error }
  if (theme !== undefined && !resolveTheme(theme)) return { error: `unknown theme "${theme}": ${names}` }
  if (paths.length > 1) return { error: "expected at most one path" }
  const stdin = paths[0] === "-"
  return { ...out, path: stdin ? "." : (paths[0] ?? "."), stdin, given: paths.length > 0, theme, transparent }
}
