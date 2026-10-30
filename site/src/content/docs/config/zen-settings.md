---
title: Zen settings
description: "The zen block of config.json and its defaults."
---

The `zen` key holds the settings of [zen mode](/brothy/usage/zen-mode/). Change them with <kbd>Z</kbd> or by hand; missing or invalid fields fall back to the defaults. Zen itself always starts off.

| Field | Values | Default |
| --- | --- | --- |
| `flow` | `"scroll"` or `"pages"` | `"scroll"` |
| `spotlight` | boolean | `true` |
| `typewriter` | boolean | `true` |
| `ghost` | boolean | `true` |
| `prompter` | boolean | `false` |
| `wpm` | 120–400 | `220` |
| `measure` | 60–100, or `"full"` for the whole pane minus a 2-column margin (<kbd>&gt;</kbd> past 100 reaches it) | `72` |

```json
{ "zen": { "flow": "pages", "measure": 80 } }
```
