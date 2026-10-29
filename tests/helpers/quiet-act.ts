/**
 * `testRender` leaves `IS_REACT_ACT_ENVIRONMENT` on for the renderer's whole life, so every state
 * update that arrives outside `act` (timers, key handlers, file watchers) logs an "act(...)" warning.
 * The UI is driven by real input and timers here, not by act-wrapped calls: turn the flag off after
 * the initial render, and back on only for `destroy()`, whose teardown runs `act` itself. Opentui's
 * own cleanup unmount during destroy is not wrapped, so that one warning is dropped there.
 * Every other console.error (real errors, other warnings) is passed through untouched.
 */
export function quietAct<T extends { renderer: { destroy: () => void } }>(setup: T): T {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  g.IS_REACT_ACT_ENVIRONMENT = false
  const destroy = setup.renderer.destroy.bind(setup.renderer)
  setup.renderer.destroy = () => {
    const error = console.error
    console.error = (...a: unknown[]) => {
      if (!String(a[0]).includes("was not wrapped in act")) error(...a)
    }
    g.IS_REACT_ACT_ENVIRONMENT = true // testRender's teardown unmounts inside act()
    try {
      destroy()
    } finally {
      console.error = error
    }
  }
  return setup
}
