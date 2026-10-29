# Contributing

Bug reports and pull requests are welcome. Please read the [Code of Conduct](CODE_OF_CONDUCT.md);
for security issues see [SECURITY.md](SECURITY.md) instead of opening a public issue.

Requires [Bun](https://bun.sh) 1.4 or newer. macOS and Linux only.

```sh
bun install
bun test
bun run typecheck
bun run dev                 # run against ./examples (needs a real TTY)
bun run snapshot examples --size 100x30 --keys "tab j s"   # headless frame dump
bun run build               # compile a single binary ./brothy (delete it after checking)
```

## Workflow

1. Open an issue before a large change.
2. Fork, branch from `main`, keep PRs focused.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(app): …`, `fix(overlay): …`, `docs: …`).
4. Keep `bun test` and `bun run typecheck` green; add a test for new behavior. CI runs both on Linux and macOS.
5. Check UI changes with the snapshot script. `CLAUDE.md` describes the architecture and gotchas.
6. Add a line under `## [Unreleased]` in `CHANGELOG.md` for user-facing changes.

New themes must pass the contrast tests in `tests/theme.test.ts`.

The screenshots, videos and casts in `docs/` and `site/public/casts/` are rendered by the maintainer with private tooling: leave them out of a PR and say in the description if a change needs them re-rendered.

## Releasing (maintainers)

Move the `[Unreleased]` entries under a new version heading in `CHANGELOG.md`, bump `version`
in `package.json`, commit, then push a tag `v<version>`. The release workflow refuses a tag that
differs from `package.json`, runs the checks, builds the binaries and creates the GitHub release.

By contributing you agree your work is licensed under Apache-2.0.
