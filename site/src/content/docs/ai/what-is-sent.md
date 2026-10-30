---
title: What is sent
description: "Exactly what each AI key sends, and what never leaves your machine."
---

<!-- Mirrors SECURITY.md (what is sent): update both. -->

| Key | Request | Sent |
| --- | --- | --- |
| <kbd>a</kbd> | TL;DR | the note body, cut to `maxChars` |
| <kbd>a</kbd> in zen | gloss | note title, heading path, the section's own text (its subtree when it has under 20 words), cut to 12 000 characters |
| <kbd>D</kbd> | explain a change | note title, the changed hunks with 1 context line (each removed section: its first 20 lines), cut to 16 000 characters; later sections by heading only |
| `?` · <kbd>⏎</kbd> | ask, tier 0 | the question only |
| `?` · rerank row | ask, tier 1 | the question, and for up to 12 candidates: note name, heading path, 300 characters of text |

Front matter (other than the `title` property, used as the note name) and `%%comments%%` are never sent.

## Guarantees

- AI requests go only to the endpoint in your `ai` block, and are the only network traffic brothy has. Each one starts from an explicit key press.
- HTTP redirects are refused (`AI: <host> redirects · set baseURL to the final URL`) and the request is never re-sent.
- Keys come from the environment only (never `config.json`, never the cache). Neither the key nor custom `ai.headers` is sent over plain `http:` except to localhost. Both are redacted from error toasts.
- The cache files hold model output, hashes of what was sent, and keys made of absolute note paths and heading names, in a `0700` folder with `0600` files.
- Model output reaches the terminal with control characters replaced, and a gloss, explanation or ask reply cannot name a place brothy did not find itself.

Report a security problem privately, as described in [SECURITY.md](https://github.com/jackMort/brothy/blob/main/SECURITY.md).
