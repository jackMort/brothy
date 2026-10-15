# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/jackMort/brothy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jackMort/brothy/releases/tag/v0.1.0
