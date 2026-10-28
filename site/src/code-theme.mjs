// Code block colors for Starlight's Expressive Code, following whichever palette the page wears (src/themes.ts writes
// the `--b-*` tokens, one block per theme). Shiki only takes hex colors, so the theme below uses one opaque stand-in
// hex per role and `followPalette` swaps each stand-in for `var(--b-<role>)` in the rendered tokens: one pair of
// themes (dark and light, as Starlight wants), no per-palette copies in the HTML.
const ROLES = ["primary", "secondary", "accent", "success", "info", "text", "muted", "element"]
/** stand-in for a role: unlikely to be anything else, still a valid hex */
const stand = (role) => "#" + (ROLES.indexOf(role) + 1).toString(16).padStart(2, "0").repeat(3)
const VARS = Object.fromEntries(ROLES.map((r) => [stand(r), `var(--b-${r})`]))

export function codeTheme(mode) {
  const c = Object.fromEntries(ROLES.map((r) => [r, stand(r)]))
  const t = (scope, foreground, fontStyle) => ({ scope, settings: { foreground, ...(fontStyle ? { fontStyle } : {}) } })
  return {
    name: mode === "dark" ? "brothy" : "brothy-light",
    type: mode,
    colors: { "editor.background": c.element, "editor.foreground": c.text, "editorLineNumber.foreground": c.muted },
    tokenColors: [
      t(["comment", "punctuation.definition.comment"], c.muted, "italic"),
      t(["string", "string.quoted"], c.info),
      t(["constant.numeric", "constant.language", "constant.character.escape"], c.accent),
      t(["keyword", "storage", "storage.type", "keyword.control"], c.secondary),
      t(["entity.name.function", "support.function", "meta.function-call"], c.primary),
      t(["entity.name.type", "support.type", "support.class", "entity.name.class"], c.info),
      t(["variable.other.property", "support.type.property-name", "meta.object-literal.key"], c.text),
      t(["entity.name.tag", "markup.heading"], c.secondary),
      t(["entity.other.attribute-name"], c.primary),
      t(["punctuation", "meta.brace", "keyword.operator"], c.muted),
    ],
  }
}

/** Expressive Code plugin: the stand-in hexes in the token styles become the page's role variables. */
export const followPalette = {
  name: "follow-palette",
  hooks: {
    postprocessRenderedBlock: ({ renderData }) => {
      const swap = (s) => s.replace(/#[0-9a-f]{6}\b/gi, (h) => VARS[h.toLowerCase()] ?? h)
      const walk = (node) => {
        const style = node.properties?.style
        if (typeof style === "string" && style.startsWith("--")) node.properties.style = swap(style)
        node.children?.forEach(walk)
      }
      walk(renderData.blockAst)
    },
  },
}
