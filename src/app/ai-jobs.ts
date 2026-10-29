// AI jobs: how many run at once, how they are keyed and how often streamed text redraws.

/** AI requests in flight at once, over every kind (TL;DR, gloss, reload explain, ask) */
export const MAX_JOBS = 3
/** What an AI job is for. Its key in `jobs` is `<kind>:<id>` (`tldr:<path>`, `gloss:<sectionId>`, `delta:<path>`), or the bare kind for `ask` (one at a time). */
export type JobKind = "tldr" | "gloss" | "delta" | "ask"
/** The `jobs` key of a job: `<kind>:<id>`, or the bare kind without an id. */
export const jobKey = (kind: JobKind, id?: string) => (id === undefined ? kind : `${kind}:${id}`)
/** A request in flight: its kind, the raw text streamed so far and how to cancel it. */
export interface Job {
  kind: JobKind
  raw: string
  abort: AbortController
}
/** streamed summary text re-renders at most this often (ms) */
export const AI_FRAME = 100
