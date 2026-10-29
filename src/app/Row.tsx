// One terminal row of styled spans: the document, panel and chrome all draw through it.
import { Line } from "../ui/overlay"

/** A single unwrapped row; every span's text goes through `safe` on the way out. */
export const Row = Line
