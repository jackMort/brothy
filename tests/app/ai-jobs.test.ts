// `deltaOutcome`: what a finished `D` request leaves for the Changed block; `startJob`'s job record and the shared wait tick.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { type ChatReq, type ChatResult, cleanSummary } from "../../src/ai/client"
import type { AITarget } from "../../src/ai/config"
import { diffSections } from "../../src/ai/delta"
import { deltaOutcome, makeJobs } from "../../src/app/ai-jobs"
import type { AppCtx, Timers } from "../../src/app/ctx"
import { type Job, jobKey } from "../../src/app/store"
import { aiStub } from "./helpers"

const changes = diffSections("# One\n\nold line\n", "# One\n\nnew line here\n")!

test("a usable reply is the explanation", () => {
  const out = deltaOutcome({ ok: true, text: "Rewords it.\n§1: new wording", raw: "" }, "", changes)
  expect(out).toEqual({ parsed: { summary: "Rewords it.", notes: [{ what: "new wording" }] } })
})

test("a reply with nothing usable in it is an invalid failure", () => {
  expect(deltaOutcome({ ok: true, text: "§7: no such section", raw: "" }, "", changes)).toEqual({
    failure: { kind: "invalid" },
  })
})

test("a reply cut at MAX_DELTA keeps what had streamed in; with nothing usable it stays too long", () => {
  const tooLong = { ok: false as const, failure: { kind: "tooLong" as const } }
  expect(deltaOutcome(tooLong, "Rewords it.\n§1: new wording\n§1: unfinish", changes)).toEqual({
    parsed: { summary: "Rewords it.", notes: [{ what: "new wording" }] },
  })
  expect(deltaOutcome(tooLong, "", changes)).toEqual({ failure: { kind: "tooLong" } })
})

test("any other failure is passed on; a cancelled request leaves nothing", () => {
  expect(deltaOutcome({ ok: false, failure: { kind: "empty" } }, "", changes)).toEqual({ failure: { kind: "empty" } })
  expect(deltaOutcome({ ok: false, cancelled: true }, "", changes)).toBeNull()
})

// ------------------------------------------------------------- the shared wait tick

describe("startJob and the wait tick", () => {
  const target: AITarget = {
    url: "http://localhost:11434/v1/chat/completions",
    host: "localhost:11434",
    headers: {},
    model: "llama3.2",
    maxChars: 12_000,
  }
  const req: ChatReq = { system: "s", user: "u", maxOut: 1200, clean: cleanSummary }

  /** `makeJobs` over the refs it reads, counting redraws; `done` collects the results. */
  function runner() {
    const ai = aiStub()
    const c = {
      jobs: { current: new Map<string, Job>() },
      timers: { current: {} as Timers },
      alive: { current: true },
      fetchImpl: ai.f,
      bumps: 0,
      bump: () => void c.bumps++,
      set: () => {},
      flash: () => {},
    }
    const done: ChatResult[] = []
    const jobs = makeJobs(c as unknown as AppCtx)
    const start = (id: string, stream = true) =>
      jobs.startJob("tldr", id, target, req, { stream, done: (r) => void done.push(r) })
    return { c, ai, jobs, done, start, job: (id: string) => c.jobs.current.get(jobKey("tldr", id))! }
  }
  /** let the stub's stream reach `chat` (promises only: the timers are fake) */
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 200 && !until(); i++) await Promise.resolve()
  }

  beforeEach(() => void jest.useFakeTimers())
  afterEach(() => void jest.useRealTimers())

  test("a job records when it started, the model asked and that no text came yet", () => {
    const r = runner()
    const at = Date.now()
    r.start("a.md")
    expect(r.job("a.md")).toMatchObject({ kind: "tldr", raw: "", at, model: "llama3.2", live: false })
    expect(r.c.timers.current.wait).toBeDefined()
  })

  test("redraws once a second until the first token, then stops", async () => {
    const r = runner()
    r.start("a.md")
    jest.advanceTimersByTime(1000)
    jest.advanceTimersByTime(1000)
    expect(r.c.bumps).toBe(2)
    await settle(() => r.ai.calls.length > 0)
    r.ai.send(0, "  ") // cleans to nothing: still waiting
    await settle(() => r.job("a.md").raw !== "")
    expect(r.job("a.md").live).toBe(false)
    r.ai.send(0, "A good broth")
    await settle(() => r.job("a.md").live)
    expect(r.job("a.md").live).toBe(true)
    jest.advanceTimersByTime(1000) // the tick already armed fires once more and is not re-armed
    expect(r.c.timers.current.wait).toBeUndefined()
  })

  test("a cancelled or failed job stops it", async () => {
    const r = runner()
    r.start("a.md")
    expect(r.jobs.cancelJob(jobKey("tldr", "a.md"))).toBe(true)
    jest.advanceTimersByTime(1000)
    expect(r.c.timers.current.wait).toBeUndefined()

    r.start("b.md")
    await settle(() => r.ai.calls.length > 1) // stream 0 was the cancelled job's
    r.ai.fail(1, "model not loaded")
    await settle(() => r.done.length > 0)
    expect(r.done[0]).toMatchObject({ ok: false, failure: { kind: "message" } })
    jest.advanceTimersByTime(1000)
    expect(r.c.timers.current.wait).toBeUndefined()
  })

  test("jobs share one tick, on the next whole second of the soonest", () => {
    const r = runner()
    r.start("a.md")
    const tick = r.c.timers.current.wait
    jest.advanceTimersByTime(400)
    r.start("b.md")
    expect(r.c.timers.current.wait).toBe(tick)
    jest.advanceTimersByTime(600) // a's first second
    expect(r.c.bumps).toBe(1)
    jest.advanceTimersByTime(399)
    expect(r.c.bumps).toBe(1)
    jest.advanceTimersByTime(1) // b's first second
    expect(r.c.bumps).toBe(2)
  })

  test("a request that does not stream stays not live and ticks until it ends", async () => {
    const r = runner()
    r.start("a.md", false)
    await settle(() => r.ai.calls.length > 0)
    r.ai.send(0, "Hello")
    r.ai.end(0)
    jest.advanceTimersByTime(1000)
    expect(r.c.timers.current.wait).toBeDefined()
    await settle(() => r.done.length > 0)
    expect(r.done[0]).toMatchObject({ ok: true, text: "Hello" })
    jest.advanceTimersByTime(1000)
    expect(r.c.timers.current.wait).toBeUndefined()
  })

  test("after unmount a tick neither redraws nor re-arms", () => {
    const r = runner()
    r.start("a.md")
    r.c.alive.current = false
    jest.advanceTimersByTime(1000)
    expect(r.c.bumps).toBe(0)
    expect(r.c.timers.current.wait).toBeUndefined()
  })
})
