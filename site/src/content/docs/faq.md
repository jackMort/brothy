---
title: FAQ
description: "Short answers about platforms, fonts, AI, Obsidian and what brothy is not."
---

## Does it run on Windows?

No: macOS and Linux only (x64 and arm64 binaries).

## The logo is a box.

The bowl in the top line is a Nerd Font glyph. Use a Nerd Font in your terminal or ignore it; nothing else depends on it.

## Does brothy send my notes anywhere?

Not unless you add an `ai` block and press an AI key. With one, each request goes only to the endpoint you configured. [What is sent](/brothy/ai/what-is-sent/) lists every request.

## Can I use a local model?

Yes: Ollama and LM Studio need no key. See [Set up a provider](/brothy/ai/setup/).

## Can it edit notes?

brothy is a reader for a folder of notes, not an editor. <kbd>e</kbd> opens the note in your `$VISUAL` / `$EDITOR` at the line you are reading, and brothy reloads when it exits.

## Does it work with Obsidian vaults?

It reads them: wikilinks, embeds, callouts, highlights, comments and dataview blocks. See [Obsidian notes](/brothy/usage/obsidian-notes/).

## Why does a link look muted?

A wikilink is muted when no note matches it.

## Copying text did not work.

Selecting text copies through OSC 52, so your terminal must allow it.

## How do I change the theme?

<kbd>t</kbd>, or `brothy -t <name>`. See [Theme picker](/brothy/themes/theme-picker/).

## How do I read something from a pipe?

`curl -s … | brothy`. See [Pipes & editor](/brothy/usage/pipes-and-editor/).

## What else is there?

[glow](https://github.com/charmbracelet/glow) (pager and note stash), [mdcat](https://github.com/swsnr/mdcat) (renders to stdout), [frogmouth](https://github.com/Textualize/frogmouth) (Python TUI browser), [bat](https://github.com/sharkdp/bat) (syntax-highlighted cat) and [Obsidian](https://obsidian.md) itself.

## Where do I report a bug?

On [GitHub](https://github.com/jackMort/brothy/issues). Security problems go privately, see [SECURITY.md](https://github.com/jackMort/brothy/blob/main/SECURITY.md).
