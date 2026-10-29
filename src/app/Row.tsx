// One terminal row of styled spans: the document, panel and chrome all draw through it.
import { safe, type Span } from "../lib/spans"

/** A single unwrapped row; every span's text goes through `safe` on the way out. */
export function Row({ spans, bg }: { spans: Span[]; bg?: string }) {
  return (
    <text bg={bg} wrapMode="none" style={{ height: 1, flexShrink: 0 }}>
      {spans.map((s, i) => (
        <span key={i} fg={s.fg} bg={s.bg} attributes={s.attr ?? 0}>
          {safe(s.text)}
        </span>
      ))}
    </text>
  )
}
