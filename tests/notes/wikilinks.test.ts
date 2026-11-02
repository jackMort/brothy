import { expect, test } from "bun:test"
import { extractLinks } from "../../src/notes/wikilinks"

test("extractLinks: aliases, headings, note embeds; not images, code or self links", () => {
  const body =
    "See [[A]], [[B|alias]], [[C#Heading]], ![[D]], ![[pic.png]], ![[E.md]], [[a]] again, `[[code]]`\n```\n[[fenced]]\n```\n[[#local]]"
  expect(extractLinks(body)).toEqual(["A", "B", "C", "D", "E.md"])
})
