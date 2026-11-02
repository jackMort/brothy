// A note's outgoing wikilink targets: Info's Links, the vault index and the graph read them. Pure.
import { stripCode } from "../markdown/stats"
import { isMarkdown } from "./files"

/** Distinct outgoing wikilink targets, in order: `[[t]]`, `[[t|alias]]`, `[[t#h]]`, and `![[t]]` embeds of notes. Code is skipped. */
export function extractLinks(body: string): string[] {
  const text = stripCode(body)
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[2]!.split("|")[0]!.split(/[#^]/)[0]!.trim()
    if (!target) continue
    if (m[1] && /\.[^/.]+$/.test(target) && !isMarkdown(target)) continue // images and other files
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}
