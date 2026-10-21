---
title: Simmering notes
tags: [demo, markdown]
aliases: [tour]
---

# Simmering notes

A ==slow read== beats a fast scroll. See [[getting-started]] and [[keybindings]], or the [[2026-10-meeting|last meeting]].

> [!tip] Calm by default
> Callouts, `==highlights==` and `[[wikilinks]]` render the way Obsidian users expect.

## A tiny stock

```ts
type Note = { title: string; links: string[] }

export function backlinks(notes: Note[], title: string) {
  return notes.filter((n) => n.links.includes(title))
}
```

## Heat levels

| Level | Use it for | Time |
|-------|------------|-----:|
| low | reading | 8 min |
| medium | editing | 20 min |
| high | searching | 2 min |

## Later

- [x] Wikilinks
- [ ] Your notes
