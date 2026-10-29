// JSON files on disk: the plain-object guard, a soft reader, the XDG base folders and the atomic writer
// that config, summaries and projects share. A leaf: it imports nothing from the app.

import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

/** A non-null, non-array object. */
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * What reading a JSON file found: its value, no file, or a file that can't be read or parsed. Never throws; only the
 * read and the parse are inside the try. `lenient` is for files people edit: a BOM is dropped and a blank file reads as `{}`.
 */
export function readJSON(
  file: string,
  o: { lenient?: boolean } = {},
): { kind: "ok"; value: unknown } | { kind: "missing" } | { kind: "invalid" } {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" }
  }
  if (o.lenient) {
    text = text.replace(/^﻿/, "")
    if (!text.trim()) return { kind: "ok", value: {} }
  }
  try {
    return { kind: "ok", value: JSON.parse(text) }
  } catch {
    return { kind: "invalid" }
  }
}

/** Resolved on every call so env changes apply (tests set it after import); a relative XDG path is ignored per the spec. */
const xdgBase = (name: string, fallback: string) => {
  const xdg = process.env[name]
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), fallback)
}

/** `$XDG_CONFIG_HOME`, else `~/.config`. */
export const configHome = () => xdgBase("XDG_CONFIG_HOME", ".config")
/** `$XDG_CACHE_HOME`, else `~/.cache`. */
export const cacheHome = () => xdgBase("XDG_CACHE_HOME", ".cache")

/**
 * Write via a temp file in the target's own folder and rename over it. A symlinked file is
 * followed (the link survives, its target is replaced) and the old mode is kept; `newMode`
 * applies only when the file is new. Throws on failure.
 */
export function writeFileAtomic(file: string, text: string, newMode?: number) {
  let target = file
  let mode: number | undefined
  try {
    target = realpathSync(file)
    mode = statSync(target).mode & 0o7777
  } catch {
    // new file (or a dangling link): plain write
  }
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  const keep = mode ?? newMode
  writeFileSync(tmp, text, keep === undefined ? undefined : { mode: keep })
  if (keep !== undefined) chmodSync(tmp, keep)
  renameSync(tmp, target)
}
