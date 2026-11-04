---
title: Pictures
description: "![alt](img.png) and ![[img.png]] on a line of their own show in the note where the terminal can draw images; p switches pixels and text."
---

A picture alone in its paragraph, `![alt](img/plan.png)` or `![[plan.png]]`, is drawn in the note where the terminal shows images, between the lines it sits in. Elsewhere, or with <kbd>p</kbd> set to text, it is one row: `▣ alt · 1200×800 · ⏎ view`.

PNG, JPEG, GIF, WebP and SVG are read. A picture is never drawn larger than it is, wider than the text or taller than 30 rows, and its aspect is kept. With an alt text, a muted caption sits under it, centred. A `|` size after the alt sets the width in pixels, `![Small|120](img/bowl.png)` or `![[bowl.png|120]]`, or width and height with `|120x80`; a wikilink's other alias is its alt.

## Where pictures are found

A target is looked for next to the note, then from the vault root (the folder you started in when there is no `.obsidian/`), then by file name in the folder tree brothy scanned (the one Files shows: its depth and entry limit apply, dot folders and `node_modules` are skipped), the shortest path first, as Obsidian does for `![[plan.png]]`. A `?query` or `#anchor` after the file name, as in `img.png?raw=true`, is ignored when no file is named that way. A picture outside the root is never read, not even through a symlink. A URL is never fetched: `http:`, `https:` and `data:` images are a row that says `remote image`.

## Seeing a picture larger

<kbd>⏎</kbd> opens the first picture on screen in a sheet: the picture fitted to the popup, upscaled if it is small, with the alt, size and path as the title. <kbd>esc</kbd> or <kbd>q</kbd> closes it. A click on a picture, its caption or its placeholder row opens it too, and so does a label from <kbd>f</kbd>, which labels pictures with links. Where the terminal draws no images the sheet draws the picture in half blocks.

## Pixels or text

In a terminal with the kitty graphics protocol (kitty, Ghostty, WezTerm, iTerm2, Konsole) or sixel (foot, Windows Terminal) pictures are drawn in pixels, sized to the terminal's cells. Everywhere else they are text rows. <kbd>p</kbd> switches between the two and saves the choice as `pictures` in [config.json](/brothy/config/config-json/); where pixels cannot show it says `pictures · pixels unavailable here · text` and saves nothing. The footer offers <kbd>p</kbd> and <kbd>⏎</kbd> only when the note has a picture.

If a picture cannot be drawn in the terminal after all, brothy says `pictures · pixels failed · text instead` and stays in text until you restart. A file that can't be decoded toasts `pictures · <alt> unreadable` once per note.

Inside a multiplexer, pictures depend on what it passes through. brothy asks OpenTUI, which treats tmux as showing no images, so pictures are text there; another multiplexer or a remote session that reports kitty graphics gets pixels, even when the screen you look at cannot show them. When you see blank rows, press <kbd>p</kbd> for text. Unlike the graph, the first open says nothing about it.

## When a picture can't show

The row says why, in the warning colour:

| Reason | Meaning |
| --- | --- |
| `not found` | no such file next to the note, under the root or by name |
| `remote image` | a URL; brothy never fetches |
| `outside the folder` | the file exists but beyond the root |
| `too large` | over 20 MB, a picture over 25 million pixels or 16384 pixels on a side, or an SVG over 40 million pixels |
| `unsupported` | not a picture brothy reads, or a broken header |
| `unreadable` | the file could not be read or decoded |

## Limits

- A picture edited on disk shows the new version after <kbd>r</kbd> or when the note's text changes: image files are not watched.
- <kbd>f</kbd> labels do not run in zen, but <kbd>⏎</kbd> and a click do. Spotlight does not dim pictures.
- An image inside a line of text, or one of several in a paragraph, stays `▣ alt`.
- Source shows the Markdown as written, no pictures. The minimap marks a picture's rows as a solid block.
- SVG text may not show: no fonts are loaded.
