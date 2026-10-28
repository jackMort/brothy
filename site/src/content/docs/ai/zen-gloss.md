---
title: Zen gloss
description: "Press a in zen to get a one- or two-sentence gloss of the section you are reading."
---

<!-- Mirrors README § AI (Zen gloss): update both. -->

In [zen](/brothy/usage/zen-mode/), <kbd>a</kbd> explains the section under the reading line in one or two plain sentences, on a muted sheet over the bottom rows of the text. Nothing is inserted into the document. The sheet fades when the reading line leaves the section.

- A gloss already made for an unchanged section shows by itself when you reach it again, without a request.
- One made before the section changed is muted as `outdated · a`; only <kbd>a</kbd> asks for a new one.
- <kbd>esc</kbd> hides the sheet (the next <kbd>esc</kbd> leaves zen); <kbd>a</kbd> while it is loading cancels.
- Glosses are cached in `~/.cache/brothy/glosses.json`; a piped document's are not.

## Style

The style is `ai.gloss`: `"explain"` (default), `"simplify"` or `"translate:<tag>"` (`translate:pl`, `translate:pt-BR`); anything else falls back to `explain`.

```json
"ai": { "provider": "ollama", "model": "llama3.2", "gloss": "translate:pl" }
```
