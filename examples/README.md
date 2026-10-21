---
title: Welcome to brothy
author: you
tags: [markdown, terminal, reader]
---

# Welcome to brothy

**brothy** is a terminal *Markdown reader* with a calm, panel-based interface. Browse a folder of notes on the left, read on the right, and never leave the terminal.

> Good documentation is like a good broth: simmered slowly, served warm.

## Why another reader?

Most terminal pagers dump Markdown as plain text. brothy renders it: headings, lists, tables, code with highlighting, quotes and task lists all get their own treatment, and the layout reflows when you resize.

- Folder tree with fuzzy filter
- Preview, Source, Outline and Info tabs
- Find in document with `n` / `N`
- Live reload when the file changes on disk
  - edit in your editor
  - watch it update here

## Quick start

```bash
bun install
bun src/cli.tsx ~/notes
```

| Key | Action | Where |
|-----|--------|:-----:|
| `tab` | switch focus | anywhere |
| `/` | filter or find | both |
| `[` `]` | jump between headings | document |
| `t` | cycle theme | anywhere |

## Tasks

- [x] Render headings and paragraphs
- [x] Tables with alignment
- [ ] Inline images
- [ ] Mermaid diagrams

---

Made with ~~too much~~ just enough coffee. See [the guides](guides/getting-started.md).
