// `makeSwitcher` over a stub app context: the peek pane's data and where a text hit lands in the open note.
import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { join } from "node:path"
import { textHash } from "../../src/ai/cache"
import { noteText } from "../../src/ai/client"
import { PROMPT_V } from "../../src/ai/config"
import type { AppCtx } from "../../src/app/ctx"
import { makeMemo, type Derived } from "../../src/app/derive"
import { makeSwitcher } from "../../src/app/switcher"
import type { Job } from "../../src/app/store"
import { emptyIndex, indexNote, type SwitchRow, type TextHit } from "../../src/notes/vault"
import type { Span } from "../../src/lib/spans"
import { brothy } from "../helpers/theme"
import { useTmp } from "../helpers/tmp"

const tmp = useTmp("brothy-switcher-")
const text = (lines: Span[][] | undefined) => (lines ?? []).map((l) => l.map((sp) => sp.text).join("")).join("\n")

/** What the stub records: store writes, toasts, scroll targets and selected matches. */
interface Calls {
  set: object[]
  flash: [string, string | undefined][]
  setTop: number[]
  showMatch: number[]
  opened: string[]
}

/** A switcher over a stub context: `derived` is what `derive()` returns; `docs` is the vault index. */
function switcherOver(o: { W?: number; derived?: object; docs?: [string, ReturnType<typeof indexNote>][]; q?: string }) {
  const calls: Calls = { set: [], flash: [], setTop: [], showMatch: [], opened: [] }
  const ix = emptyIndex()
  for (const [p, doc] of o.docs ?? []) ix.docs.set(p, doc)
  const ui = { current: { switcher: { q: o.q ?? "", hl: 0, top: 0 } } as Record<string, unknown> }
  const ctx = {
    ui,
    set: (patch: object) => (calls.set.push(patch), Object.assign(ui.current, patch)),
    bump: () => {},
    derive: () => o.derived,
    memo: makeMemo(undefined),
    W: o.W ?? 120,
    vault: { current: { ix, running: false } },
    jobs: { current: new Map<string, Job>() },
    timers: { current: {} },
    alive: { current: true },
    fetchImpl: globalThis.fetch,
    askMemo: { current: new Map() },
    rerankMemo: { current: new Map() },
    flash: (msg: string, kind?: string) => calls.flash.push([msg, kind]),
    openFile: (p: string) => calls.opened.push(p),
    focusDoc: () => {},
    setTop: (n: number) => calls.setTop.push(n),
    showMatch: (m: number) => calls.showMatch.push(m),
  } as unknown as AppCtx
  return { sw: makeSwitcher(ctx, { ensureLinks: () => {} }), calls }
}

describe("peekPane", () => {
  const BODY = "# Beta notes\n\nPeek body line.\n\n## Part\n\nmore words\n"
  /** A note on disk, its index entry, and the `Derived` slice peekPane reads with `row` highlighted. */
  function peekSetup(row: (path: string) => SwitchRow | undefined, summary?: (hash: string) => object) {
    const root = tmp({ "notes/beta.md": BODY })
    const path = join(root, "notes/beta.md")
    const doc = indexNote(BODY, statSync(path).mtimeMs, BODY.length)
    const hash = textHash(noteText(BODY))
    const s = {
      switcher: { q: "beta", hl: 0, top: 0 },
      linkTree: { path: root, name: "", rel: "", dir: true, children: [] },
      headingStyle: "classic",
      summaries: summary ? { [path]: summary(hash) } : {},
    }
    const d = { s, swRows: [row(path)], swHl: 0, t: brothy, L: { PH: 20 } } as unknown as Derived
    return { path, doc, d }
  }
  const noteRow = (path: string): SwitchRow => ({ kind: "note", path, name: "beta", folder: "notes", hits: [] }) as unknown as SwitchRow

  test("nothing without the switcher open, or below PEEK_MIN_W", () => {
    const { path, doc, d } = peekSetup(noteRow)
    expect(switcherOver({ W: 99, docs: [[path, doc]] }).sw.peekPane(d)).toBeUndefined()
    const closed = { ...d, s: { ...d.s, switcher: null } } as unknown as Derived
    expect(switcherOver({ docs: [[path, doc]] }).sw.peekPane(closed)).toBeUndefined()
  })

  test("a note row: its path relative to the link tree, its outline and the body read from disk", () => {
    const { path, doc, d } = peekSetup(noteRow)
    const out = text(switcherOver({ docs: [[path, doc]] }).sw.peekPane(d))
    expect(out).toContain("notes/beta.md")
    expect(out).toContain("Beta notes")
    expect(out).toContain("└ Part")
    expect(out).toContain("Peek body line.")
    expect(out).not.toContain("TL;DR")
  })

  test("a fresh TL;DR shows with its short model; an outdated one is left out", () => {
    const fresh = peekSetup(noteRow, (hash) => ({ hash, v: PROMPT_V, summary: "Beta is about peeking.", model: "llama3.2", at: 1 }))
    const out = text(switcherOver({ docs: [[fresh.path, fresh.doc]] }).sw.peekPane(fresh.d))
    expect(out).toContain("TL;DR · llama3.2")
    expect(out).toContain("Beta is about peeking.")
    const stale = peekSetup(noteRow, () => ({ hash: "not-the-hash", v: PROMPT_V, summary: "Stale words.", model: "llama3.2", at: 1 }))
    expect(text(switcherOver({ docs: [[stale.path, stale.doc]] }).sw.peekPane(stale.d))).not.toContain("Stale words.")
  })

  test("a note not indexed yet says so, with no body; a row with no note peeks at nothing", () => {
    const { d } = peekSetup(noteRow)
    const out = text(switcherOver({}).sw.peekPane(d))
    expect(out).toContain("indexing…")
    expect(out).not.toContain("Peek body line.")
    const none = peekSetup(() => undefined)
    expect(switcherOver({}).sw.peekPane(none.d)).toEqual([])
  })

  test("a heading hit's body starts at its heading", () => {
    const partRow = (p: string) => ({ kind: "heading", path: p, name: "beta", folder: "notes", heading: 1, text: "Part", hits: [] }) as unknown as SwitchRow
    const { path, doc, d } = peekSetup(partRow)
    const out = text(switcherOver({ docs: [[path, doc]] }).sw.peekPane(d))
    expect(out).toContain("more words")
    expect(out).not.toContain("Peek body line.")
  })
})

describe("jumpToText (⏎ on a text hit)", () => {
  // source lines: 0 # One, 2 apple, 4 apple, 6 # Two, 8 apple
  const SRC = "# One\n\napple\n\napple\n\n# Two\n\napple\n"
  const PATH = "/notes/a.md"
  const doc = indexNote(SRC, 0, SRC.length)
  const hit = (heading: number | null, line: number): TextHit => ({ kind: "text", path: PATH, name: "a", folder: "", heading, line, context: "", hits: [] })
  /** Activate text hit `row` with `matches` as find's result in a view whose headings start at rows 0 and 10. */
  function activate(row: TextHit, matches: number[], source = false) {
    const derived = {
      swRows: [row],
      question: null,
      s: { source },
      matches,
      view: { headings: [{ line: 0 }, { line: 10 }], srcRow: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
    }
    const r = switcherOver({ derived, docs: [[PATH, doc]], q: " apple " })
    r.sw.swActivate(0)
    return r.calls
  }

  test("it opens the note, sets the trimmed query and selects the hit's own occurrence in its section", () => {
    const calls = activate(hit(0, 4), [2, 4, 12])
    expect(calls.opened).toEqual([PATH])
    expect(calls.set).toContainEqual({ query: "apple", matchLine: null })
    expect(calls.showMatch).toEqual([4])
  })

  test("the first occurrence in the section, and in the next section from its heading", () => {
    expect(activate(hit(0, 2), [2, 4, 12]).showMatch).toEqual([2])
    expect(activate(hit(1, 8), [2, 4, 12]).showMatch).toEqual([12])
  })

  test("an ordinal past the section's matches takes its last one", () => {
    expect(activate(hit(0, 4), [3, 12]).showMatch).toEqual([3])
  })

  test("Preview with no match in the section takes the next one after it; none at all scrolls to the section and toasts", () => {
    expect(activate(hit(0, 4), [12]).showMatch).toEqual([12])
    const calls = activate(hit(1, 8), [2])
    expect(calls.showMatch).toEqual([])
    expect(calls.setTop).toEqual([10])
    expect(calls.flash).toEqual([["“apple” is not in the preview · s shows the source", "error"]])
  })

  test("a hit before the first heading counts from the top", () => {
    expect(activate(hit(null, 2), [1, 5]).showMatch).toEqual([1])
  })

  test("Source starts at the hit's source row and takes the first match from there", () => {
    expect(activate(hit(0, 4), [2, 4, 8], true).showMatch).toEqual([4])
    const calls = activate(hit(1, 8), [2], true)
    expect(calls.setTop).toEqual([8])
    expect(calls.flash).toEqual([["no match for “apple”", "error"]])
  })
})
