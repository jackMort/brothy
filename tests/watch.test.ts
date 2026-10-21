import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchPath } from "../src/watch"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const f of cleanup.splice(0)) f()
})

function dir() {
  const d = mkdtempSync(join(tmpdir(), "brothy-watch-"))
  cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

async function until(pred: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (pred()) return
  throw new Error("timed out")
}

function watch(path: string, poll?: number, check = 30) {
  const ev = { changes: 0, errors: [] as string[] }
  const close = watchPath(path, { change: () => ev.changes++, error: (m) => ev.errors.push(m) }, { poll, check })
  cleanup.unshift(close)
  return ev
}

test("atomic rename saves keep firing", async () => {
  const d = dir()
  const f = join(d, "a.md")
  writeFileSync(f, "1")
  const ev = watch(f)
  for (const n of [1, 2, 3]) {
    writeFileSync(join(d, ".tmp"), String(n))
    renameSync(join(d, ".tmp"), f)
    await until(() => ev.changes >= n)
  }
  expect(ev.errors).toEqual([])
})

test("bursts of writes are debounced into one change", async () => {
  const d = dir()
  const f = join(d, "a.md")
  writeFileSync(f, "1")
  const ev = watch(f)
  for (let i = 0; i < 5; i++) writeFileSync(f, String(i))
  await until(() => ev.changes >= 1)
  await sleep(150)
  expect(ev.changes).toBe(1)
})

test("changes to sibling files are ignored", async () => {
  const d = dir()
  const f = join(d, "a.md")
  writeFileSync(f, "1")
  const ev = watch(f)
  writeFileSync(join(d, "b.md"), "x")
  await sleep(150)
  expect(ev.changes).toBe(0)
})

test("an event that leaves the file as it was is not a change", async () => {
  // FSEvents (macOS) may replay the file's own creation, or name no file at all; a chmod is the Linux stand-in
  const d = dir()
  const f = join(d, "a.md")
  writeFileSync(f, "1")
  const ev = watch(f)
  chmodSync(f, 0o600)
  await sleep(150)
  expect(ev.changes).toBe(0)
  writeFileSync(f, "2")
  await until(() => ev.changes === 1)
})

test("an unwatchable path reports an error and falls back to polling", async () => {
  const d = dir()
  const f = join(d, "later", "a.md")
  const ev = watch(f, 30)
  expect(ev.errors.length).toBe(1)
  mkdirSync(join(d, "later"))
  writeFileSync(f, "x")
  await until(() => ev.changes >= 1)
})

test("close stops notifications", async () => {
  const d = dir()
  const f = join(d, "a.md")
  writeFileSync(f, "1")
  const ev = { changes: 0 }
  watchPath(f, { change: () => ev.changes++, error: () => {} })()
  writeFileSync(f, "2")
  await sleep(150)
  expect(ev.changes).toBe(0)
})

test("survives the folder being removed and recreated", async () => {
  const d = dir()
  const sub = join(d, "w")
  mkdirSync(sub)
  const f = join(sub, "a.md")
  writeFileSync(f, "1")
  const ev = watch(f)
  rmSync(sub, { recursive: true })
  await sleep(100)
  const before = ev.changes
  mkdirSync(sub)
  writeFileSync(f, "2")
  await until(() => ev.changes > before)
  const mid = ev.changes
  await sleep(100) // let the re-armed watcher settle
  writeFileSync(f, "3")
  await until(() => ev.changes > mid)
})

test("survives the folder being moved away and back", async () => {
  const d = dir()
  const sub = join(d, "w")
  mkdirSync(sub)
  const f = join(sub, "a.md")
  writeFileSync(f, "1")
  const ev = watch(f)
  renameSync(sub, sub + "2")
  await sleep(100)
  renameSync(sub + "2", sub)
  await sleep(100) // the moved folder has a new identity to the watcher
  const before = ev.changes
  writeFileSync(f, "2")
  await until(() => ev.changes > before)
})
