import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, normalize, relative } from "node:path"

// The folder rules of src/, read off the import lines: lib/ is a leaf, the domain folders never reach up into the
// app, and no two modules load each other. Type-only imports are erased at runtime, so the cycle check skips them.

const SRC = join(import.meta.dir, "../src")
const DOMAINS = ["markdown", "ai", "notes", "ui", "theme", "system"]
const IMPORT =
  /^(?:import|export)\s+(type\s+)?[\w$*{},\s]*?from\s+"(\.{1,2}\/[^"]*)"|import\(\s*"(\.{1,2}\/[^"]*)"\s*\)/gm

interface Edge {
  to: string
  type: boolean
}

/** src-relative path → the src modules it imports */
function graph(): Map<string, Edge[]> {
  const g = new Map<string, Edge[]>()
  for (const f of readdirSync(SRC, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(f)) continue
    const edges: Edge[] = []
    for (const m of readFileSync(join(SRC, f), "utf8").matchAll(IMPORT)) {
      const base = normalize(join(dirname(join(SRC, f)), (m[2] ?? m[3])!))
      const file = [".ts", ".tsx"].map((e) => base + e).find(existsSync) ?? base
      edges.push({ to: relative(SRC, file), type: !!m[1] })
    }
    g.set(f, edges)
  }
  return g
}

const deps = graph()
const folderOf = (f: string) => (f.includes("/") ? f.split("/")[0]! : f)

test("the scan sees every module and its imports", () => {
  expect(deps.size).toBeGreaterThan(50)
  expect(deps.get("App.tsx")!.length).toBeGreaterThan(5)
  for (const edges of deps.values()) for (const e of edges) expect(deps.has(e.to)).toBe(true)
})

test("lib/ imports nothing in src outside lib/", () => {
  const bad = [...deps].flatMap(([f, es]) =>
    folderOf(f) === "lib" ? es.filter((e) => folderOf(e.to) !== "lib").map((e) => `${f} → ${e.to}`) : [],
  )
  expect(bad).toEqual([])
})

test("markdown/, ai/, notes/, ui/, theme/ and system/ never import app/ or App", () => {
  const bad = [...deps].flatMap(([f, es]) =>
    DOMAINS.includes(folderOf(f))
      ? es.filter((e) => folderOf(e.to) === "app" || e.to === "App.tsx").map((e) => `${f} → ${e.to}`)
      : [],
  )
  expect(bad).toEqual([])
})

test("no module loads itself through its imports (type-only imports aside)", () => {
  const cycles: string[] = []
  const state = new Map<string, "open" | "done">()
  const path: string[] = []
  const visit = (f: string) => {
    state.set(f, "open")
    path.push(f)
    for (const e of deps.get(f)!) {
      if (e.type) continue
      if (state.get(e.to) === "open") cycles.push([...path.slice(path.indexOf(e.to)), e.to].join(" → "))
      else if (!state.has(e.to)) visit(e.to)
    }
    path.pop()
    state.set(f, "done")
  }
  for (const f of [...deps.keys()].sort()) if (!state.has(f)) visit(f)
  expect(cycles).toEqual([])
})
