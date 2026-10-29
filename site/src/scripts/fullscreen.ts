// The demo on a phone: below 560px the 104 columns are too small to read in place, so a tap opens the whole stage
// (wallpaper and window) full screen. It uses the Fullscreen API where there is one and asks for landscape; where
// there isn't (iPhone Safari) or the lock is refused, a fixed overlay turns the window sideways in portrait (CSS,
// `.is-full`). esc, back, or the close button leave it.

const SMALL = matchMedia("(max-width: 560px)")

export function mountFullscreen(stage: HTMLElement) {
  const win = stage.querySelector<HTMLElement & { toggle?: () => void }>("[data-cast]")
  const close = stage.querySelector<HTMLButtonElement>("[data-full-close]")
  if (!win) return
  let full = false

  async function open() {
    if (full) return
    full = true
    stage.classList.add("is-full")
    document.documentElement.classList.add("demo-full")
    close?.removeAttribute("hidden")
    history.pushState({ demoFull: true }, "")
    try {
      await stage.requestFullscreen?.({ navigationUI: "hide" })
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape")
    } catch {} // no API, or refused: the overlay (rotated in portrait) stands in
    if (!win!.classList.contains("is-playing")) win!.toggle?.()
    win!.focus({ preventScroll: true })
  }

  function shut(fromHistory = false) {
    if (!full) return
    full = false
    stage.classList.remove("is-full")
    document.documentElement.classList.remove("demo-full")
    close?.setAttribute("hidden", "")
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    try {
      screen.orientation.unlock?.()
    } catch {}
    if (!fromHistory && history.state?.demoFull) history.back()
  }

  // a tap on the picture opens it on a phone, before the player's own click (play / pause) sees it
  win.querySelector("canvas")?.addEventListener(
    "click",
    (e) => {
      if (!SMALL.matches || full) return
      e.stopPropagation()
      open()
    },
    true,
  )
  close?.addEventListener("click", () => shut())
  addEventListener("popstate", () => shut(true))
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) shut()
  })
  addEventListener(
    "keydown",
    (e) => {
      if (full && e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        shut()
      }
    },
    true,
  )
}
