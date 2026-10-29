// `deltaOutcome`: what a finished `D` request leaves for the Changed block.
import { expect, test } from "bun:test"
import { diffSections } from "../../src/ai/delta"
import { deltaOutcome } from "../../src/app/ai-jobs"

const changes = diffSections("# One\n\nold line\n", "# One\n\nnew line here\n")!

test("a usable reply is the explanation", () => {
  const out = deltaOutcome({ ok: true, text: "Rewords it.\n§1: new wording", raw: "" }, "", changes)
  expect(out).toEqual({ parsed: { summary: "Rewords it.", notes: [{ what: "new wording" }] } })
})

test("a reply with nothing usable in it is an invalid failure", () => {
  expect(deltaOutcome({ ok: true, text: "§7: no such section", raw: "" }, "", changes)).toEqual({ failure: { kind: "invalid" } })
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
