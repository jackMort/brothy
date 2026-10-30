---
title: Reading
description: "Preview and Source, find, code highlighting, live reload, the minimap and the mouse."
---

<!-- Mirrors README § Screen (Preview, Source, Minimap) and Features: update both. -->

## Preview

Headings (H1 underlined, H2 and deeper with dim `#` markers), wrapped paragraphs, bold, italic and strikethrough, inline code, links, quotes, nested and ordered lists, task lists, box-drawn tables with alignment, and code blocks with a background and a language label. Text is wrapped at 80 columns at most and centred. Tables shrink to fit; columns that cannot fit at all are replaced by a final `…` column.

## Heading styles

<kbd>#</kbd> cycles how headings are drawn and saves the choice as `headings` in [`config.json`](/brothy/config/config-json/). It applies to the document, zen, the `ctrl+p` peek and the theme picker sample; Source is unchanged.

| Style | Looks like |
| --- | --- |
| `classic` (default) | H1 underlined, H2 and deeper with dim `#` markers |
| `bars` | a level-coloured `█ ▌ ┃ │ ┆ ┊` prefix |
| `ladder` | shade glyphs `██ ▓▓▓ ▒▒▒▒ …` that thin with the level |
| `rules` | H1 and H2 run a rule to the end of the measure, H3 gets `╌╌`, H4–H6 are bold colour only |

## Source

<kbd>s</kbd> swaps in the raw Markdown with line numbers and coloring (the top line shows `source`). Comment lines are muted and callout markers take their kind's colour. Press <kbd>s</kbd> again for the Preview.

## Find

<kbd>/</kbd> finds in the document, <kbd>n</kbd> and <kbd>N</kbd> go to the next and previous match, in Preview or Source. Matches are highlighted and counted in the top line. <kbd>esc</kbd> clears.

## Code highlighting

JavaScript, TypeScript, JSX/TSX and Zig fences are highlighted with OpenTUI's tree-sitter parsers (blocks appear plain for a moment, then fill in; line positions never move). Other languages get a small fallback: comments (only the comment syntax that language uses), strings, numbers and literals. Unknown languages stay plain.

## Live reload

When the open file changes on disk (an editor, Obsidian, a coding agent) brothy reloads it and keeps your place. Each changed section gets a number after its heading (`¹ ² ³`, a removed one's in the margin where it was), the running head says `³ changed`, the Info tab lists them with `+added −removed` line counts and the toast says `reloaded · ³ sections changed`. <kbd>⏎</kbd> on a listed section goes there, and <kbd>[</kbd> <kbd>]</kbd> then walk the changes. The list is local and works without AI; it compares with the text the note had when you opened it, held in memory only. A reload over 2 MB, or one that rewrites too many lines to compare quickly (a formatter run over a long note), says `too large to compare`.

With an `ai` block, <kbd>D</kbd> [explains the change](/brothy/ai/what-changed/).

## Minimap

From 110 columns a braille map of the note sits at the right edge (Preview and Source, never zen): headings in the H1 colour, the part on screen on a lighter band, find hits as dots in a lane beside it. Click to jump; <kbd>m</kbd> hides or shows it (saved as `minimap`).

## Mouse

Click tabs, files and headings, scroll with the wheel. Selecting text copies it to the clipboard (OSC 52, so the terminal must allow it); the ghost line says `copied 3 lines`.
