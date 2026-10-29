import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { useTmp } from "./helpers/tmp"

const cli = join(import.meta.dir, "../src/cli.tsx")
const root = join(import.meta.dir, "..")
async function run(...args: string[]) {
  const p = Bun.spawn(["bun", cli, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [out, errText, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { out, err: errText, code }
}

describe("cli", () => {
  const tmp = useTmp("brothy-cli-")
  test("--version prints and exits 0", async () => {
    const r = await run("--version")
    expect(r.code).toBe(0)
    const lines = r.out.trimEnd().split("\n")
    expect(lines.slice(0, 3).join("\n")).toContain("▄▄▄▄  ▄▄▄▄   ▄▄▄ ▄▄▄▄▄▄ ▄▄ ▄▄ ▄▄ ▄▄")
    expect(lines.at(-1)).toMatch(/^\d+\.\d+\.\d+/)
  })
  test("--help prints usage", async () => {
    const r = await run("--help")
    expect(r.code).toBe(0)
    expect(r.out).toContain("usage: brothy")
    expect(r.out).toContain("--transparent")
    expect(r.out).toContain("-h, --help")
  })
  test("--help lists the theme families on lines that fit 80 columns", async () => {
    const r = await run("--help")
    expect(r.out).toMatch(/brothy, catppuccin, dracula/)
    expect(r.out).toContain("one,")
    expect(r.out).toContain("vesper")
    expect(r.out).not.toContain("catppuccin-light")
    for (const l of r.out.split("\n")) expect(l.length, l).toBeLessThanOrEqual(80)
  })
  test("unknown flag exits 1 with a clean message", async () => {
    const r = await run("--bogus")
    expect(r.code).toBe(1)
    expect(r.err).toContain("--bogus")
    expect(r.err).not.toContain("at ")
  })
  test("a family name passes the theme check", async () => {
    const r = await run("-t", "one", "/definitely/not/here")
    expect(r.code).toBe(1)
    expect(r.err).toContain("no such file")
  })
  test("unknown theme exits 1", async () => {
    const r = await run("-t", "nope", "examples")
    expect(r.code).toBe(1)
    expect(r.err).toContain("nope")
  })
  test("missing path exits 1", async () => {
    const r = await run("/definitely/not/here")
    expect(r.code).toBe(1)
    expect(r.err).toContain("no such file")
  })
  test("refuses to start without a terminal", async () => {
    const r = await run("examples")
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/terminal/)
    expect(r.err).not.toContain("at ")
  })
  test("a path that is neither file nor folder exits 1", async () => {
    const r = await run("/dev/null")
    expect(r.code).toBe(1)
    expect(r.err).toContain("not a file or folder")
    expect(r.err).not.toMatch(/terminal/)
  })
  test("a FIFO exits 1", async () => {
    const d = tmp()
    execFileSync("mkfifo", [join(d, "p")])
    const r = await run(join(d, "p"))
    expect(r.code).toBe(1)
    expect(r.err).toContain("not a file or folder")
  })
  test("an unreadable folder exits 1 with the reason", async () => {
    const d = tmp()
    const dir = join(d, "locked")
    mkdirSync(dir)
    chmodSync(dir, 0o000)
    try {
      if (process.getuid?.() === 0) return // root reads anything
      const r = await run(dir)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/cannot read .*EACCES|permission denied/i)
    } finally {
      chmodSync(dir, 0o700)
    }
  })
  // util-linux setsid detaches /dev/tty; macOS has no setsid
  test.skipIf(!Bun.which("setsid"))("- without a terminal for keys exits 1 with the reason", async () => {
    // no controlling terminal: setsid detaches /dev/tty
    const p = Bun.spawn(["setsid", "-w", "bun", cli, "-"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob(["# hi\n"]),
    })
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    expect(code).toBe(1)
    expect(err).toContain("brothy:")
    expect(err).toMatch(/terminal/)
    expect(err).not.toContain("at ")
  })
  test("--help documents -", async () => {
    expect((await run("--help")).out).toContain("-              read Markdown from stdin")
  })
})
