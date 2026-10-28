---
title: TL;DR
description: "Press a to stream a short summary of the note into the Info tab."
---

<!-- Mirrors README § AI (TL;DR): update both. -->

<kbd>a</kbd> sends the current note (body without front matter and `%%comments%%`, cut to `maxChars`); the 2–3 sentence summary streams in at the top of the Info tab.

- Summaries are cached and shown again for free.
- One made before the note changed is shown muted as `outdated · a to refresh`.
- One request per note; <kbd>a</kbd> on a running note cancels it.
- Without an `ai` block, <kbd>a</kbd> says `AI off · set "ai" in config.json`.
- For a piped document the summary lasts for the run and is not cached.

The [`ctrl+p` peek pane](/brothy/usage/navigating-notes/#the-switcher) shows a fresh cached TL;DR without sending anything.
