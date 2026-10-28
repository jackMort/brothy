# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately via
[GitHub private vulnerability reporting](https://github.com/jackMort/brothy/security/advisories/new).
Include the version (`brothy --version`), your OS and terminal, and steps to reproduce.

You can expect an acknowledgement within 7 days. Fixes are released as a patch version
and credited in the changelog unless you prefer otherwise.

## Scope

brothy reads local Markdown files and writes only `~/.config/brothy/*.json` and
`~/.cache/brothy/{summaries,glosses}.json`. It runs one other program, on `e` only: your
`$VISUAL` / `$EDITOR` (else `vi`) with the note's path. Selecting text copies it to the
clipboard through an OSC 52 escape sequence to your terminal. Its only network requests are the opt-in AI
requests, to the endpoint in your `ai` block and no other (redirects are not followed: a
3xx answer is an error, and the request is never sent on to where it points). Each is sent
only on an explicit key press, never automatically, and never includes front matter (other than
the `title` property, used as the note title) or `%%comments%%`:

- `a`: the TL;DR sends the note body (cut to `maxChars`).
- `a` in zen: a gloss sends the note title, the section's heading path and that section's text.
- `D`: explaining a reload sends the note title and the changed hunks.
- `?` in `ctrl+p`: ask sends only the question (tier 0). The separate rerank row (tier 1) sends
  the question and up to 12 candidate excerpts (note name, heading path, 300 characters each);
  its token cost is shown before it is pressed.

Keys come from the environment only (never `config.json`, never the cache) and, like any custom
`headers`, are not sent over plain `http:` to a host other than localhost; both are redacted from
error toasts. The cache files hold model output, hashes of what was sent, and keys made of
absolute note paths and heading names, in a `0700` folder with `0600` files. The baseline `D` compares with lives in
memory only and is dropped when you leave the note; ask answers are never written to disk, nor are a piped document's glosses or summary.

Issues such as crafted Markdown causing code execution, writes outside those directories,
terminal escape-sequence injection, API keys leaking (toasts, cache, plain-http transport), and
model output reaching the terminal as escape sequences or being taken for note text (a gloss,
explanation or ask reply cannot name a place brothy did not find itself) are in scope.
