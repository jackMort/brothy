// The page frame's behaviour: brothy's keys on the page, the running head (`Title › section`), the progress line, the
// reading marker in Outline, the panel tabs and the drawer. Keys never fire while typing (search, inputs) or with a
// dialog open, apart from esc and the dialog's own keys.

const root = document.documentElement
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {}
  },
}

// ---------- headings: the running head, [ ] and the Outline marker ----------
const heads = () => $$("[data-head], .sl-markdown-content h2")
const section = $("[data-section]"),
  sep = $("[data-section-sep]")
const outline = $$<HTMLAnchorElement>("[data-panel='outline'] a")
const NAV = () => ($(".top")?.getBoundingClientRect().height ?? 48) + 16

function readingAt() {
  const y = NAV() + 24
  let cur: HTMLElement | null = null
  for (const h of heads()) if (h.getBoundingClientRect().top <= y) cur = h
  return cur
}

// ---------- progress line ----------
const read = $("[data-read]"),
  prog = $(".prog i"),
  minutes = Number($(".foot")?.dataset.minutes ?? 0)

/** the running head: the reading heading's label, and its separator */
function setRunningHead(cur: HTMLElement | null) {
  const label = cur ? (cur.dataset.head ?? cur.textContent?.trim() ?? "") : ""
  if (section) section.textContent = label
  sep?.toggleAttribute("hidden", !label)
}
/** the reading marker in Outline: the reading heading's link, else the first */
function markOutline(cur: HTMLElement | null) {
  const id = cur?.id
  outline.forEach((a) => a.classList.toggle("on", !!id && a.hash === `#${id}`))
  if (!cur) outline[0]?.classList.add("on")
}
/** the progress line and the footer's "% · n min left" */
function setProgress() {
  const max = root.scrollHeight - innerHeight
  const p = max > 0 ? Math.min(100, Math.round((scrollY / max) * 100)) : 100
  prog?.style.setProperty("--read", `${p}%`)
  if (read) read.textContent = minutes ? `${p}% · ${Math.max(0, Math.ceil(minutes * (1 - p / 100)))} min left` : `${p}%`
}
function onScroll() {
  const cur = readingAt()
  setRunningHead(cur)
  markOutline(cur)
  setProgress()
}
addEventListener("scroll", onScroll, { passive: true })
addEventListener("resize", onScroll)
onScroll()

function jump(dir: 1 | -1) {
  const tops = heads().map((h) => h.getBoundingClientRect().top - NAV())
  const i = dir > 0 ? tops.findIndex((t) => t > 2) : tops.findLastIndex((t) => t < -2)
  if (i >= 0) scrollBy({ top: tops[i]! })
  else if (dir < 0) scrollTo({ top: 0 })
}

// ---------- panel: tabs (remembered), the drawer, ^b ----------
const tabs = $$<HTMLButtonElement>("[data-tab]")
function view(name: string) {
  if (!tabs.length) return
  tabs.forEach((b) => {
    const on = b.dataset.tab === name
    b.setAttribute("aria-selected", String(on))
    b.tabIndex = on ? 0 : -1
    const p = $(`[data-panel="${b.dataset.tab}"]`)
    if (p) p.hidden = !on
  })
  store.set("brothy-panel", name)
}
tabs.forEach((b) => b.addEventListener("click", () => view(b.dataset.tab!)))
const saved = store.get("brothy-panel")
if (saved && tabs.some((b) => b.dataset.tab === saved)) view(saved)

const narrow = matchMedia("(max-width: 899px)")
const drawer = (open?: boolean) => {
  const on = open ?? !root.classList.contains("drawer-open")
  root.classList.toggle("drawer-open", on)
  $$("[data-drawer]").forEach((b) => b.setAttribute("aria-expanded", String(on)))
  $(".panel")?.toggleAttribute("inert", narrow.matches && !on)
}
const panelToggle = () => {
  if (!$(".panel")) return
  if (narrow.matches) return drawer()
  const hidden = !root.classList.contains("panel-hidden")
  root.classList.toggle("panel-hidden", hidden)
  store.set("brothy-panel-hidden", hidden ? "1" : "")
}
$$("[data-drawer]").forEach((b) => b.addEventListener("click", () => drawer()))
$(".scrim")?.addEventListener("click", () => drawer(false))
$(".panel")?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a") && narrow.matches) drawer(false)
})
const syncNarrow = () => {
  if (!narrow.matches) drawer(false)
  else $(".panel")?.toggleAttribute("inert", !root.classList.contains("drawer-open"))
}
narrow.addEventListener("change", syncNarrow)
syncNarrow()

// ---------- the welcome page's "Start here" rows ----------
const rows = $$<HTMLAnchorElement>("[data-start] a")
let sel = 0
const pick = (i: number) => {
  sel = (i + rows.length) % rows.length
  rows.forEach((r, k) => r.classList.toggle("on", k === sel))
}
rows.forEach((r, i) => r.addEventListener("pointermove", () => pick(i)))
const startVisible = () => {
  const r = $("[data-start]")?.getBoundingClientRect()
  return !!r && r.top < innerHeight && r.bottom > 0
}

// ---------- the keys sheet ----------
const sheet = $<HTMLDialogElement>("dialog.sheet")
sheet?.addEventListener("click", (e) => {
  if (e.target === sheet) sheet.close()
})

// ---------- keys ----------
function typing(t: EventTarget | null) {
  const el = t as HTMLElement | null
  return !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")
}
const tour = () => $<HTMLElement & { toggle?: () => void }>("[data-cast]")
const tourVisible = () => {
  const r = tour()?.getBoundingClientRect()
  return !!r && r.top < innerHeight * 0.75 && r.bottom > innerHeight * 0.25
}

/** opens a panel tab, and the drawer when the panel is one */
const showTab = (name: string) => () => {
  view(name)
  if (narrow.matches) drawer(true)
}
/** key → action for the keys that always work (`C-` for ctrl) */
const KEYS: Record<string, () => void> = {
  j: () => scrollBy({ top: 64 }),
  k: () => scrollBy({ top: -64 }),
  g: () => scrollTo({ top: 0 }),
  G: () => scrollTo({ top: root.scrollHeight }),
  "]": () => jump(1),
  "[": () => jump(-1),
  "1": showTab("files"),
  "2": showTab("outline"),
  "3": showTab("info"),
  t: () => $("[data-theme-open]")?.click(),
  "C-b": panelToggle,
  "/": () => $("site-search button[data-open-modal]")?.click(),
  "?": () => sheet?.showModal(),
  Escape: () => drawer(false),
}
/** the Start here rows: arrows move, enter opens */
function startKeys(onLink: boolean): Record<string, () => void> {
  if (!rows.length || !startVisible() || onLink) return {}
  return { ArrowDown: () => pick(sel + 1), ArrowUp: () => pick(sel - 1), Enter: () => rows[sel]!.click() }
}
/** the tour in view: space plays and pauses it */
function tourKeys(onLink: boolean): Record<string, () => void> {
  if (!tour() || !tourVisible() || onLink) return {}
  return { " ": () => tour()!.toggle?.() }
}
/** the front page: `i` jumps to the install block */
function installKeys(): Record<string, () => void> {
  const install = $("#install")
  return rows.length && install ? { i: () => install.scrollIntoView() } : {}
}
/** the keys that depend on the page */
const pageKeys = (onLink: boolean) => ({ ...startKeys(onLink), ...tourKeys(onLink), ...installKeys() })
/** the keys sheet is open: any key closes it, as in brothy */
function sheetKey(e: KeyboardEvent) {
  if (!e.ctrlKey && e.key !== "Tab") {
    e.preventDefault()
    sheet!.close()
  }
}
/** the cast player owns space, enter and the arrows while it has focus */
const playerKey = (e: KeyboardEvent) => !!(e.target as HTMLElement).closest?.("[data-cast]") && [" ", "Enter", "ArrowLeft", "ArrowRight"].includes(e.key)

/** the action for this key press: `C-b` is the only ctrl binding, and ctrl turns the plain keys off */
function actionFor(e: KeyboardEvent) {
  const k = e.ctrlKey ? `C-${e.key.toLowerCase()}` : e.key
  const onLink = !!(e.target as HTMLElement).closest?.("a, button")
  const f = { ...KEYS, ...pageKeys(onLink) }[k]
  return f && (k.startsWith("C-") ? k === "C-b" : !e.ctrlKey) ? f : undefined
}

/** the page leaves this key press alone: modified, handled, typed into a field, or the search dialog's */
const notOurs = (e: KeyboardEvent) => e.defaultPrevented || e.altKey || e.metaKey || typing(e.target) || !!document.querySelector("dialog[open]:not(.sheet)")

addEventListener("keydown", (e) => {
  if (notOurs(e)) return
  if (sheet?.open) return sheetKey(e)
  if (playerKey(e)) return
  const f = actionFor(e)
  if (!f) return
  e.preventDefault()
  f()
})
