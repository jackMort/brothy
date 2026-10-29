import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import { ExpressiveCodeTheme } from "@astrojs/starlight/expressive-code"
import { mkdirSync, writeFileSync } from "node:fs"
import { codeTheme, followPalette } from "./src/code-theme.mjs"
import { pickerData, siteThemesCss } from "./src/themes"

// Every palette on the site comes from ../src/theme/theme.ts: this writes one block of `--b-*` tokens per theme (and the picker's
// families) before Starlight reads its customCss (src/generated is not committed; see src/themes.ts).
const brothyThemes = () => ({
  name: "brothy-themes",
  hooks: {
    "astro:config:setup": () => {
      mkdirSync("./src/generated", { recursive: true })
      writeFileSync("./src/generated/themes.css", siteThemesCss())
      writeFileSync("./src/generated/families.json", JSON.stringify(pickerData))
    },
  },
})

export default defineConfig({
  site: "https://jackmort.github.io",
  base: "/brothy",
  // docs/ screenshots are read from the repo root (src/assets/docs is a symlink to it)
  vite: { server: { fs: { allow: [".."] } } },
  integrations: [
    brothyThemes(),
    starlight({
      title: "brothy",
      description: "A calm terminal Markdown reader: browse a folder of notes, jump anywhere with ctrl+p, read in zen. Obsidian-flavored, live reload, 42 themes.",
      logo: { dark: "./src/assets/brothy-mark-dark.svg", light: "./src/assets/brothy-mark-light.svg" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/jackMort/brothy" }],
      editLink: { baseUrl: "https://github.com/jackMort/brothy/edit/main/site/" },
      customCss: ["./src/generated/themes.css", "./src/styles/brothy.css"],
      // brothy's screen as the frame: see each component's header comment
      components: {
        Header: "./src/components/Header.astro",
        PageFrame: "./src/components/PageFrame.astro",
        Sidebar: "./src/components/Sidebar.astro",
        TwoColumnContent: "./src/components/TwoColumnContent.astro",
        Hero: "./src/components/Hero.astro",
        PageTitle: "./src/components/PageTitle.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
        Footer: "./src/components/Footer.astro",
      },
      expressiveCode: {
        themes: [ExpressiveCodeTheme.fromJSONString(JSON.stringify(codeTheme("dark"))), ExpressiveCodeTheme.fromJSONString(JSON.stringify(codeTheme("light")))],
        plugins: [followPalette],
        // the stand-in colors are not contrast-checked against the stand-in background: the palettes are (tests/theme.test.ts)
        minSyntaxHighlightingColorContrast: 0,
        useStarlightUiThemeColors: true,
        // code blocks as brothy draws them: a flat fill, no frame, the language at the top right (brothy.css)
        defaultProps: { frame: "none" },
        styleOverrides: {
          codeFontFamily: "var(--sl-font-mono)", uiFontFamily: "var(--sl-font-mono)", codeFontSize: "0.9em", codeLineHeight: "1.6",
          borderRadius: "0", borderWidth: "0", codeBackground: "var(--b-element)", frames: { frameBoxShadowCssValue: "none" },
        },
      },
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" } },
        // IBM Plex Mono for everything; the few symbols it lacks come from a Fira Code subset of just those glyphs
        { tag: "link", attrs: { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" } },
        { tag: "link", attrs: { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600&text=%E2%96%B8%E2%96%BE%E2%97%8F%E2%94%81%E2%94%80%E2%94%82%E2%96%8C%E2%94%83%E2%80%BA%E2%8F%8E%C2%B7%E2%80%A2%E2%97%A6%E2%86%97%E2%89%A1%E2%97%90%E2%98%85%E2%87%84%E2%86%AA%E2%86%BB%E2%8C%AB%E2%90%A3%E2%97%A1&display=swap" } },
      ],
      sidebar: [
        { label: "Getting started", items: ["getting-started/install", "getting-started/quick-start", "getting-started/the-screen"] },
        { label: "Usage", items: ["usage/reading", "usage/navigating-notes", "usage/obsidian-notes", "usage/zen-mode", "usage/pipes-and-editor"] },
        "keys",
        { label: "Themes", items: ["themes/theme-picker", "themes/all-themes"] },
        { label: "Config", items: ["config/config-json", "config/zen-settings", "config/recent-projects"] },
        {
          label: "AI",
          items: [
            "ai/setup",
            { label: "Features", items: ["ai/tldr", "ai/zen-gloss", "ai/what-changed", "ai/ask-your-vault"] },
            "ai/what-is-sent",
          ],
        },
        "faq",
        "changelog",
      ],
    }),
  ],
})
