// Temp folders for unit tests. Nothing runs at import: `useTmp` registers its hook when a test file (or describe) calls it.
import { afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** A new folder holding `files`: paths relative to it with the body `# x\n` (a trailing `/` makes an empty folder), or a map from path to body. */
export function makeTmp(prefix: string, files: string[] | Record<string, string> = []) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const [name, body] of Array.isArray(files) ? files.map((f) => [f, "# x\n"] as const) : Object.entries(files)) {
    mkdirSync(name.endsWith("/") ? join(root, name) : dirname(join(root, name)), { recursive: true })
    if (!name.endsWith("/")) writeFileSync(join(root, name), body)
  }
  return root
}

/** Returns `makeTmp` bound to `prefix`, removing every folder it made after the file's (or describe's) tests. */
export function useTmp(prefix: string) {
  const made: string[] = []
  afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))
  return (files?: string[] | Record<string, string>) => {
    const root = makeTmp(prefix, files)
    made.push(root)
    return root
  }
}
