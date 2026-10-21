# Getting started

## Install

Clone the repository and install dependencies with Bun:

```sh
git clone https://example.com/brothy.git
cd brothy && bun install
```

## Open a folder

Point brothy at any folder. It scans for `.md` files recursively and skips `node_modules` and hidden folders.

## Open a single file

```ts
// brothy accepts a file path too
const target = process.argv[2] ?? "."
console.log(`opening ${target}`)
```

### Themes

Thirteen theme families ship by default, each with a dark and a light variant (brothy, brothy-light, catppuccin, catppuccin-light and so on). Your choice is remembered in `~/.config/brothy/config.json`.
