---
title: Set up a provider
description: "Turn on the opt-in AI features with an ai block in config.json: local models first, or a hosted provider."
---

<!-- Mirrors README § AI: update both. -->

AI is off until you add an `ai` block to `config.json`. Nothing is ever sent on its own: every request starts from an explicit key, goes to the configured endpoint only, and is the only network traffic brothy has. Up to 3 requests run at once, over every feature; a 4th says `AI busy · 3 requests running` and sends nothing.

Local first: no key, nothing leaves your machine.

```json
"ai": { "provider": "ollama", "model": "llama3.2" }
```

Or a hosted model:

```json
"ai": { "provider": "openrouter", "model": "anthropic/claude-haiku-5-5" }
```

After editing the file, press <kbd>r</kbd> to re-read it.

## Fields

| Field | |
| --- | --- |
| `provider` | a preset below, or `"custom"` |
| `model` | passed through unchanged (no default) |
| `baseURL` | required for `custom`: an OpenAI-compatible base such as `http://host:8080/v1` |
| `keyEnv` | env var holding the key (overrides the preset's) |
| `maxChars` | input limit, at least 1000 (overrides the preset's) |
| `headers` | extra request headers, e.g. `anthropic-workspace-id`, `HTTP-Referer`; `Authorization` is ignored; not sent over plain `http:` except to localhost, and their values are redacted from error toasts |
| `gloss` | zen gloss style: `explain` (default), `simplify`, `translate:<tag>` |

## Providers

| Provider | Key from | `maxChars` |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | 48 000 |
| `openrouter` | `OPENROUTER_API_KEY` | 48 000 |
| `anthropic` | `ANTHROPIC_API_KEY` | 48 000 |
| `gemini` | `GEMINI_API_KEY` | 48 000 |
| `ollama` | none | 8 000 |
| `lmstudio` | none | 8 000 |
| `custom` | `keyEnv`, or none | 48 000 |

Keys are read only from the environment, never from `config.json`, and are never sent over plain `http:` to a host other than localhost. A 401/403 without a key reads `AI: unauthorized · set keyEnv`; with one, `AI: key rejected (<ENV>)`.

:::caution[Ollama]
Ollama cuts an over-long prompt from the front without an error: raise `num_ctx` (Modelfile) or `OLLAMA_CONTEXT_LENGTH`, then `maxChars`.
:::

## Cache and network

The summary cache is `$XDG_CACHE_HOME/brothy/summaries.json` (else `~/.cache/brothy/`), private to your user, newest 500 notes. Glosses are cached beside it in `glosses.json` (newest 2 000 sections, per style). Reload explanations and ask answers are never written to disk. The compiled binary honors `HTTPS_PROXY` and extra CAs from `NODE_EXTRA_CA_CERTS`. HTTP redirects are refused: set `baseURL` to the final URL.

See [What is sent](/brothy/ai/what-is-sent/) for exactly what each key sends.
