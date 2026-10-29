// Environment variables for unit tests. Nothing runs at import: `useXdgDir` and `useEnvRestore` register hooks when a test file calls them.
import { afterEach, beforeEach } from "bun:test"
import { join } from "node:path"
import { useTmp } from "./tmp"

type XdgKey = "XDG_CONFIG_HOME" | "XDG_CACHE_HOME"

/** Set `key`, or unset it for `undefined`. */
export function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** Put every var in `keys` back to its value now, after each test. */
export function useEnvRestore(...keys: string[]) {
  const saved = keys.map((k) => [k, process.env[k]] as const)
  afterEach(() => saved.forEach(([k, v]) => setEnv(k, v)))
}

/** Points `key` at a fresh empty folder before each test and restores it after; returns the current folder. */
export function useXdgDir(key: XdgKey) {
  const base = useTmp(`brothy-${key === "XDG_CONFIG_HOME" ? "cfg" : "cache"}-`)
  let dir = ""
  useEnvRestore(key)
  beforeEach(() => {
    dir = base()
    process.env[key] = dir
  })
  return () => dir
}
