---
title: Obsidian notes
description: "Wikilinks, embeds, callouts, highlights, comments and dataview blocks read cleanly."
---

brothy renders the Obsidian syntax that matters when reading:

- **Callouts** (`> [!warning] Title`) get an icon, a title and a bar in the kind's color. `-` and `+` folds show `▾` and stay open.
- **Highlights**: `==text==` is marked.
- **Comments**: `%%comments%%` are hidden (and never sent to an AI).
- **Dataview**: `dataview`, `dataviewjs` and `tasks` blocks collapse to one row; read them with <kbd>s</kbd>.
- **HTML**: known tags are stripped (`<kbd>` and `<mark>` keep a style, unknown tags stay as text).
- **Wikilinks** show their alias or note name (`Note › Heading` for heading links), muted when no note matches.
- **Embeds**: `![[note]]` shows `↳ note`; image and other file embeds show a `▣ name` placeholder.

Links resolve against the enclosing vault (the nearest folder with `.obsidian/`) when you open a single note inside one, else against the notes in the Files tree. Follow one with <kbd>f</kbd> or from the Info tab.
