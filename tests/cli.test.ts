import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = join(import.meta.dir, "../src/cli.tsx")
const root = join(import.meta.dir, "..")
async function run(...args: string[]) {
  const p = Bun.spawn(["bun", cli, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [out, errText, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err: errText, code }
}

describe("cli", () => {
  test("--version prints and exits 0", async () => {
    const r = await run("--version")
    expect(r.code).toBe(0)
    const lines = r.out.trimEnd().split("\n")
    expect(lines.slice(0, 3).join("\n")).toContain("┏┓ ┳━┓┏━┓╺┳╸╻ ╻╻ ╻")
    expect(lines.at(-1)).toMatch(/^\d+\.\d+\.\d+/)
  })
  test("--help prints usage", async () => {
    const r = await run("--help")
    expect(r.code).toBe(0)
    expect(r.out).toContain("usage: brothy")
    expect(r.out).toContain("--transparent")
  })
  test("--help lists dark and light themes on lines that fit 80 columns", async () => {
    const r = await run("--help")
    expect(r.out).toMatch(/dark:\s+brothy, catppuccin/)
    expect(r.out).toMatch(/light:\s+brothy-light, catppuccin-light/)
    for (const l of r.out.split("\n")) expect(l.length, l).toBeLessThanOrEqual(80)
  })
  test("unknown flag exits 1 with a clean message", async () => {
    const r = await run("--bogus")
    expect(r.code).toBe(1)
    expect(r.err).toContain("--bogus")
    expect(r.err).not.toContain("at ")
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
    const d = mkdtempSync(join(tmpdir(), "brothy-cli-"))
    try {
      execFileSync("mkfifo", [join(d, "p")])
      const r = await run(join(d, "p"))
      expect(r.code).toBe(1)
      expect(r.err).toContain("not a file or folder")
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
  test("an unreadable folder exits 1 with the reason", async () => {
    const d = mkdtempSync(join(tmpdir(), "brothy-cli-"))
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
      rmSync(d, { recursive: true, force: true })
    }
  })
})
