// The keymap: modes, context ids, every binding, the footer hints per context and the `? ?` sheet's groups. Pure.
import type { KeyEvent } from "@opentui/core"
import type { AskStage } from "../ai/ask"
import type { View } from "../system/config"
import type { HelpGroup } from "../ui/help"
import type { HintItem } from "../ui/status"

/** A group of bindings: global, the document, a panel view or a popup; dispatch tries them in order. */
export type Mode =
  | "global"
  | "files"
  | "doc"
  | "outline"
  | "info"
  | "filter"
  | "help"
  | "prompt"
  | "theme"
  | "zen"
  | "zenSettings"
  | "label"
  | "switch"
  | "open"
/** Context id: one id for keys, hints and help (`panel:<view>` while the panel has focus). */
export type Ctx =
  | "doc"
  | `panel:${View}`
  | "filter"
  | "zen"
  | "help"
  | "prompt"
  | "theme"
  | "zenSettings"
  | "label"
  | "switch"
  | "open"
/** One binding: its keys, how help and the footer show it. */
export interface KeyDef {
  modes: readonly Mode[]
  keys: readonly string[]
  /** keys as shown in the help popup */
  label: string
  /** help popup description; bindings without one stay out of the popup */
  desc?: string
  /** compact keys for the footer (defaults to `label`) */
  short?: string
  /** footer word */
  hint?: string
  /** footer: dropped before the other hints when they don't all fit */
  spare?: boolean
  /** footer: shown only while this holds */
  when?: keyof FooterState
  /** help group, when not the one its first mode puts it in (`HELP_SECTIONS`) */
  group?: string
}

/** What a footer hint can wait for (`KeyDef.when`). */
export interface FooterState {
  /** a find query is set */
  query: boolean
  /** Preview: link labels are Preview only */
  preview: boolean
  /** the note is on disk: a piped document has nothing to edit */
  disk: boolean
  /** an `ai` block is configured: AI is off until then */
  ai: boolean
  /** an `ai` block and changes still to explain */
  changes: boolean
  /** an `ai` block and no fresh TL;DR for the open note: the document footer offers `a` */
  tldr: boolean
}

/**
 * Every binding: dispatch, the `? ?` sheet and the footer words all read it, so they cannot drift apart (`FOOTERS` picks
 * which hints a context shows). Specs are matched by `matchKey` (`S-g` is G, `C-d` is ^d).
 */
const KEYMAP = {
  views: { modes: ["global"], keys: ["1", "2", "3"], label: "1 2 3", desc: "Files · Outline · Info (piped: 1 2 only)" },
  source: { modes: ["global"], keys: ["s"], label: "s", desc: "toggle Source / Preview" },
  width: { modes: ["global"], keys: ["w"], label: "w", desc: "full width / measure" },
  minimap: { modes: ["global"], keys: ["m"], label: "m", desc: "minimap on / off (saved)", group: "Global" },
  headings: {
    modes: ["global"],
    keys: ["#"],
    label: "#",
    desc: "heading style: classic · bars · ladder · rules (saved)",
    group: "Document",
  },
  transparent: { modes: ["global"], keys: ["S-t"], label: "T", desc: "transparent background (saved)" },
  zen: { modes: ["global"], keys: ["z"], label: "z", desc: "zen mode: only the text (esc leaves)" },
  zenSettings: { modes: ["global"], keys: ["S-z"], label: "Z", desc: "zen settings (live preview)", hint: "settings" },
  sidebar: { modes: ["global"], keys: ["C-b"], label: "^b", desc: "hide / show the panel (drawer below 100 columns)" },
  slash: {
    modes: ["global"],
    keys: ["/"],
    label: "/",
    desc: "find in document · filter the panel list (panel focused)",
    hint: "find",
  },
  switcher: { modes: ["global"], keys: ["C-p"], label: "^p", desc: "go to a note, heading or text (the whole vault)" },
  open: { modes: ["global"], keys: ["o"], label: "o", desc: "open a recent project or any path (folder or note)" },
  focus: { modes: ["global"], keys: ["tab"], label: "tab", desc: "panel ⇄ document" },
  theme: { modes: ["global"], keys: ["t"], label: "t", desc: "pick theme · ←→ dark / light" },
  reload: { modes: ["global"], keys: ["r"], label: "r", desc: "reload files and AI config" },
  clear: {
    modes: ["global"],
    keys: ["escape"],
    label: "esc",
    desc: "clear find · hide gloss · leave zen · panel: clear filter, else back to the document",
  },
  help: { modes: ["global"], keys: ["?"], label: "?", desc: "key hints · twice: all keys", hint: "keys" },
  quit: { modes: ["global"], keys: ["q", "C-c"], label: "q", desc: "quit" },
  histBack: {
    modes: ["global"],
    keys: ["S-h"],
    label: "H",
    short: "H L",
    desc: "back to the previous note",
    hint: "history",
    spare: true,
  },
  histForward: { modes: ["global"], keys: ["S-l"], label: "L", desc: "forward to the next note" },
  summarize: {
    modes: ["global"],
    keys: ["a"],
    label: "a",
    desc: "summarize the note (Info tab)",
    hint: "summarize",
    group: "AI",
    spare: true,
    when: "ai",
  },
  summarizeHint: { modes: ["doc"], keys: [], label: "a", hint: "summarize", spare: true, when: "tldr" },
  explainChange: {
    modes: ["global"],
    keys: ["S-d"],
    label: "D",
    desc: "explain what changed on disk",
    hint: "changes",
    group: "AI",
    spare: true,
    when: "changes",
  },
  edit: {
    modes: ["global"],
    keys: ["e"],
    label: "e",
    desc: "edit the note in $EDITOR at the top line",
    hint: "edit",
    spare: true,
    when: "disk",
  },

  docLine: {
    modes: ["doc"],
    keys: ["j", "down", "k", "up"],
    label: "j k ↑ ↓",
    short: "j k",
    desc: "scroll a line",
    hint: "scroll",
  },
  docHalf: { modes: ["doc"], keys: ["d", "C-d", "u", "C-u"], label: "d u", short: "d/u", desc: "half page down / up" },
  docPage: {
    modes: ["doc"],
    keys: ["space", "pagedown", "C-f", "b", "pageup"],
    label: "space b",
    short: "␣ b",
    desc: "page down / up",
    hint: "page",
  },
  docEnds: { modes: ["doc"], keys: ["g", "home", "S-g", "end"], label: "g G", desc: "top / bottom" },
  docHeading: {
    modes: ["doc"],
    keys: ["]", "}", "[", "{"],
    label: "[ ]",
    desc: "previous / next heading",
    hint: "section",
  },
  docMatch: {
    modes: ["doc"],
    keys: ["n", "S-n"],
    label: "n N",
    desc: "next / previous match",
    hint: "match",
    when: "query",
  },
  back: { modes: ["doc"], keys: ["h", "left"], label: "h", desc: "focus the panel" },
  links: {
    modes: ["doc"],
    keys: ["f"],
    label: "f",
    desc: "label the links on screen to follow one",
    hint: "links",
    spare: true,
    when: "preview",
  },

  zenLine: {
    modes: ["zen"],
    keys: ["j", "down", "k", "up"],
    label: "j k ↑ ↓",
    short: "j k",
    desc: "scroll a line",
    hint: "scroll",
  },
  zenHalf: { modes: ["zen"], keys: ["d", "C-d", "u", "C-u"], label: "d u", desc: "half page down / up" },
  zenPage: {
    modes: ["zen"],
    keys: ["space", "pagedown", "C-f", "b", "pageup"],
    label: "space b",
    desc: "page down / up",
  },
  zenEnds: { modes: ["zen"], keys: ["g", "home", "S-g", "end"], label: "g G", desc: "top / bottom" },
  zenSection: {
    modes: ["zen"],
    keys: ["]", "}", "[", "{"],
    label: "[ ]",
    desc: "previous / next section",
    hint: "section",
  },
  zenMeasure: { modes: ["zen"], keys: ["<", ">"], label: "< >", desc: "narrower / wider text (saved)" },
  zenSpeed: { modes: ["zen"], keys: ["+", "-"], label: "+ -", desc: "teleprompter faster / slower (saved)" },
  zenGloss: {
    modes: ["zen"],
    keys: ["a"],
    label: "a",
    desc: "gloss: explain the section you're reading (AI) · again: more / less",
    hint: "gloss",
    spare: true,
    when: "ai",
  },
  zenRegen: { modes: ["zen"], keys: ["S-a"], label: "A", desc: "gloss: ask again, replacing the cached one (AI)" },

  outlineMove: {
    modes: ["outline"],
    keys: ["j", "down", "k", "up", "g", "S-g"],
    label: "j k g G",
    short: "↑↓",
    desc: "Outline: move",
    hint: "move",
  },
  outlineJump: {
    modes: ["outline"],
    keys: ["return", "enter"],
    label: "⏎",
    desc: "Outline: jump to heading and read",
    hint: "jump",
  },
  outlinePeek: {
    modes: ["outline"],
    keys: ["l", "right"],
    label: "l",
    desc: "Outline: jump, keep the panel focused",
    hint: "peek",
  },

  infoMove: {
    modes: ["info"],
    keys: ["j", "down", "k", "up", "g", "S-g"],
    label: "j k g G",
    short: "↑↓",
    desc: "Info: move between links and changes (scroll without them)",
    hint: "links",
  },
  infoOpen: {
    modes: ["info"],
    keys: ["return", "enter"],
    label: "⏎",
    desc: "Info: open the link · jump to the change",
    hint: "open",
  },

  filesMove: {
    modes: ["files"],
    keys: ["j", "down", "k", "up", "g", "S-g", "pagedown", "C-d", "pageup", "C-u"],
    label: "j k g G",
    short: "↑↓",
    desc: "Files: move",
    hint: "move",
  },
  filesOpen: {
    modes: ["files"],
    keys: ["return", "enter"],
    label: "⏎",
    desc: "Files: read note · toggle folder",
    hint: "open",
  },
  filesPeek: {
    modes: ["files"],
    keys: ["l", "right"],
    label: "l",
    desc: "Files: open note, keep focus · expand folder",
  },
  filesUp: {
    modes: ["files"],
    keys: ["h", "left"],
    label: "h",
    short: "h l",
    desc: "Files: collapse folder · go to parent",
    hint: "fold",
  },
  filesTidy: {
    modes: ["files"],
    keys: ["-"],
    label: "-",
    desc: "Files: fold all but the open note's path",
    hint: "tidy",
  },

  filterType: { modes: ["filter"], keys: [], label: "type", desc: "Filter: type to narrow the list (⌫ erases)" },
  filterMove: { modes: ["filter"], keys: ["down", "up", "C-n", "C-p"], label: "↑↓", desc: "Filter: move" },
  filterOpen: {
    modes: ["filter"],
    keys: ["return", "enter"],
    label: "⏎",
    desc: "Filter: open the result",
    hint: "open",
  },
  filterClear: {
    modes: ["filter"],
    keys: ["escape"],
    label: "esc",
    desc: "Filter: clear and stop typing",
    hint: "clear",
  },
  filterLeave: { modes: ["filter"], keys: ["tab"], label: "tab", desc: "Filter: keep it, back to the document" },
  filterErase: { modes: ["filter"], keys: ["backspace"], label: "⌫" },

  helpScroll: {
    modes: ["help"],
    keys: ["j", "down", "k", "up", "space", "pagedown", "C-d", "b", "pageup", "C-u", "g", "home", "S-g", "end"],
    label: "j/k",
    hint: "scroll",
  },
  helpClose: { modes: ["help"], keys: ["escape"], label: "esc", hint: "close" },

  promptMove: { modes: ["prompt"], keys: ["down", "up"], label: "↑↓", hint: "select" },
  promptApply: { modes: ["prompt"], keys: ["return", "enter"], label: "⏎", hint: "apply" },
  promptClear: { modes: ["prompt"], keys: ["escape"], label: "esc", hint: "clear" },
  promptErase: { modes: ["prompt"], keys: ["backspace"], label: "⌫" },
  swType: { modes: ["switch"], keys: [], label: "type", hint: "search" },
  swMove: { modes: ["switch"], keys: ["down", "up", "C-n", "C-p"], label: "↑↓", hint: "select" },
  swSection: { modes: ["switch"], keys: ["tab"], label: "tab", hint: "section" },
  swOpen: { modes: ["switch"], keys: ["return", "enter"], label: "⏎", hint: "open" },
  swClose: { modes: ["switch"], keys: ["escape"], label: "esc", hint: "close" },
  swErase: { modes: ["switch"], keys: ["backspace"], label: "⌫" },
  swAsk: {
    modes: ["switch"],
    keys: [],
    label: "^p ?",
    desc: "ask your notes: ^p then ?question",
    group: "AI",
  },
  // hint-only: the `?` that starts a question, and `⌫` in ask mode (swErase does it)
  swAskHint: { modes: ["switch"], keys: [], label: "?", hint: "ask", spare: true, when: "ai" },
  askErase: { modes: ["switch"], keys: [], label: "⌫", hint: "edit" },
  opType: { modes: ["open"], keys: [], label: "type", hint: "filter · path" },
  opMove: { modes: ["open"], keys: ["down", "up", "C-n", "C-p"], label: "↑↓", hint: "select" },
  opComplete: { modes: ["open"], keys: ["tab"], label: "tab", hint: "complete" },
  opOpen: { modes: ["open"], keys: ["return", "enter"], label: "⏎", hint: "open" },
  opClose: { modes: ["open"], keys: ["escape"], label: "esc", hint: "close" },
  opErase: { modes: ["open"], keys: ["backspace"], label: "⌫" },
  labelType: { modes: ["label"], keys: [], label: "a–z", desc: "Links: type a label", hint: "follow" },
  labelErase: { modes: ["label"], keys: ["backspace"], label: "⌫", hint: "erase" },
  labelCancel: { modes: ["label"], keys: ["escape"], label: "esc", hint: "cancel" },

  themeType: { modes: ["theme"], keys: [], label: "type", hint: "filter", spare: true },
  themeMove: { modes: ["theme"], keys: ["down", "up", "C-n", "C-p"], label: "↑↓", hint: "select" },
  themeMode: { modes: ["theme"], keys: ["tab", "left", "right"], label: "←→", hint: "dark/light" },
  themeApply: { modes: ["theme"], keys: ["return", "enter"], label: "⏎", hint: "apply" },
  themeClose: { modes: ["theme"], keys: ["escape"], label: "esc", hint: "close" },
  themeErase: { modes: ["theme"], keys: ["backspace"], label: "⌫" },

  zsMove: { modes: ["zenSettings"], keys: ["down", "j", "up", "k"], label: "↑↓", hint: "move" },
  zsToggle: { modes: ["zenSettings"], keys: ["space"], label: "space", hint: "toggle" },
  zsAdjust: { modes: ["zenSettings"], keys: ["left", "h", "right", "l"], label: "←→", hint: "adjust" },
  zsSave: { modes: ["zenSettings"], keys: ["return", "enter"], label: "⏎", hint: "save" },
  zsRevert: { modes: ["zenSettings"], keys: ["escape"], label: "esc", hint: "revert" },
} as const satisfies Record<string, KeyDef>
/** A binding's id, also its action's name. */
export type KeyId = keyof typeof KEYMAP
/** Every binding id, in KEYMAP order: `dispatch` tries them in it. */
export const KEY_IDS = Object.keys(KEYMAP) as KeyId[]
/** The binding `id`, typed as the general `KeyDef`. */
export const keyDef = (id: KeyId): KeyDef => KEYMAP[id]
/** The welcome page's keycaps: [binding, word]. */
export const WELCOME_KEYS: [KeyId, string][] = [
  ["open", "open a project"],
  ["theme", "theme"],
  ["help", "keys"],
  ["quit", "quit"],
]

/** A footer hint: a binding, optionally with a context-specific word. */
export type Hint = KeyId | [KeyId, string]
/** Footer hints per context, in order (`fitHints` drops the spare ones first). */
export const FOOTERS: Record<Ctx, Hint[]> = {
  doc: [
    "docLine",
    "docPage",
    "docHeading",
    "slash",
    "docMatch",
    "links",
    "histBack",
    "edit",
    "summarizeHint",
    ["focus", "panel"],
    "help",
  ],
  "panel:files": [
    "filesMove",
    "filesOpen",
    "filesUp",
    ["slash", "filter"],
    ["views", "view"],
    ["focus", "document"],
    "help",
  ],
  "panel:outline": ["outlineMove", "outlineJump", "outlinePeek", ["slash", "filter"], ["focus", "document"], "help"],
  "panel:info": ["infoMove", "infoOpen", "summarize", "explainChange", ["focus", "document"], "help"],
  filter: ["filterType", "filterMove", "filterOpen", "filterClear"],
  zen: ["zenLine", "zenSection", "zenGloss", "zenSettings", ["zen", "leave"], "help"],
  help: ["helpScroll", "helpClose"],
  prompt: ["promptMove", "promptApply", "promptClear"],
  theme: ["themeType", "themeMove", "themeMode", "themeApply", "themeClose"],
  zenSettings: ["zsMove", "zsToggle", "zsAdjust", "zsSave", "zsRevert"],
  label: ["labelType", "labelErase", "labelCancel"],
  switch: ["swType", "swMove", "swSection", "swOpen", "swAskHint", "swClose"],
  open: ["opType", "opMove", "opComplete", "opOpen", "opClose"],
}

/** The switcher's footer while the query is a question, by what the ask shows (`askStage`). */
const ASK_FOOTERS: Record<AskStage, Hint[]> = {
  off: ["swClose"],
  short: ["askErase", "swClose"],
  target: ["askErase", "swClose"],
  idle: [["swOpen", "ask"], "askErase", "swClose"],
  asking: [["askErase", "edit · cancels"], "swClose"],
  result: ["swMove", "swOpen", ["swSection", "rerank"], "swClose"],
  none: ["askErase", "swClose"],
  reranking: ["swMove", "swOpen", "swClose"],
  reranked: ["swMove", "swOpen", "swSection", "swClose"],
  error: [["swOpen", "try again"], "askErase", "swClose"],
}

/** Contexts whose hints stay at full colour instead of fading: the popups and typing. */
export const PINNED: readonly Ctx[] = ["prompt", "theme", "zenSettings", "help", "filter", "label", "switch", "open"]

/**
 * Footer hints for context `c`, before fitting; a binding with `when` shows only while `on` says so. `words` are the
 * words that follow the state (`a cancel` while the TL;DR runs); they win over the context's and the binding's own.
 * `ask`: the switcher holds a question, and its footer follows the ask's stage.
 */
export function footerHints(
  c: Ctx,
  on: FooterState,
  words: Partial<Record<KeyId, string>> = {},
  ask?: AskStage | null,
): HintItem[] {
  return (c === "switch" && ask ? ASK_FOOTERS[ask] : FOOTERS[c]).flatMap((h) => {
    const [id, word] = Array.isArray(h) ? h : [h, undefined]
    const def = keyDef(id)
    return def.when && !on[def.when]
      ? []
      : [{ key: def.short ?? def.label, word: words[id] ?? word ?? def.hint ?? "", spare: def.spare }]
  })
}

/** Help sections by mode, in sheet order; `AI` collects bindings that name it as their `group`. */
const HELP_SECTIONS: [readonly Mode[], string][] = [
  [["global"], "Global"],
  [["doc"], "Document"],
  [["zen"], "Zen"],
  [["files", "outline", "info", "filter"], "Panel"],
  [[], "AI"],
]
/** The `? ?` sheet's groups: a binding with a description goes to its `group`, else to its first mode's section. */
export const HELP_GROUPS: HelpGroup[] = HELP_SECTIONS.map(([modes, title]) => ({
  title,
  entries: KEY_IDS.map(keyDef)
    .filter((d) => d.desc && (d.group ? d.group === title : modes.includes(d.modes[0]!)))
    .map((d) => ({ keys: d.label, desc: d.desc! })),
}))

/** KEYMAP mode of a context id (`panel:files` → `files`). */
export const modeOf = (c: Ctx): Mode => (c.startsWith("panel:") ? (c.slice(6) as Mode) : (c as Mode))

/** Direction of a paired binding (j/k, d/u, space/b, …): true for the "forward" key. */
export const isDown = (k: KeyEvent) =>
  ["j", "down", "d", "space", "pagedown"].includes(k.name) || (k.ctrl && k.name === "f")

/** Bindings that only make sense with the panel; zen skips them. */
export const ZEN_OFF: readonly KeyId[] = [
  "views",
  "sidebar",
  "focus",
  "back",
  "links",
  "summarize",
  "explainChange",
  "edit",
  "minimap",
]
/** The welcome page has no panel and no note: these would only change the panel, the view or the measure out of sight. */
export const WELCOME_OFF: readonly KeyId[] = [
  "views",
  "sidebar",
  "focus",
  "back",
  "summarize",
  "zen",
  "zenSettings",
  "source",
  "width",
  "headings",
]
