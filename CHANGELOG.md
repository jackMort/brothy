# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Heading styles: `#` cycles `classic` (the default) → `bars` (a level-colored `█ ▌ ┃ │ ┆ ┊` prefix) → `ladder` (shade glyphs `██ ▓▓▓ ▒▒▒▒ …` that thin with the level) → `rules` (H1 and H2 run a rule to the end of the measure, H3 gets `╌╌`, H4–H6 are bold color only) and saves it as `headings` in `config.json`. It applies to the document, zen, the `ctrl+p` peek and the theme picker sample; Source is unchanged.
- A docs site (Astro Starlight, `site/`) at https://jackmort.github.io/brothy/, drawn as brothy's own screen: the top line, the ¹Files ²Outline ³Info panel (a drawer on phones), the 80-column measure, key hints and a progress line, and brothy's keys on the page (`j k [ ] / 1 2 3 t ^b ?`). The front page is the welcome page (wordmark, bowl and steam from the app's own art) with the recorded tour playing in a frosted window (on a phone a tap opens it full screen, turned sideways); then install, and pages for every feature, the keys, themes, config and AI, built from the README and changelog and deployed by `.github/workflows/pages.yml`. Screenshots come in dark and light and follow the site's theme. It uses only the `brothy` / `brothy-light` palettes, one face (IBM Plex Mono) and a new bowl-and-steam icon, also at the top of the README. (In the repository's Pages settings choose GitHub Actions as the source.)
- `bun run cast` (`scripts/cast.ts`) records the demo as `site/public/casts/tour-{dark,light}.cast` by playing a scripted tour of the real UI headlessly.
- The recorded tour (docs site casts and README videos) shows the AI features too: TL;DR, ask, `D` on a live reload and the zen gloss, answered offline by a stand-in model (`scripts/fakeai.ts`) so recording needs no network or key; `examples/notes/stock.md` is the note they work on. The README shows `docs/demo.mp4` (the gif is its fallback), and the videos are staged like the site demo: the same wallpaper behind a frosted glass window.

## [0.2.0] - 2026-10-28

### Added
- `brothy -` (or `brothy` with a pipe and no path) reads Markdown from stdin: one document titled `stdin`, keys from `/dev/tty`; no Files tree, watcher or project record, and links resolve against the current folder's notes, scanned in the background after the first frame (or on first link use). The panel has only Outline and Info (`1` `2`), also after following a link and coming back with `H`. Input over 5 MB stops with `brothy: input too large (limit 5 MB)` before the rest is read.
- `e` opens the note in `$VISUAL` / `$EDITOR` (fallback `vi`) at the line at the top of the view (exact in Source, from the nearest heading in Preview); VS Code, VSCodium and Cursor get `-g path:line` and Sublime Text `path:line` instead of `+line`. The reader resumes and reloads when the editor exits, and says so when it exits with an error; on a note followed from piped input the editor reads keys from `/dev/tty`.
- Selecting text with the mouse copies it to the clipboard (OSC 52) and says how much.
- Opt-in AI, only on a key press, through an `ai` block in `config.json` (OpenAI, OpenRouter, Anthropic, Gemini, Ollama, LM Studio or any OpenAI-compatible endpoint; keys come from the environment). Up to 3 requests run at once. `r` re-reads the block. A `baseURL` with a query (`?api-version=…`) keeps it.
  - `a` summarizes the current note into a TL;DR at the top of the Info tab; `a` again cancels. Summaries are cached in `~/.cache/brothy/summaries.json` and shown again for free. In stdin mode the summary lasts for the run and is not cached.
  - Zen gloss: `a` in zen explains the section under the reading line in one or two sentences on a muted sheet (nothing is inserted into the text); `esc` hides it. A gloss already made for an unchanged section shows by itself when you reach it again; an outdated one needs `a`. `ai.gloss` picks the style: `explain`, `simplify` or `translate:<tag>`. Glosses are cached in `~/.cache/brothy/glosses.json`.
  - `D` explains what changed on disk since the note was opened: only the changed hunks are sent, and the reply (one or two sentences plus a few words per section) appears under `Changed` in the Info tab; `⏎` on a changed section jumps to it. Past the size cap later sections are listed by heading while they fit, then counted (`… and 12 more sections`); a reply that runs long keeps its summary and the section notes it finished. An explanation is dropped once a reload is too large to compare.
  - `?` in the `ctrl+p` switcher asks your vault a question: `⏎` sends only the question and the model returns search terms; the answers are sections brothy finds itself, and `⏎` opens one at its first matching line (also under a heading with no letters, such as `## ★`). A separate `↻ rerank with excerpts` row (cost shown first) sends up to 12 candidate excerpts to order them.
- A live reload lists the changed sections in the Info tab (`Changed`, with `+added −removed` counts) and the toast says how many (`reloaded · 2 sections changed`). The list is local and works without AI; the baseline is the text the note had when opened, kept in memory only. A reload over 2 MB, or one that rewrites too many lines to compare quickly (a formatter run over a long note), says `too large to compare` instead of freezing the reader.
- Braille minimap at the right edge from 110 columns, in Preview and Source: headings stand out, the part on screen sits on a band, and find hits show in a lane beside it. Click to jump; `m` toggles it (saved as `minimap`). Wide (CJK) characters count by their width.
- `ctrl+p` peek pane from 100 columns: the highlighted note's path and length, its outline around the hit, its TL;DR when a fresh one is cached (the pane never sends a request), and its first lines; only the part shown is rendered, so a note of several MB peeks quickly.
- The keys sheet (`?` twice) groups the keys under Global, Document, Zen, Panel and AI chips, in two columns from 100 columns.
- Welcome page while no note is open (a folder with no Markdown): the wordmark over a bowl of broth with rising steam, the keys to start, and recent projects you can open with `↑↓` `⏎` or a click. The panel, `a`, `s`, `w`, `z` and `Z` keys wait for a note.
- Panel tabs carry their key number (`¹Files ²Outline ³Info`), also in the compact strip; the rule under the open tab is accent while the panel has focus.
- `motion` in `config.json` (default `true`): `false` draws the welcome page still (no ink-in, no rising steam).
- Nine theme families from their upstream palettes (MIT): ayu, cyberdream, iceberg, melange, nightfox (light: dayfox), nightowl (light: Light Owl) and oxocarbon with a dark theme and a `-light` twin, and the dark-only synthwave84 and vesper; 42 themes in 22 families. Roles that missed the contrast floors were nudged in lightness only; oxocarbon-light leads with the dark theme's teal, with a blue secondary, pink errors and orange warnings.
- `--theme` and `theme` in `config.json` take a family name too (`one`, `ayu`): its dark theme, or its only one; `--help` lists the families instead of all 42 names.
- The theme picker handles a family with only one mode: its missing cell on the board and the missing side of the switch are muted and struck through, `tab` / `←` `→` and a click there do nothing, and the pane shows the family's own theme whatever mode you asked for; the next pair shows that mode again.

### Changed
- The theme picker (`t`) lists the 22 families once, with a query to filter them (letters now type, so `j` `k` `g` `G` no longer move; `↑↓` and `ctrl+n` `ctrl+p` do) and a dark / light switch (`tab`, `←` `→`). From 100 columns a pane renders a sample note (marks, links, code, a callout, tasks, a table) in the highlighted theme on its own background. The app no longer re-themes while you move: `⏎` applies and saves, `esc` closes with nothing changed.
- The theme picker's list is a board: a `dark` and a `light` column under a header, each cell a specimen (`Aa` and the primary, secondary and accent dots) in that theme's own colours on its own background, so both twins show without flipping. The cursor is one cell framed in the app's primary (`↑↓` family, `←` `→` or `tab` mode; the footer says `←→ dark/light`), the theme in use keeps a thin muted frame, and a click on a cell applies that theme; hovering does not scroll the board. The list is 41 columns wide and the pane 58 at 120 columns.

### Fixed
- A `theme` in `config.json` that names no theme (`"one"` before family names, or a removed one) is reported at start instead of opening brothy without a word.

### Security
- AI requests go only to the endpoint in your `ai` block: HTTP redirects are refused (`AI: <host> redirects · set baseURL to the final URL`), and neither the key nor custom `ai.headers` is sent over plain `http:` except to localhost. Key and header values are redacted from error toasts.
- Front matter (other than the `title` used as the note name) and `%%comments%%` are never sent. Cache files are private (`0700` folder, `0600` files).

## [0.1.1]

### Fixed
- Sinhala, Malayalam and Devanagari text keeps its zero-width joiners (`ශ්‍රී`, chillu letters, half-forms) instead of showing `�`; a lone or leading joiner and bidi controls are still replaced.
- A paragraph underlined with a single `-` is a heading in the Source outline and the `ctrl+p` switcher too, so heading hits jump to the right place.
- The empty-folder message shows the folder name with control characters replaced.

## [0.1.0]

First public release. Renamed to brothy: the command, binary and repo are `brothy`, and config lives in `~/.config/brothy`.

### Added
- Terminal Markdown reader: folder tree (fuzzy filter, folder counts), Preview and Source views, a tabbed Files / Outline / Info panel (a drawer below 100 columns), find in document, live reload, mouse support.
- Layout at an 80-column measure (`w` for full width) with a running-head top line, ghost hints and a progress line.
- Pre-wrapped rendering: tables that shrink to fit, task lists, code blocks with tree-sitter highlighting for JS/TS/JSX/TSX/Zig and a fallback for other languages.
- Obsidian syntax: wikilinks and embeds, callouts, `==highlights==`, `%%comments%%`, collapsed `dataview`/`tasks` blocks, known HTML tags.
- Navigation: note switcher across the vault (`ctrl+p`: notes, headings, text), project opener (`o`), link labels (`f`), back/forward history (`H`/`L`).
- 26 themes (13 dark/light pairs) with a live-preview picker, transparent background (`T`, `--transparent`).
- Zen mode (`z`, settings `Z`): centered text, scroll or pages flow, spotlight, typewriter, teleprompter.
- Prebuilt binaries for Linux and macOS (x64, arm64).

[Unreleased]: https://github.com/jackMort/brothy/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jackMort/brothy/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jackMort/brothy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jackMort/brothy/releases/tag/v0.1.0
