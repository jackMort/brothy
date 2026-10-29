import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PATH_CAP,
  PROJECTS_CAP,
  expandTilde,
  loadProjects,
  looksLikePath,
  openRows,
  pathCompletions,
  projectsPath,
  rankProjects,
  remember,
  saveProjects,
  tildify,
  type DirIO,
  type ProjectEntry,
} from "../src/projects"

const entry = (root: string, at = 0, lastNote: string | null = null, top = 0): ProjectEntry => ({ root, lastNote, top, at })

describe("remember", () => {
  test("puts the entry first and drops the older one for the same root", () => {
    const list = [entry("/a", 2), entry("/b", 1)]
    expect(remember(list, entry("/b", 3, "/b/x.md", 7)).map((e) => [e.root, e.lastNote, e.top])).toEqual([
      ["/b", "/b/x.md", 7],
      ["/a", null, 0],
    ])
  })
  test("keeps at most the cap, oldest out", () => {
    const list = Array.from({ length: PROJECTS_CAP }, (_, i) => entry(`/p${i}`, i))
    const out = remember(list, entry("/new", 99))
    expect(out).toHaveLength(PROJECTS_CAP)
    expect(out[0]!.root).toBe("/new")
    expect(out.at(-1)!.root).toBe(`/p${PROJECTS_CAP - 2}`)
  })
})

describe("load / save", () => {
  const base = mkdtempSync(join(tmpdir(), "brothy-proj-"))
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const saved = process.env.XDG_CONFIG_HOME
  let n = 0
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = join(base, String(n++))
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved
  })

  test("lives next to config.json", () => {
    expect(projectsPath()).toBe(join(process.env.XDG_CONFIG_HOME!, "brothy", "projects.json"))
  })
  test("a missing file is an empty list; a saved list reads back", () => {
    expect(loadProjects()).toEqual([])
    const list = [entry("/a", 5, "/a/n.md", 12), entry("/b", 4)]
    saveProjects(list)
    expect(loadProjects()).toEqual(list)
  })
  test("the file is {\"projects\": [...]} in two-space JSON with a trailing newline, and a stored file reads back", () => {
    const list = [{ root: "/a", lastNote: "/a/n.md", top: 12, geo: { heads: [0, 5], total: 30 }, at: 5 }, entry("/b", 4)]
    saveProjects(list)
    const text = readFileSync(projectsPath(), "utf8")
    expect(text).toBe(JSON.stringify({ projects: list }, null, 2) + "\n")
    writeFileSync(projectsPath(), text)
    expect(loadProjects()).toEqual(list)
  })
  test("valid JSON that is not an object is an empty list", () => {
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, "brothy"), { recursive: true })
    for (const text of ["[]", "null", '"x"', '{"projects":"x"}']) {
      writeFileSync(projectsPath(), text)
      expect(loadProjects()).toEqual([])
    }
  })
  test("a corrupt file is an empty list, and the next save replaces it", () => {
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, "brothy"), { recursive: true })
    writeFileSync(projectsPath(), "{ not json")
    expect(loadProjects()).toEqual([])
    saveProjects([entry("/a")])
    expect(JSON.parse(readFileSync(projectsPath(), "utf8")).projects[0].root).toBe("/a")
  })
  test("bad entries are dropped, bad fields defaulted, duplicates and overflow cut", () => {
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, "brothy"), { recursive: true })
    const projects = [
      { root: "/a", lastNote: "/a/x.md", top: 3, at: 9 },
      { root: "relative" },
      "nope",
      { root: "/b", lastNote: 4, top: -2, at: "x" },
      { root: "/a", top: 1 },
      ...Array.from({ length: 30 }, (_, i) => ({ root: `/z${i}` })),
    ]
    writeFileSync(projectsPath(), JSON.stringify({ projects }))
    const out = loadProjects()
    expect(out.slice(0, 2)).toEqual([entry("/a", 9, "/a/x.md", 3), entry("/b")])
    expect(out).toHaveLength(PROJECTS_CAP)
  })
  test("geometry round-trips; invalid geometry is dropped, old entries load without it", () => {
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, "brothy"), { recursive: true })
    const geo = { heads: [0, 10, 25], total: 40 }
    writeFileSync(
      projectsPath(),
      JSON.stringify({
        projects: [
          { root: "/a", top: 12, geo },
          { root: "/b", top: 3 },
          { root: "/c", top: 3, geo: { heads: [1, -2], total: 5 } },
          { root: "/d", top: 3, geo: { heads: "x", total: 5 } },
          { root: "/e", top: 3, geo: { heads: [1.5], total: 5 } },
          { root: "/f", top: 3, geo: { heads: [], total: -1 } },
        ],
      }),
    )
    const l = loadProjects()
    expect(l[0]!.geo).toEqual(geo)
    expect(l.slice(1).map((e) => "geo" in e)).toEqual([false, false, false, false, false])
    saveProjects([{ ...entry("/a", 1, null, 12), geo }])
    expect(loadProjects()[0]!.geo).toEqual(geo)
  })
  test("a symlinked projects.json stays a symlink and its target is updated", () => {
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, "brothy"), { recursive: true })
    const real = join(process.env.XDG_CONFIG_HOME!, "real-projects.json")
    writeFileSync(real, "{}")
    chmodSync(real, 0o600)
    symlinkSync(real, projectsPath())
    saveProjects([entry("/a")])
    expect(lstatSync(projectsPath()).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, "utf8")).projects[0].root).toBe("/a")
    expect(statSync(real).mode & 0o777).toBe(0o600)
  })
  test("a write error is swallowed", () => {
    process.env.XDG_CONFIG_HOME = "/proc/brothy-cannot-write"
    expect(() => saveProjects([entry("/a")])).not.toThrow()
  })
})

describe("tilde", () => {
  test("tildify shortens paths under home only", () => {
    expect(tildify("/home/me/notes", "/home/me")).toBe("~/notes")
    expect(tildify("/home/me", "/home/me")).toBe("~")
    expect(tildify("/home/meow", "/home/me")).toBe("/home/meow")
  })
  test("expandTilde expands a leading ~ and ~/ only", () => {
    expect(expandTilde("~", "/home/me")).toBe("/home/me")
    expect(expandTilde("~/x/y", "/home/me")).toBe("/home/me/x/y")
    expect(expandTilde("/a/~/b", "/home/me")).toBe("/a/~/b")
    expect(expandTilde("~bob", "/home/me")).toBe("~bob")
  })
  test("looksLikePath: / ~ . at the start", () => {
    for (const q of ["/", "~/x", "./a", "../b", "~"]) expect(looksLikePath(q)).toBe(true)
    for (const q of ["notes", " a/b", ""]) expect(looksLikePath(q)).toBe(false)
  })
})

describe("rankProjects", () => {
  const list = [entry("/w/brothy", 3), entry("/w/notes", 2), entry("/x/brochures", 1)]
  test("an empty query keeps every entry, newest first", () => {
    expect(rankProjects(list, "").map((r) => r.name)).toEqual(["brothy", "notes", "brochures"])
  })
  test("names match fuzzily, best first, with hits", () => {
    const r = rankProjects(list, "bro")
    expect(r.map((x) => x.name)).toEqual(["brothy", "brochures"])
    expect(r[0]!.hits).toEqual([0, 1, 2])
    expect(rankProjects(list, "bth").map((x) => x.name)).toEqual(["brothy"])
  })
  test("a match only in the path still lists the project, after name matches", () => {
    expect(rankProjects(list, "x/").map((x) => x.name)).toEqual(["brochures"])
  })
})

/** A fake tree: dir path → entries. */
function fakeIO(tree: Record<string, [string, boolean][]>): DirIO {
  return { list: (d) => tree[d]?.map(([name, dir]) => ({ name, dir })) ?? null }
}
const io = fakeIO({
  "/home/me": [
    ["Docs", true],
    ["dev", true],
    [".config", true],
    ["todo.md", false],
    ["photo.png", false],
    ["Draft.MD", false],
  ],
  "/home/me/Docs": [["a.md", false]],
  "/work": [["proj", true]],
})
const at = { cwd: "/work", home: "/home/me" }

describe("pathCompletions", () => {
  test("lists dirs and Markdown files only, dirs first, hidden ones skipped", () => {
    const out = pathCompletions("~/", io, at)
    expect(out.map((p) => p.completion)).toEqual(["~/", "~/dev/", "~/Docs/", "~/Draft.MD", "~/todo.md"])
    expect(out[0]).toMatchObject({ self: true, path: "/home/me", dir: true })
    expect(out[1]).toMatchObject({ path: "/home/me/dev", dir: true, name: "dev" })
  })
  test("hidden entries show once the prefix starts with a dot", () => {
    expect(pathCompletions("~/.c", io, at).map((p) => p.completion)).toEqual(["~/.config/"])
  })
  test("a prefix narrows by name, prefix matches first, with hits", () => {
    const out = pathCompletions("~/d", io, at)
    expect(out.map((p) => p.name)).toEqual(["dev", "Docs", "Draft.MD", "todo.md"])
    expect(out[0]!.hits).toEqual([0])
    expect(pathCompletions("~/Doc", io, at).map((p) => p.name)).toEqual(["Docs"])
  })
  test("~ alone lists home; relative paths resolve against cwd", () => {
    expect(pathCompletions("~", io, at)[0]).toMatchObject({ self: true, path: "/home/me", completion: "~/" })
    expect(pathCompletions("./", io, at).map((p) => p.completion)).toEqual(["./", "./proj/"])
    expect(pathCompletions("/home/me/Docs/", io, at).map((p) => p.path)).toEqual(["/home/me/Docs", "/home/me/Docs/a.md"])
  })
  test("an unreadable dir gives nothing", () => {
    expect(pathCompletions("/nope/", io, at)).toEqual([])
    expect(pathCompletions("/nope/x", io, at)).toEqual([])
  })
})

describe("openRows", () => {
  const list = [entry("/w/brothy", 3), entry("/w/gone", 2), entry("/w/notes", 1)]
  const o = { ...at, io, exists: (p: string) => p !== "/w/gone", current: "/w/notes" }
  test("an empty query: the Recent section without the current workspace; missing ones flagged", () => {
    const rows = openRows(list, "", o)
    expect(rows.map((r) => r.kind)).toEqual(["header", "recent", "recent"])
    expect(rows[0]).toMatchObject({ title: "Recent", count: "2" })
    expect(rows.slice(1).map((r) => r.kind === "recent" && [r.name, r.missing])).toEqual([
      ["brothy", false],
      ["gone", true],
    ])
  })
  test("a path query adds the Path section", () => {
    const rows = openRows(list, "~/Doc", o)
    expect(rows.map((r) => (r.kind === "header" ? r.title : r.kind))).toEqual(["Path", "path"])
  })
  test("a path query lists Path first; Recent keeps only projects under that path", () => {
    const mine = [entry("/home/me/Docs/vault", 3), entry("/home/me/dev/x", 2), entry("/w/brothy", 1)]
    const rows = openRows(mine, "~/Doc", o)
    expect(rows.map((r) => (r.kind === "header" ? r.title : r.kind === "recent" ? r.name : r.name))).toEqual(["Path", "Docs", "Recent", "vault"])
    // "~/" fuzzily matches every path under home, but only a prefix counts
    expect(openRows(mine, "~/", o).filter((r) => r.kind === "recent").map((r) => r.kind === "recent" && r.name)).toEqual(["vault", "x"])
    expect(openRows(mine, "~/", o)[1]).toMatchObject({ kind: "path", self: true })
  })
  test("nothing matching: no rows", () => {
    expect(openRows(list, "zzz", o)).toEqual([])
  })
})

describe("openRows path filters", () => {
  const o = (io: DirIO) => ({ cwd: "/", home: "/h", io, exists: () => true })
  test("Recent under a typed folder excludes siblings sharing the prefix", () => {
    const list = [entry("/w/proj", 2), entry("/w/project-other", 1), entry("/w/proj/sub", 0)]
    const io: DirIO = { list: () => [] }
    for (const q of ["/w/proj", "/w/proj/"]) {
      const roots = openRows(list, q, o(io)).filter((r) => r.kind === "recent").map((r) => (r as { entry: ProjectEntry }).entry.root)
      expect(roots, q).toEqual(["/w/proj", "/w/proj/sub"])
    }
  })
  test("the path count has a + only when there are more rows", () => {
    const files = (n: number): DirIO => ({ list: () => Array.from({ length: n }, (_, i) => ({ name: `n${i}.md`, dir: false })) })
    const count = (n: number) => (openRows([], "/x/", o(files(n)))[0] as { count: string }).count
    expect(count(PATH_CAP)).toBe(String(PATH_CAP))
    expect(count(PATH_CAP + 1)).toBe(`${PATH_CAP}+`)
  })
})
