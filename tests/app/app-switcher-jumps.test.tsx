// App: where C-p lands when the note under an Ask answer changed since it was indexed, and what the peek pane follows.
import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type aiStub, filler, keys, OLLAMA, type Setup, useAppHarness, W120, waitFor, waitFrame } from "./helpers"

const { tmp, aiConfig, mountAI } = useAppHarness()

/** `?<question>`, ⏎; the stub replies with `queries`. Resolves with the frame once Answers show. */
async function ask(
  s: Setup,
  ai: ReturnType<typeof aiStub>,
  queries: string[],
  question = "where does the soup simmer",
) {
  await keys(s, "C-p", `type:?${question}`)
  await waitFrame(s, (f) => f.includes("⏎ ask"))
  await keys(s, "enter")
  await waitFor(s, () => ai.calls.length === 1)
  ai.send(0, JSON.stringify({ queries }))
  ai.end(0)
  return waitFrame(s, (f) => f.includes("Answers"))
}

const SOUP = `# Soup\n\nIntro.\n\n## Simmering\n\n${filler(40)}\n\nKeep the broth at a gentle simmer.\n`

test("an answer whose line was edited away opens at its heading, with no find and no toast", async () => {
  aiConfig(OLLAMA)
  const d = tmp({ "README.md": "# README\n", "soup.md": SOUP })
  const { s, ai } = await mountAI(d, "README.md", { size: W120 })
  await ask(s, ai, ["gentle simmer"])
  writeFileSync(
    join(d, "soup.md"),
    readFileSync(join(d, "soup.md"), "utf8").replace("Keep the broth at a gentle simmer.", "Keep the broth warm."),
  )
  const f = await keys(s, "enter")
  expect(f).not.toContain("Ask")
  expect(f).not.toContain("heading gone")
  expect(f).not.toContain("/gentle simmer")
  expect(f.split("\n")[2]).toContain("Simmering")
})

test("an answer from the lead-in whose line was edited away just opens the note", async () => {
  aiConfig(OLLAMA)
  const d = tmp({
    "README.md": "# README\n",
    "lead.md": "Zebra stripes are mentioned only here.\n\n# Title\n\nBody.\n",
  })
  const { s, ai } = await mountAI(d, "README.md", { size: W120 })
  await ask(s, ai, ["zebra"], "which animal has stripes")
  writeFileSync(join(d, "lead.md"), "Nothing about animals.\n\n# Title\n\nBody.\n")
  const f = await keys(s, "enter")
  expect(f).not.toContain("Ask")
  expect(f).not.toContain("heading gone")
  expect(f).toContain("Nothing about animals.")
})

test("C-p peek follows the highlighted Ask answer's note", async () => {
  aiConfig(OLLAMA)
  const d = tmp({
    "README.md": "# README\n",
    "soup.md": "# Soup\n\n## Simmering\n\nKeep the broth at a gentle simmer.\n",
    "bread.md": "# Bread\n\n## Proofing\n\nLet the dough rest, a gentle proof.\n",
  })
  const { s, ai } = await mountAI(d, "README.md", { size: { width: 120, height: 34 } })
  const first = await ask(s, ai, ["gentle"], "what is gentle")
  expect(first).toContain("bread.md") // the first answer is highlighted: its note is in the pane
  expect(first).toContain("Let the dough rest, a gentle proof.")
  const second = await keys(s, "down")
  expect(second).toContain("soup.md")
  expect(second).toContain("Keep the broth at a gentle simmer.")
  expect(second).not.toContain("a gentle proof")
  const action = await keys(s, "down") // the rerank row points at no note: the pane has nothing to show
  expect(action).not.toContain("soup.md")
  expect(action).not.toContain("a gentle simmer.")
})
