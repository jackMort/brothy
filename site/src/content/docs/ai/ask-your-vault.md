---
title: Ask your vault
description: "Start a ctrl+p query with ? to ask a question; brothy finds the sections itself."
---

<!-- Mirrors README § AI (Ask your vault): update both. -->

In <kbd>ctrl+p</kbd>, a query starting with `?` is a question.

1. <kbd>⏎</kbd> on the ask row sends **only the question** (cut at 300 characters). The model returns search terms.
2. The answers are sections brothy finds itself in the vault index, listed as `Answers` with the terms shown (`searched: …`). <kbd>⏎</kbd> opens the section at its first matching line. The model never names a note, heading or line.
3. Optionally, `↻ rerank with excerpts` is a second, separate step: only that row, with its token cost shown first, sends the question plus up to 12 candidate sections (note name, heading path and the first 300 characters of each). The model orders them and says why in a few words.

Nothing from the vault leaves without that row. Ask answers are never written to disk, and one ask runs at a time, counted among the 3 concurrent requests.
