---
title: What changed
description: "The Info tab lists the sections changed on disk; D asks a model to explain the change."
---

<!-- Mirrors README § AI (What changed on disk): update both. -->

When the open note changes on disk (an editor, Obsidian, a coding agent), the Info tab lists the changed sections with `+added −removed` line counts and the toast says `reloaded · 2 sections changed`. That list is local and works **without** an `ai` block; it compares with the text the note had when you opened it, held in memory only.

## Explain it

<kbd>D</kbd> sends only the changed hunks and the reply adds one or two sentences about the change and a few words per section, under `Changed` in Info. <kbd>⏎</kbd> on a changed section jumps to it, to the changed line when the reply quoted one.

- Once explained, the baseline moves forward, so the next edit lists anew.
- <kbd>D</kbd> again cancels.
- Past the size cap later sections are listed by heading while they fit, then counted (`… and 12 more sections`); a reply that runs long keeps its summary and the section notes it finished.
- A note over 2 MB is not compared (`reloaded · too large to compare`). The same goes for a reload that rewrites too many lines to compare quickly.
- Explanations are never written to disk.
