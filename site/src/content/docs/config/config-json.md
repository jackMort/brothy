---
title: config.json
description: "Where brothy keeps its settings and what each key does."
---

<!-- Mirrors README § Config: update both. -->

`~/.config/brothy/config.json` (or `$XDG_CONFIG_HOME/brothy/config.json` when that is an absolute path) holds:

| Key | Value |
| --- | --- |
| `ai` | see [AI](/brothy/ai/setup/) |
| `theme` | a theme name, or a family's: `"one"` opens `one-dark`. A name brothy does not know is reported at start and `brothy` stands in |
| `sidebar` | `{ "view": "files", "hidden": false }`: the panel view and whether it is hidden |
| `wide` | boolean, full-width text (<kbd>w</kbd>) |
| `transparent` | boolean (<kbd>T</kbd>); `--transparent` wins for one run |
| `minimap` | boolean, default `true` (<kbd>m</kbd>) |
| `headings` | `"classic"` (default), `"bars"`, `"ladder"` or `"rules"` (<kbd>#</kbd>; [Heading styles](/brothy/usage/reading/#heading-styles)) |
| `motion` | boolean, default `true`; `false` draws the welcome page still, without its ink-in and steam |
| `zen` | the [zen settings](/brothy/config/zen-settings/) |

```json
{"theme": "dracula", "sidebar": {"view": "files", "hidden": false}}
```

`sidebar` replaces the old `folds`; existing `folds` are migrated once and dropped on the next save.

The file is rewritten when you pick a theme, change the panel view or save zen settings, keeping other keys; a file that does not parse is left untouched.

## Other files

- `~/.config/brothy/projects.json`: [recent projects](/brothy/config/recent-projects/).
- `$XDG_CACHE_HOME/brothy/` (else `~/.cache/brothy/`): the AI caches `summaries.json` and `glosses.json`, private to your user. See [Set up a provider](/brothy/ai/setup/).
