import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import { ExpressiveCodeTheme } from "@astrojs/starlight/expressive-code"
import { codeTheme } from "./src/code-theme.mjs"

export default defineConfig({
  site: "https://jackmort.github.io",
  base: "/brothy",
  // docs/ screenshots are read from the repo root (src/assets/docs is a symlink to it)
  vite: { server: { fs: { allow: [".."] } } },
  integrations: [
    starlight({
      title: "brothy",
      description: "A calm terminal Markdown reader: browse a folder of notes, jump anywhere with ctrl+p, read in zen. Obsidian-flavored, live reload, 42 themes.",
      logo: { src: "./src/assets/bowl.svg" },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/jackMort/brothy" }],
      editLink: { baseUrl: "https://github.com/jackMort/brothy/edit/main/site/" },
      customCss: ["./src/styles/brothy.css"],
      components: { Hero: "./src/components/Hero.astro" },
      expressiveCode: {
        themes: [ExpressiveCodeTheme.fromJSONString(JSON.stringify(codeTheme("dark"))), ExpressiveCodeTheme.fromJSONString(JSON.stringify(codeTheme("light")))],
        useStarlightUiThemeColors: true,
        styleOverrides: { codeFontFamily: "var(--sl-font-mono)" },
      },
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" } },
        { tag: "link", attrs: { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" } },
      ],
      sidebar: [
        { label: "Getting started", items: ["getting-started/install", "getting-started/quick-start", "getting-started/the-screen"] },
        { label: "Usage", items: ["usage/reading", "usage/navigating-notes", "usage/obsidian-notes", "usage/zen-mode", "usage/pipes-and-editor"] },
        { label: "Keys", items: ["keys"] },
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
        { label: "More", items: ["faq", "changelog"] },
      ],
    }),
  ],
})
