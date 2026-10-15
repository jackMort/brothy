<div align="center">

```
┏┓ ┳━┓┏━┓╺┳╸╻ ╻╻ ╻
┣┻┓┣┳┛┃ ┃ ┃ ┣━┫┗┳┛
┗━┛╹┗╸┗━┛ ╹ ╹ ╹ ╹
```

**A calm terminal Markdown reader.** Folder tree, outline, live reload, Obsidian-flavored, 26 themes.

[![CI](https://github.com/jackMort/brothy/actions/workflows/ci.yml/badge.svg)](https://github.com/jackMort/brothy/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jackMort/brothy)](https://github.com/jackMort/brothy/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

![brothy showing a folder tree beside a rendered note with a callout, highlighted code and a table](docs/screenshot.png)

</div>

brothy is styled after [Noodle](https://noodlerest.dev): a top line that says
where you are, a tabbed panel (Files / Outline / Info), the document at a
readable 80-column measure, and a quiet progress line. Built the same way
Noodle is: Bun, TypeScript, React and [OpenTUI](https://github.com/anomalyco/opentui).

## Features

- Files / Outline / Info panel with fuzzy filter, folder counts and a reading marker
- Preview and raw Source views, find in document, live reload on save
- Obsidian notes: wikilinks, embeds, callouts, `==highlights==`, `%%comments%%`, dataview blocks
- `ctrl+p` switcher over the whole vault (notes, headings, text) and `o` to open recent projects or any path
- `f` labels the links on screen; `H` / `L` go back and forward through the notes you opened
- 26 themes (13 dark/light pairs) with live preview, plus a transparent background
- Zen mode: only the text, with scroll or pages flow, spotlight, typewriter and teleprompter
- Syntax-highlighted code blocks, tables that shrink to fit, mouse support

## Screenshots

<table>
<tr>
<td><img src="docs/switcher.png" alt="The Ctrl-P switcher finding a heading across notes"></td>
<td><img src="docs/open.png" alt="The Open picker listing recent projects"></td>
</tr>
<tr>
<td><img src="docs/zen.png" alt="Zen mode: only the text, centred"></td>
<td><img src="docs/outline-light.png" alt="brothy's Outline panel in the light theme"></td>
</tr>
<tr>
<td colspan="2"><img src="docs/links.png" alt="Link labels overlaid on links, to follow one by key"></td>
</tr>
</table>

## Install

Requirements: macOS or Linux (Windows is not supported) and a terminal with true
color and Unicode.

**Binary** — download `brothy-<os>-<arch>` for your platform (`linux` or `darwin`,
`x64` or `arm64`) and `SHA256SUMS` from the
[releases page](https://github.com/jackMort/brothy/releases), then:

```sh
sha256sum -c --ignore-missing SHA256SUMS     # shasum -a 256 -c on macOS
chmod +x brothy-linux-x64
mv brothy-linux-x64 ~/.local/bin/brothy        # any folder on your PATH
```

On macOS you may need to clear the quarantine flag first:
`xattr -d com.apple.quarantine brothy-darwin-arm64`.

**From source** (needs [Bun](https://bun.sh) 1.4 or newer):

```sh
git clone https://github.com/jackMort/brothy.git && cd brothy
bun install
bun run build                # single binary ./brothy, parsers embedded
```

brothy is not published to npm; releases ship prebuilt binaries only.

## Quick start

```sh
brothy                # browse the current folder
brothy ~/notes        # browse a folder
brothy README.md      # open one file (its folder fills the panel)
brothy -t dracula     # pick a theme
```

From a source checkout use `bun run start [path]` (or `bun run dev` for `./examples`).

```
usage: brothy [path] [-t <name>] [--transparent]

  path           one Markdown file or folder (default: .)
  -t, --theme    a theme name (see Themes)
  --transparent  let the terminal background show through (toggle: T)
  -h, --help     usage
  -v, --version  print version
```

`brothy` takes **at most one path**: `brothy a.md b.md` is an error, not "last one
wins" (use `--` before a path that starts with `-`). Unknown options, `-t`
without a value and unknown theme names are errors too, and it needs an
interactive terminal (stdin and stdout must be a TTY).

## Screen

```
 examples / README › Why another reader?                          /the 2/7   source
 
  1 Files   2 Outline   3 Info      ## Why another reader?
 ───━━━━━───────────────────────
  ▸ guides                     2    Most terminal pagers dump Markdown as plain text.
  ▸ notes                      1    brothy renders it: headings, lists, tables, code
  ● README                          with highlighting, quotes and task lists.
    CHANGELOG
                                    • Folder tree with fuzzy filter
                                    • Find in document with n / N
 
 ↑↓ move   ⏎ open   h l fold   / filter   1 2 3 view   tab document   ? keys
 ────────────────────────────────────────────────────────────  34% · 3 min left
```

- **Top line** — a running head. The bowl logo (a Nerd Font glyph) at column 0 is muted while the file is
  watched, bright for a second after a live reload and gone while the file is
  missing. Over the panel sits the note's folder (`Home / … / Onion Soups`
  when it is long; the vault name for a root note). From the text's left edge:
  title › section, the title dimmed while the note's own heading is on screen.
  At the text's right edge: `/query i/n` while a search is active, `source` and
  `wide`. A faint rule under it spans the text column. Without the panel
  (drawer, `^b`) the folder joins the title and is the first thing dropped.
- **Panel** — `1 2 3` switch between Files, Outline and Info. Files expands
  only the open note's path, shows folder counts, and `-` tidies the tree; `/`
  filters inline with ranked results. Outline marks the heading you are
  reading. Info shows properties, tags, links and stats. Below 100 columns the
  panel becomes a drawer with a scrim.
- **Ghost line** — key hints that appear when the context changes and then
  fade; also shows toasts.
- **Progress line** — `34% · 3 min left`.
- **Scan** — recursive scan for `.md`/`.markdown`/`.mdx`, skipping
  `node_modules` and hidden folders (except `.github`); symlinked folders are
  followed once, never in a loop. Collapsible folders, README first. A scan
  stops after 20,000 directory entries (so `brothy ~` stays responsive) and the
  panel says "scan stopped at 20k entries — some notes missing".
- **Preview** — headings (H1 underlined, H2+ with dim `#` markers), wrapped
  paragraphs, bold/italic/strikethrough, inline code, links, quotes, nested and
  ordered lists, task lists, box-drawn tables with alignment, and code blocks
  with a background and language label. Wrapped at 80 columns at most and
  centered. Tables shrink to fit; columns that cannot fit at all are replaced
  by a final `…` column.
  Obsidian notes read cleanly: callouts (`> [!warning] Title`) get an icon, a
  title and a bar in the kind's color (`-`/`+` folds show `▾` and stay open),
  `==highlights==` are marked, `%%comments%%` are hidden, `dataview`,
  `dataviewjs` and `tasks` blocks collapse to one row (read them with `s`), and
  known HTML tags are stripped (`<kbd>` and `<mark>` keep a style, unknown tags
  stay as text).
  Wikilinks show their alias or note name (`Note › Heading` for heading links;
  muted when no note matches); `![[note]]` embeds show `↳ note`, image and other
  file embeds a `▣ name` placeholder.
- **Code highlighting** — JavaScript, TypeScript, JSX/TSX and Zig fences are
  highlighted with OpenTUI's tree-sitter parsers (blocks appear plain for a
  moment, then fill in; line positions never move). Other languages get a
  small fallback: comments (only the comment syntax that language uses),
  strings, numbers and literals. Unknown languages stay plain.
- **Source** — `s` swaps in the raw Markdown with line numbers and coloring
  (the top line shows `source`). Comment lines are muted and callout markers
  take their kind's color.
- Find in document with `/`, `n`, `N` (Preview or Source); matches are
  highlighted and counted in the top line.
- Live reload when the open file changes on disk.
- Themes: 13 families, each with a dark theme and a `-light` twin (`t` opens a picker, dark
  themes first, with live preview; `⏎` keeps and saves to `~/.config/brothy/config.json`, `esc` reverts).
  The choice is always explicit, brothy does not follow the terminal's colors.
  - dark: brothy, catppuccin, dracula, tokyonight, gruvbox, solarized, rosepine, everforest,
    kanagawa, nord, github, one-dark, flexoki
  - light: brothy-light, catppuccin-light (latte), dracula-light, tokyonight-light (day),
    gruvbox-light, solarized-light, rosepine-light (dawn), everforest-light, kanagawa-light
    (lotus), nord-light, github-light, one-light, flexoki-light
- Mouse: click tabs, files and headings, scroll with the wheel.

## Keys

| Key | Action |
| --- | --- |
| `tab` | panel ⇄ document |
| `1` `2` `3` | Files · Outline · Info view |
| `h` · `l` | focus the panel · peek (Outline) / expand |
| `-` | Files: tidy the tree (collapse all but the open note's path) |
| `s` | toggle Source / Preview |
| `w` | full width / 80-column measure (saved) |
| `T` | transparent background: the terminal's own shows through; popups, the drawer and code blocks stay painted (saved) |
| `z` | zen mode: only the text, centered (`esc` leaves; `s` shows the normal Source view) |
| `Z` | zen settings popup (`↑↓` row, `space` toggle, `←→` adjust, `⏎` save, `esc` revert) |
| `<` `>` · `+` `-` | in zen: narrower / wider text · teleprompter faster / slower (saved at once) |
| `/` | filter notes (panel focused) · find in document (`↑↓` pick a row, `⏎` apply, `esc` clear) |
| `ctrl+p` | go to a note, heading or text across the vault (`↑↓` pick, `tab` next section, `⏎` open, `esc` close); empty: recent notes |
| `o` | open another project: recent folders (newest first, fuzzy filter) or, for a query starting with `/` `~` `.`, any folder or note (`tab` completes, `⏎` opens: a folder as the workspace, a note on its own, a recent at the note and line it was left at) |
| `j` `k` `↑` `↓` | move / scroll |
| `d` `u` · `space` `b` | half page · full page |
| `g` `G` | top · bottom |
| `[` `]` | previous · next heading |
| `n` `N` | next · previous match |
| `f` | label the links on screen; type a label to open the note (and jump to its heading) · `esc` cancels |
| `⏎` | open, expand or jump |
| `ctrl+b` | hide / show the panel (a drawer below 100 columns) |
| `esc` | per context: clear find / filter · leave zen · close the drawer |
| `t` | theme picker (`↑↓` preview, `⏎` keep, `esc` revert) |
| `H` `L` | back / forward through the notes opened |
| `r` | rescan files and reload |
| `?` | hints; press twice for all keys (`j` `k` scroll, any other key closes) |
| `q` | quit |

## Config

`~/.config/brothy/config.json` (or `$XDG_CONFIG_HOME/brothy/config.json` when
that is an absolute path) holds `theme`, `sidebar`, `wide` (boolean, full-width text), `transparent` (boolean; `--transparent` wins for one run) and `zen`, e.g.
`{"theme": "dracula", "sidebar": {"view": "files", "hidden": false}}`.
`sidebar` replaces the old `folds`; existing `folds` are migrated once and
dropped on the next save.
`zen` holds the zen settings: `flow` (`"scroll"` or `"pages"`), `spotlight`,
`typewriter`, `ghost`, `prompter` (booleans), `wpm` (120–400) and `measure`
(60–100, or `"full"` for the whole pane minus a 2-column margin; `>` past 100 reaches it); missing or invalid fields fall back to the defaults. Zen itself always
starts off. The file is rewritten when you pick a theme, change the panel view or save
zen settings, keeping other keys; a file that does not parse is left untouched.

Recent projects live beside it in `projects.json`: up to 20 entries, newest
first, each with the folder (`root`), the note open when it was left
(`lastNote`), its Preview line (`top`) and when (`at`). The start and every
workspace opened with `o` are recorded, and updated when you switch away or
quit; a single note is recorded under its vault (or folder). The file is
only state: one that does not parse is replaced.

## Alternatives

[glow](https://github.com/charmbracelet/glow) (pager and note stash), [mdcat](https://github.com/swsnr/mdcat) (renders to stdout), [frogmouth](https://github.com/Textualize/frogmouth) (Python TUI browser), [bat](https://github.com/sharkdp/bat) (syntax-highlighted cat) and [Obsidian](https://obsidian.md) itself. brothy is a reader for a folder of notes, not an editor.

## Development

```sh
bun test                                    # markdown, files, config, args, nav, panel, status, zen, watch, highlight, CLI and App tests
bun run typecheck
bun scripts/snapshot.tsx examples           # print a headless frame
bun scripts/snapshot.tsx examples --size 100x30 --keys "tab j s"
```

`src/markdown.ts` turns Markdown (via `marked`'s lexer) into pre-wrapped,
styled terminal lines, so scrolling, heading jumps and search all work on exact
line numbers. `src/highlight.ts` supplies code-block colors (cached; the parser
runs in a worker), `src/App.tsx` is the UI and `src/nav.ts`, `src/panel.ts` and `src/status.ts` its pure helpers.

One OpenTUI quirk worth knowing: the React reconciler doesn't clear style
props that disappear between renders, so conditional branches that render
different boxes in the same spot need distinct `key`s.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Credits

The brothy themes follow Noodle's theme definitions (Apache-2.0). Additional palettes are
adapted from [opencode](https://github.com/sst/opencode) (MIT, © 2025 opencode) and tuned for
contrast (text, muted text and accents 4.5:1 or better on the page background, 3:1 or better
on code blocks); `brothy-light` is original.

## License

[Apache-2.0](LICENSE); see [NOTICE](NOTICE) for attributions.
