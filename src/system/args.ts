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

/** Early exits: these flags win over every other argument, even a bad one. */
const EARLY = new Map<string, "help" | "version">([
  ["-h", "help"],
  ["--help", "help"],
  ["-v", "version"],
  ["--version", "version"],
])

interface Scan {
  paths: string[]
  theme?: string
  transparent: boolean
  early?: "help" | "version"
  error?: string
}

/** `-t`/`--theme`/`--theme=` at `argv[i]`: its value and the index to resume from (an option-looking next argument is left for the loop). Not a theme flag: null. */
function themeOption(
  argv: string[],
  i: number,
  names: string,
): { value: string; next: number } | { error: string; next: number } | null {
  const a = argv[i]!
  const eq = a.startsWith("--theme=")
  if (!eq && a !== "-t" && a !== "--theme") return null
  const value = eq ? a.slice(8) : argv[i + 1]
  if (value && (eq || !value.startsWith("-"))) return { value, next: eq ? i : i + 1 }
  return {
    error: `option ${eq ? "--theme" : a} requires a value: ${names}`,
    next: eq || value?.startsWith("-") ? i : i + 1,
  }
}

/** One pass over argv: the paths, the theme and `--transparent`, the first error, or an early exit. */
function scanArgs(argv: string[], names: string): Scan {
  const scan: Scan = { paths: [], transparent: false }
  let optionsDone = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (optionsDone || !a.startsWith("-") || a === "-") {
      scan.paths.push(a)
      continue
    }
    const early = EARLY.get(a)
    if (early) return { ...scan, early }
    const theme = themeOption(argv, i, names)
    if (theme) {
      if ("error" in theme) scan.error ??= theme.error
      else scan.theme = theme.value
      i = theme.next
    } else if (a === "--") optionsDone = true
    else if (a === "--transparent") scan.transparent = true
    else scan.error ??= `unknown option: ${a}`
  }
  return scan
}

/** Pure CLI argument parser: returns the parsed options or `{ error }`. */
export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = {
    path: ".",
    stdin: false,
    given: false,
    theme: undefined,
    transparent: false,
    help: false,
    version: false,
  }
  const names = `a family (${FAMILIES.map((f) => f.name).join(", ")}) or one of its themes (<family>-light, one-dark)`
  const { paths, theme, transparent, early, error } = scanArgs(argv, names)
  if (early) return { ...out, [early]: true }
  if (error) return { error }
  if (theme !== undefined && !resolveTheme(theme)) return { error: `unknown theme "${theme}": ${names}` }
  if (paths.length > 1) return { error: "expected at most one path" }
  const stdin = paths[0] === "-"
  return { ...out, path: stdin ? "." : (paths[0] ?? "."), stdin, given: paths.length > 0, theme, transparent }
}
