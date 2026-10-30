// The key handler: dispatch by mode, and the order a key goes through (C-c, the open popup or typing, the modal modes,
// then zen, the welcome page and the focused view's bindings). Not pure: `makeOnKey` closes over the app context.
import type { KeyEvent } from "@opentui/core"
import { pickQuery } from "../theme/themepick"
import { matchKey } from "../ui/nav"
import type { Actions, Features } from "./actions"
import type { AppCtx } from "./ctx"
import { typed } from "./input"
import { type Ctx, KEY_IDS, type KeyId, keyDef, type Mode, modeOf, WELCOME_OFF, ZEN_OFF } from "./keymap"
import type { UI } from "./store"

/** Run the first binding of the given modes (in order) that matches `k`; `skip` bindings are ignored. */
function dispatch(actions: Actions, modes: Mode[], k: KeyEvent, skip: readonly KeyId[] = []) {
  for (const m of modes)
    for (const id of KEY_IDS) {
      if (skip.includes(id)) continue
      const def = keyDef(id)
      if (def.modes.includes(m) && def.keys.some((spec) => matchKey(spec, k))) {
        actions[id](k)
        return true
      }
    }
  return false
}

/** The open popup's bindings, else typing into it; false with no popup open. */
function makePopupKey({ workspace, switcher, popups }: Features, actions: Actions) {
  const { themeSet, promptType } = popups
  /** The popups that take every key, in precedence order: each one's mode, and where a printable key no binding takes goes. */
  const popupModes: { mode: Mode; open: (s: UI) => boolean; type?: (s: UI, text: string) => void }[] = [
    { mode: "theme", open: (s) => !!s.themePick, type: (_, text) => themeSet((p) => pickQuery(p, p.q + text)) },
    { mode: "zenSettings", open: (s) => s.zenOrig !== null },
    { mode: "open", open: (s) => !!s.opener, type: (s, text) => s.opener && workspace.opType(s.opener.q + text) },
    {
      mode: "switch",
      open: (s) => !!s.switcher,
      type: (_, text) => switcher.swInput(text),
    },
    { mode: "prompt", open: (s) => !!s.prompt, type: (s, text) => s.prompt && promptType(s.prompt.value + text) },
  ]

  return (s: UI, key: KeyEvent, text: string | null) => {
    const p = popupModes.find((x) => x.open(s))
    if (!p) return false
    if (!dispatch(actions, [p.mode], key) && text) p.type?.(s, text)
    return true
  }
}

/** The modes over the document that take every key (labels, the help sheet, the panel filter); false when none is on. */
function makeModalKey(c: AppCtx, { links, popups }: Features, actions: Actions) {
  const { set, derive } = c
  const { liveLabels, labelType } = links
  const { filterText, filterType } = popups

  /** Link labels: a label letter narrows them, any other key cancels them. */
  const labelKey = (key: KeyEvent, text: string | null) => {
    // labels the view has moved out from under (reload, resize, scroll) are dropped and the key is swallowed, like any other that cancels
    if (!liveLabels()) return void set({ labels: null })
    if (dispatch(actions, ["label"], key)) return
    if (text && /^[a-z]$/.test(text)) return labelType(text)
    return void set({ labels: null }) // any other key cancels
  }

  return (s: UI, key: KeyEvent, text: string | null) => {
    if (s.labels) {
      labelKey(key, text)
      return true
    }
    if (s.help) {
      if (!dispatch(actions, ["help"], key)) set({ help: false })
      return true
    }
    // the panel filter row captures typing, j k 1 2 3 / ? included
    if (s.filterTyping && derive().sideFocus) {
      if (!dispatch(actions, ["filter"], key) && text) filterType(filterText() + text)
      return true
    }
    return false
  }
}

/** The key handler: C-c, then the open popup or typing, then zen, the welcome page and the bindings of the focused view. */
export function makeOnKey(c: AppCtx, f: Features, actions: Actions, docMode: () => Ctx) {
  const { ui, derive } = c
  const { welcomeKey, stopWelcome } = f.workspace
  const popupKey = makePopupKey(f, actions)
  const modalKey = makeModalKey(c, f, actions)

  /** Zen, the welcome page, or the global keys and the focused view's. */
  const viewKey = (s: UI, key: KeyEvent) => {
    // zen bindings shadow the document ones; n / N and the global keys fall through
    if (derive().L.zen) return void dispatch(actions, ["zen", "global", "doc"], key, ZEN_OFF)
    if (!s.openPath && docMode() === "doc" && welcomeKey(key)) return
    dispatch(actions, ["global", modeOf(docMode())], key, s.openPath ? undefined : WELCOME_OFF)
  }

  return (key: KeyEvent) => {
    // C-c quits the same way from every popup and mode (OpenTUI would only end the renderer)
    if (matchKey("C-c", key)) return actions.quit(key)
    stopWelcome()
    const s = ui.current
    if (s.zen && s.zenCfg.ghost) f.zen.pokeGhost()
    const text = typed(key)
    if (popupKey(s, key, text) || modalKey(s, key, text)) return
    viewKey(s, key)
  }
}
