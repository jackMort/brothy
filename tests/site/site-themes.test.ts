import { expect, test } from "bun:test"
import { families, headScript, onlyModes, siteThemesCss } from "../../site/src/themes"
import { themes } from "../../src/theme/theme"

const css = siteThemesCss()
const block = (sel: string) => {
  const i = css.indexOf(sel + " {")
  expect(i).toBeGreaterThan(-1)
  return css.slice(i, css.indexOf("}", i))
}

test("every theme gets a [data-family][data-theme] block carrying its own palette", () => {
  for (const t of themes) {
    const b = block(`:root[data-family="${t.name.replace(/-(dark|light)$/, "")}"][data-theme="${t.mode}"]`)
    for (const hex of [
      t.primary,
      t.secondary,
      t.accent,
      t.error,
      t.warning,
      t.success,
      t.info,
      t.text,
      t.textMuted,
      t.background,
      t.backgroundElement,
      t.border,
      t.borderSubtle,
    ])
      expect(b).toContain(hex)
    expect(b).toContain(`color-scheme: ${t.mode}`)
  }
  expect(css.match(/data-family=/g)).toHaveLength(themes.length)
})

test("brothy is the default: its blocks also answer :root and data-theme=light with nothing chosen", () => {
  expect(css).toMatch(/:root,\n:root\[data-family="brothy"\]\[data-theme="dark"\] \{/)
  expect(css).toMatch(/:root\[data-theme="light"\],\n:root\[data-family="brothy"\]\[data-theme="light"\] \{/)
})

test("the glass, edge and shadow derive from the palette: the background and text at fixed alphas", () => {
  const dark = themes.find((t) => t.name === "brothy")!
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(", ")
  const b = block(':root,\n:root[data-family="brothy"][data-theme="dark"]')
  expect(b).toContain(`--b-glass: rgba(${rgb(dark.background)}, 0.74)`)
  expect(b).toContain(`--b-glass-edge: rgba(${rgb(dark.text)}, 0.1)`)
  expect(b).toContain("--b-shadow: rgba(0, 0, 0, 0.55)")
  const light = themes.find((t) => t.name === "brothy-light")!
  const l = block(':root[data-theme="light"],\n:root[data-family="brothy"][data-theme="light"]')
  expect(l).toContain(`--b-glass: rgba(${rgb(light.background)}, 0.8)`)
  expect(l).toContain(`--b-shadow: rgba(${rgb(light.text)}, 0.22)`)
})

test("the picker's families: 22, in theme order, synthwave84 and vesper dark-only", () => {
  expect(families).toHaveLength(22)
  expect(families[0]!.name).toBe("brothy")
  expect(onlyModes).toEqual({ synthwave84: "dark", vesper: "dark" })
  expect(families.find((f) => f.name === "vesper")!.light).toBeUndefined()
  expect(families.find((f) => f.name === "one")!.light!.theme).toBe("one-light")
})

// the pre-paint script, run against a stand-in document and storage
function boot(store: Record<string, string>, systemLight = false) {
  const doc = { documentElement: { dataset: {} as Record<string, string> } }
  const ls = { getItem: (k: string) => store[k] ?? null }
  new Function("document", "localStorage", "matchMedia", headScript)(doc, ls, () => ({ matches: systemLight }))
  return doc.documentElement.dataset
}

test("pre-paint script: brothy and the system's mode with nothing stored", () => {
  expect(boot({})).toEqual({ family: "brothy", theme: "dark" })
  expect(boot({}, true)).toEqual({ family: "brothy", theme: "light" })
})

test("pre-paint script: the stored family and mode; a single-mode family keeps its own; an unknown family is brothy", () => {
  expect(boot({ "brothy-family": "nord", "starlight-theme": "light" })).toEqual({ family: "nord", theme: "light" })
  expect(boot({ "brothy-family": "vesper", "starlight-theme": "light" })).toEqual({ family: "vesper", theme: "dark" })
  expect(boot({ "brothy-family": "nope", "starlight-theme": "light" })).toEqual({ family: "brothy", theme: "light" })
})
