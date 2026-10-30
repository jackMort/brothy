---
title: Install
description: "Download the brothy binary for macOS or Linux, or build it from source with Bun."
---

Requirements: macOS or Linux (Windows is not supported) and a terminal with true color and Unicode.

## Binary

Download `brothy-<os>-<arch>` for your platform (`linux` or `darwin`, `x64` or `arm64`) and `SHA256SUMS` from the [releases page](https://github.com/jackMort/brothy/releases), then:

```sh
sha256sum -c --ignore-missing SHA256SUMS     # shasum -a 256 -c on macOS
chmod +x brothy-linux-x64
mv brothy-linux-x64 ~/.local/bin/brothy        # any folder on your PATH
```

Or fetch it straight from the latest release (pick your platform):

```sh
curl -fLo brothy https://github.com/jackMort/brothy/releases/latest/download/brothy-linux-x64
chmod +x brothy && mv brothy ~/.local/bin/brothy
```

:::note[macOS]
You may need to clear the quarantine flag first: `xattr -d com.apple.quarantine brothy-darwin-arm64`.
:::

## From source

Needs [Bun](https://bun.sh) 1.4 or newer:

```sh
git clone https://github.com/jackMort/brothy.git && cd brothy
bun install
bun run build                # single binary ./brothy, parsers embedded
```

brothy is not published to npm; releases ship prebuilt binaries only.

## Check it

```sh
brothy --version
brothy ~/notes
```

The logo in the top line is a [Nerd Font](https://www.nerdfonts.com) glyph, so it shows as a box in a terminal font without one. Nothing else depends on it.
