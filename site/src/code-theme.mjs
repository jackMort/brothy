// Code block colors for Starlight's Expressive Code: the brothy / brothy-light palettes (src/theme.ts) in a VS Code theme.
const P = {
  dark: { type: "dark", primary: "#fe9962", secondary: "#e3c9a2", accent: "#c69bab", success: "#93b493", info: "#9fa8d1", text: "#e7e2da", muted: "#9d9892", element: "#23211f", border: "#423f3c" },
  light: { type: "light", primary: "#a94503", secondary: "#573e26", accent: "#834b62", success: "#416b42", info: "#4d568e", text: "#24201c", muted: "#635e59", element: "#ebe7e0", border: "#c4c0bb" },
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
