// App: e (edit in $EDITOR) and the stdin document.
import { expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EditResult } from "../../src/system/editor"
import { type Setup, keys, OLLAMA, spansOf, W120, waitFor, waitFrame, withEnv, useAppHarness } from "./helpers"

const { mount, cfgDir, tmp, aiConfig, cacheFile, cached, mountAI } = useAppHarness()

// ------------------------------------------------------------- e: edit

/** Mount with the editor stubbed: returns the argv each `e` would have spawned; `result` is what the run reports. */
async function mountEdit(root: string, file?: string, result?: EditResult) {
  const spawned: string[][] = []
  const s = await mount(root, file, { size: { width: 120, height: 40 }, edit: (argv) => (spawned.push(argv), result) })
  return { s, spawned }
}

// ------------------------------------------------------------- stdin document

/** `scanDelay`: when the background link scan starts; far off by default so a test controls when the folder is read. */
async function mountStdin(text: string, root: string, size = { width: 120, height: 30 }, scanDelay = 60_000) {
  const spawned: string[][] = []
  const s = await mount(root, undefined, { size, stdin: text, linkScanDelay: scanDelay, edit: (argv) => void spawned.push(argv) })
  return { s, spawned }
}

test("e opens the note in $EDITOR at the top line of Source", async () => {
  await withEnv({ VISUAL: "ed-test" }, async () => {
    const d = tmp({ "a.md": "# A\n\nline\nline\n" })
    const { s, spawned } = await mountEdit(d, "a.md")
    await keys(s, "s", "e")
    expect(spawned).toEqual([["ed-test", "+1", join(d, "a.md")]])
  })
})

test("e in Preview lands on the heading at the top of the view", async () => {
  const d = tmp({ "a.md": "intro\n\n# One\n\ntext\n\n## Two\n\n" + "para\n\n".repeat(60) })
  const { s, spawned } = await mountEdit(d, "a.md")
  await keys(s, "]", "]", "e") // scroll to the second heading
  expect(spawned.length).toBe(1)
  expect(spawned[0]![1]).toBe("+7")
})

test("e reloads the note afterwards and says so", async () => {
  const d = tmp({ "a.md": "# A\n" })
  const { s } = await mountEdit(d, "a.md")
  expect(await keys(s, "e")).toContain("edited")
})

test("e says when the editor fails or exits with an error, and still reloads", async () => {
  const d = tmp({ "a.md": "# A\n" })
  const failed = await mountEdit(d, "a.md", { code: 1, signal: null })
  const f = await keys(failed.s, "e")
  expect(f).toContain("exited with 1")
  expect(f).not.toContain("edited")
  failed.s.renderer.destroy()
  const none = await mountEdit(d, "a.md", { error: "no terminal for the editor" })
  expect(await keys(none.s, "e")).toContain("no terminal for the editor")
})

test("e is listed in the help", async () => {
  const d = tmp({ "a.md": "# A\n" })
  const { s } = await mountEdit(d, "a.md")
  expect(await keys(s, "?")).toContain("edit the note in $EDITOR")
})

test("e with no note open toasts", async () => {
  const d = tmp({ "x.txt": "nothing" })
  const { s, spawned } = await mountEdit(d)
  expect(await keys(s, "e")).toContain("no note to edit")
  expect(spawned).toEqual([])
})

test("stdin: the piped text is the document, titled stdin", async () => {
  const d = tmp({ "other.md": "# Other\n" })
  const { s } = await mountStdin("# Piped\n\nhello from a pipe\n", d)
  const f = s.captureCharFrame()
  expect(f).toContain("hello from a pipe")
  expect(f).toContain("stdin")
})

test("stdin: no Files tree, so the folder's notes are not listed", async () => {
  const d = tmp({ "other.md": "# Other\n" })
  const { s } = await mountStdin("# Piped\n", d)
  expect(await keys(s, "1")).not.toContain("other")
})

test("stdin: e toasts instead of spawning an editor", async () => {
  const d = tmp({})
  const { s, spawned } = await mountStdin("# Piped\n", d)
  expect(await keys(s, "e")).toContain("stdin · nothing to edit")
  expect(spawned).toEqual([])
})

test("stdin: links resolve against the working folder's notes", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const { s } = await mountStdin("see [[other]]\n", d)
  expect(s.captureCharFrame()).toContain("see")
  await keys(s, "f", "a")
  expect(s.captureCharFrame()).toContain("body of other")
})

// the folder is scanned on first link use, not at startup: a note created after mounting is found
test("stdin: f follows a link to a note created after startup (scan is lazy)", async () => {
  const d = tmp({})
  const { s } = await mountStdin("see [[late]]\n", d)
  writeFileSync(join(d, "late.md"), "# Late\n\nbody of late\n")
  await keys(s, "f", "a")
  expect(s.captureCharFrame()).toContain("body of late")
})

test("stdin: the folder is scanned in the background, so links light up without a key", async () => {
  const d = tmp({ "late.md": "# Late\n" })
  const linkFg = (s: Setup) => JSON.stringify(spansOf(s).find((sp) => sp.text.includes("late"))?.fg)
  const idle = (await mountStdin("see [[late]]\n", d)).s
  const before = linkFg(idle)
  idle.renderer.destroy()
  const { s } = await mountStdin("see [[late]]\n", d, undefined, 0)
  await waitFor(s, () => linkFg(s) !== before)
})

test("stdin: using a link before the background scan runs scans once", async () => {
  const d = tmp({})
  const { s } = await mountStdin("see [[late]]\n", d)
  writeFileSync(join(d, "late.md"), "# Late\n\nbody of late\n")
  await keys(s, "f", "a")
  expect(s.captureCharFrame()).toContain("body of late")
  writeFileSync(join(d, "later.md"), "# Later\n")
  await keys(s, "f") // already scanned: the new note is not picked up again
  expect(await keys(s, "C-p", "type:later")).not.toContain("later.md")
})

test("stdin: C-p lists notes created after startup (scan is lazy)", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n", d)
  writeFileSync(join(d, "late.md"), "# Late\n")
  expect(await keys(s, "C-p", "type:lat")).toContain("late")
})

test("stdin: opening a link from Info scans on demand", async () => {
  const d = tmp({})
  const { s } = await mountStdin("see [[late]]\n", d)
  writeFileSync(join(d, "late.md"), "# Late\n\nbody of late\n")
  await keys(s, "2", "enter")
  expect(s.captureCharFrame()).toContain("body of late")
})

test("stdin: nothing is recorded as a project", async () => {
  const d = tmp({})
  await mountStdin("# Piped\n", d)
  expect(existsSync(join(cfgDir, "brothy", "projects.json"))).toBe(false)
})

test("stdin: a summarizes the piped text for this run without caching it", async () => {
  aiConfig(OLLAMA)
  const d = tmp({})
  const { s, ai } = await mountAI(d, undefined, { size: W120, stdin: "# Piped\n\nwords about pipes\n" })
  await keys(s, "a")
  expect(ai.calls.length).toBe(1)
  expect(JSON.stringify(ai.calls[0]!.body)).toContain("words about pipes")
  ai.send(0, "Pipes are discussed.")
  ai.end(0)
  await waitFrame(s, (f) => f.includes("Pipes are discussed."))
  expect(cached()).toEqual({})
  expect(existsSync(cacheFile())).toBe(false)
  expect(s.captureCharFrame()).not.toContain("outdated")
})

test("stdin: the footer does not offer e", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n", d)
  expect(s.captureCharFrame()).not.toContain("e edit")
})

test("stdin: the tab row is ¹Outline ²Info, with no Files", async () => {
  const d = tmp({ "other.md": "# Other\n" })
  const { s } = await mountStdin("# Piped\n\n## Sub\n", d)
  const row = s.captureCharFrame().split("\n").find((l) => l.includes("Outline"))!
  expect(row.slice(0, 31)).toBe("  ¹Outline   ²Info" + " ".repeat(13))
  expect(row).not.toContain("Files")
})

test("stdin: 1 and 2 pick Outline and Info, 3 does nothing, / on Info filters the Outline", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n\n## Sub\n", d)
  expect(await keys(s, "2")).toMatch(/Info[\s\S]*Words|Info/)
  expect(await keys(s, "3")).not.toContain("no Markdown files")
  expect(s.captureCharFrame().split("\n")[3]).toMatch(/^ ─{9,}━+/) // rule still under Info (second tab), Outline's is not
  await keys(s, "/")
  expect(s.captureCharFrame()).toContain("/ ")
  expect(s.captureCharFrame()).not.toContain("no Markdown files")
  await keys(s, "esc", "1")
  expect(s.captureCharFrame()).toContain("Sub")
})

test("stdin: the help describes 1 2 for the piped document", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n", d, { width: 90, height: 40 }) // one column: the description is not cut
  expect(await keys(s, "?")).toContain("piped: 1 2 only")
})

test("stdin: the view choice is not saved", async () => {
  const d = tmp({})
  const { s } = await mountStdin("# Piped\n", d)
  await keys(s, "2")
  expect(existsSync(join(cfgDir, "brothy", "config.json"))).toBe(false)
})

test("stdin: e on a followed note runs the editor as a piped session (keys from the terminal)", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const runs: [string, boolean][] = []
  const s = await mount(d, undefined, { size: W120, stdin: "see [[other]]\n", linkScanDelay: 60_000, edit: (argv, piped) => void runs.push([argv.at(-1)!, piped]) })
  await keys(s, "f", "a")
  expect(await keys(s, "e")).toContain("edited")
  expect(runs).toEqual([[join(d, "other.md"), true]])
})

test("stdin: H comes back to the piped document from a followed link", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const { s } = await mountStdin("see [[other]]\n\npiped body\n", d)
  expect(await keys(s, "f", "a")).toContain("body of other")
  const back = await keys(s, "H")
  expect(back).toContain("piped body")
  expect(back).not.toContain("is gone")
})

test("stdin: a followed note keeps the piped tabs, 1 is Outline and nothing is saved; H back draws", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const { s } = await mountStdin("see [[other]]\n\npiped body\n", d)
  await keys(s, "f", "a")
  const f = await keys(s, "1")
  expect(f).toContain("¹Outline")
  expect(f).not.toContain("Files")
  expect(existsSync(join(cfgDir, "brothy", "config.json"))).toBe(false)
  expect(await keys(s, "H")).toContain("piped body")
})

test("stdin: quitting on a followed note records no project", async () => {
  const d = tmp({ "other.md": "# Other\n\nbody of other\n" })
  const { s } = await mountStdin("see [[other]]\n", d)
  await keys(s, "f", "a")
  s.renderer.destroy() // the renderer's end records the workspace, as q does
  expect(existsSync(join(cfgDir, "brothy", "projects.json"))).toBe(false)
})
