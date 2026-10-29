import { describe, expect, test } from "bun:test"
import { editorCommand, runEditor, sourceLineAt, type EditorIO } from "../src/editor"
import { render } from "../src/markdown"
import { parseFrontMatter } from "../src/frontmatter"
import { renderSource, sourceScan } from "../src/source"
import { brothy } from "./helpers/theme"

const t = brothy
const note = ["---", "title: x", "---", "intro line", "", "# One", "", "alpha", "", "## Two", "", "beta", "gamma"].join("\n")

describe("sourceLineAt", () => {
  test("Source view: the source line whose first row is at or above the top", () => {
    const r = renderSource(note, 80, t)
    expect(sourceLineAt({ source: true, top: 0, srcRow: r.srcRow })).toBe(1)
    expect(sourceLineAt({ source: true, top: r.srcRow![7]!, srcRow: r.srcRow })).toBe(8)
  })

  test("Preview: a heading row maps to that heading's source line", () => {
    const fm = parseFrontMatter(note)
    const r = render(fm.body, 80, t)
    const scan = sourceScan(note, t)
    const two = r.headings.findIndex((h) => h.text === "Two")
    expect(sourceLineAt({ source: false, top: r.headings[two]!.line, headings: r.headings, scan: scan.headings, offset: fm.offset })).toBe(10)
  })

  test("Preview: rows below a heading advance from it, never past the next heading", () => {
    const fm = parseFrontMatter(note)
    const r = render(fm.body, 80, t)
    const scan = sourceScan(note, t)
    const one = r.headings.find((h) => h.text === "One")!
    const at = (top: number) => sourceLineAt({ source: false, top, headings: r.headings, scan: scan.headings, offset: fm.offset })
    expect(at(one.line)).toBe(6)
    expect(at(one.line + 2)).toBe(8)
    const two = r.headings.find((h) => h.text === "Two")!
    expect(at(two.line - 1)).toBeLessThan(10)
    const short = ["# A", "", "x", "", "## B"].join("\n")
    const sr = render(short, 80, t)
    const ss = sourceScan(short, t)
    // a wrapped paragraph can't push the line into the next heading
    expect(sourceLineAt({ source: false, top: sr.headings[1]!.line - 1 + 40, headings: sr.headings.slice(0, 1), scan: ss.headings.slice(0, 1), offset: 0 })).toBeGreaterThan(0)
    expect(sourceLineAt({ source: false, top: 2, headings: sr.headings, scan: ss.headings, offset: 0 })).toBeLessThanOrEqual(4)
  })

  test("Preview: before the first heading counts from the end of the front matter", () => {
    const fm = parseFrontMatter(note)
    const r = render(fm.body, 80, t)
    const scan = sourceScan(note, t)
    expect(sourceLineAt({ source: false, top: 0, headings: r.headings, scan: scan.headings, offset: fm.offset })).toBe(4)
  })

  test("Preview without headings", () => {
    expect(sourceLineAt({ source: false, top: 3, headings: [], scan: [], offset: 0 })).toBe(4)
  })
})

describe("editorCommand", () => {
  test("$VISUAL wins over $EDITOR; the line goes first as +N", () => {
    expect(editorCommand({ VISUAL: "nvim", EDITOR: "nano" }, "/a/b.md", 12)).toEqual(["nvim", "+12", "/a/b.md"])
  })
  test("falls back to $EDITOR, then vi", () => {
    expect(editorCommand({ EDITOR: "nano" }, "/a.md", 1)).toEqual(["nano", "+1", "/a.md"])
    expect(editorCommand({}, "/a.md", 1)).toEqual(["vi", "+1", "/a.md"])
    expect(editorCommand({ VISUAL: "  " }, "/a.md", 1)[0]).toBe("vi")
  })
  test("an editor with arguments is split on spaces", () => {
    expect(editorCommand({ EDITOR: "nvim -n" }, "/a.md", 3)).toEqual(["nvim", "-n", "+3", "/a.md"])
  })
  test("VS Code and its forks take -g path:line, Sublime Text path:line, by the command's basename", () => {
    expect(editorCommand({ EDITOR: "code --wait" }, "/a.md", 3)).toEqual(["code", "--wait", "-g", "/a.md:3"])
    expect(editorCommand({ VISUAL: "/usr/bin/codium -w" }, "/a.md", 3)).toEqual(["/usr/bin/codium", "-w", "-g", "/a.md:3"])
    expect(editorCommand({ VISUAL: "cursor --wait" }, "/a.md", 9)).toEqual(["cursor", "--wait", "-g", "/a.md:9"])
    expect(editorCommand({ EDITOR: "subl -w" }, "/a.md", 3)).toEqual(["subl", "-w", "/a.md:3"])
    expect(editorCommand({ EDITOR: "/opt/encode" }, "/a.md", 3)).toEqual(["/opt/encode", "+3", "/a.md"]) // only the whole name counts
  })
})

describe("runEditor", () => {
  /** Fake terminal: logs every step; `tty` is the fd /dev/tty opens as, or null when there is none. */
  const io = (tty: number | null, spawn: EditorIO["spawn"] = () => ({ exitCode: 0 })) => {
    const log: string[] = []
    const fake: EditorIO = {
      openTTY: () => {
        if (tty === null) throw new Error("ENXIO")
        log.push(`open ${tty}`)
        return tty
      },
      close: (fd) => void log.push(`close ${fd}`),
      spawn: (argv, stdin) => (log.push(`spawn ${argv.join(" ")} < ${stdin}`), spawn(argv, stdin)),
      suspend: () => void log.push("suspend"),
      resume: () => void log.push("resume"),
    }
    return { log, fake }
  }

  test("the renderer is suspended around the spawn, which inherits stdin; the exit comes back", () => {
    const { log, fake } = io(7, () => ({ exitCode: 2, signalCode: null }))
    expect(runEditor(["vi", "+1", "/a.md"], false, fake)).toEqual({ code: 2, signal: null })
    expect(log).toEqual(["suspend", "spawn vi +1 /a.md < inherit", "resume"])
  })
  test("a piped session gives the editor /dev/tty for keys and closes it after", () => {
    const { log, fake } = io(7)
    expect(runEditor(["vi", "/a.md"], true, fake)).toEqual({ code: 0, signal: null })
    expect(log).toEqual(["open 7", "suspend", "spawn vi /a.md < 7", "resume", "close 7"])
  })
  test("without a terminal to open, a piped session runs nothing", () => {
    const { log, fake } = io(null)
    expect(runEditor(["vi", "/a.md"], true, fake)).toEqual({ error: "no terminal for the editor" })
    expect(log).toEqual([])
  })
  test("a spawn that throws (no such editor) still resumes and closes", () => {
    const { log, fake } = io(7, () => {
      throw new Error("not found")
    })
    expect(() => runEditor(["nope", "/a.md"], true, fake)).toThrow("not found")
    expect(log).toEqual(["open 7", "suspend", "spawn nope /a.md < 7", "resume", "close 7"])
  })
})
