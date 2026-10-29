// `changeRows`: the rows `⏎` on a Changed row scrolls within, in the view as it is now.
import { expect, test } from "bun:test"
import { diffSections, type Change } from "../../src/ai/delta"
import { changeRows } from "../../src/app/actions"
import { render } from "../../src/markdown/render"
import { brothy } from "../helpers/theme"

const AFTER = "lead in\n\n# One\n\na two\n\n# Two\n\nb\n"
const view = render(AFTER, 80, brothy)
const [one, two] = view.headings
/** The single change from `before` to AFTER. */
const changeFrom = (before: string): Change => diffSections(before, AFTER)![0]!

test("a section's rows run from its heading to the next one", () => {
  expect(changeRows(view, changeFrom("lead in\n\n# One\n\na\n\n# Two\n\nb\n"))).toEqual({ from: one!.line, to: two!.line })
})

test("the last section runs to the end of the view; the lead-in from the top to the first heading", () => {
  expect(changeRows(view, changeFrom("lead in\n\n# One\n\na two\n\n# Two\n\nc\n"))).toEqual({ from: two!.line, to: view.lines.length })
  expect(changeRows(view, changeFrom("lead\n\n# One\n\na two\n\n# Two\n\nb\n"))).toEqual({ from: 0, to: one!.line })
})

test("a heading that moved since the request was sent is found again by its key", () => {
  const c = { ...changeFrom("lead in\n\n# One\n\na two\n\n# Two\n\nc\n"), index: 0 }
  expect(changeRows(view, c)).toEqual({ from: two!.line, to: view.lines.length })
})

test("a heading found nowhere keeps the change's own index", () => {
  const c = { ...changeFrom("lead in\n\n# One\n\na two\n\n# Two\n\nc\n"), index: 0, key: "gone", path: ["Gone"] }
  expect(changeRows(view, c)).toEqual({ from: one!.line, to: two!.line })
})
