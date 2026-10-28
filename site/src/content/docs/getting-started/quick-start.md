---
title: Quick start
description: "Open a folder, a single note or a pipe, and learn the four keys that get you around."
---

<!-- Mirrors README § Quick start: update both. -->

```sh
brothy                # browse the current folder
brothy ~/notes        # browse a folder
brothy README.md      # open one file (its folder fills the panel)
brothy -t dracula     # pick a theme (a family name opens its dark theme: -t one)
curl -s … | brothy    # read a pipe
```

Then <kbd>?</kbd> for the hints and <kbd>?</kbd> again for every key, <kbd>ctrl+p</kbd> to go anywhere, <kbd>t</kbd> for themes, <kbd>z</kbd> for zen. The full list is on the [keyboard reference](/brothy/keys/).

From a source checkout use `bun run start [path]` (or `bun run dev` for `./examples`).

## Usage

```
usage: brothy [path] [--theme <name>] [--transparent]
       command | brothy [-]

  path           a Markdown file or a folder to browse (default: .)
  -              read Markdown from stdin (also when piped and no path is given)
  -t, --theme    a family (its dark theme) or a theme: <family>-light, one-dark
                 brothy, catppuccin, dracula, tokyonight, gruvbox, solarized,
                 rosepine, everforest, kanagawa, nord, github, one, flexoki,
                 ayu, cyberdream, iceberg, melange, nightfox, nightowl,
                 oxocarbon, synthwave84 (dark only), vesper (dark only)
  --transparent  let the terminal background show through (toggle: T)
  -h, --help     show this help
  -v, --version  print version
```

brothy takes **at most one path**: `brothy a.md b.md` is an error, not "last one wins" (use `--` before a path that starts with `-`). Unknown options, `-t` without a value and unknown theme names are errors too, and it needs an interactive terminal (stdin and stdout must be a TTY).

For a pipe, see [Pipes & editor](/brothy/usage/pipes-and-editor/).
