// Code block colors for Starlight's Expressive Code: the brothy / brothy-light palettes (src/theme.ts) in a VS Code theme.
const P = {
  dark: { type: "dark", primary: "#59c9be", secondary: "#f2c65a", accent: "#ef7b63", success: "#9dcb82", info: "#89b4fa", text: "#f3efe7", muted: "#aaa39a", element: "#24211d", border: "#3b3630" },
  light: { type: "light", primary: "#0f766e", secondary: "#8a5a00", accent: "#c2410c", success: "#3f6b1d", info: "#1d5fb8", text: "#2a2621", muted: "#6b645b", element: "#f0eadc", border: "#d9d1c0" },
}

export function codeTheme(mode) {
  const c = P[mode]
  const t = (scope, foreground, fontStyle) => ({ scope, settings: { foreground, ...(fontStyle ? { fontStyle } : {}) } })
  return {
    name: mode === "dark" ? "brothy" : "brothy-light",
    type: c.type,
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
