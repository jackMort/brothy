// SVG pictures through resvg's WebAssembly build, loaded once on first use (the .wasm is embedded in the compiled binary).
import { NativeImage } from "@opentui/core"
import { initWasm, Resvg } from "@resvg/resvg-wasm"
import wasmPath from "@resvg/resvg-wasm/index_bg.wasm" with { type: "file" }

let ready = false
let loading: Promise<void> | null = null

/** Loads resvg once; every caller shares the one promise, so a failed load stays failed (an SVG then reads as unreadable). */
export const ensureSvg = (): Promise<void> =>
  // Bun.file, not node:fs: in the compiled binary the path lives in Bun's embedded filesystem.
  (loading ??= Bun.file(wasmPath)
    .arrayBuffer()
    .then((wasm) => initWasm(wasm))
    .then(() => {
      ready = true
    }))

/** An SVG drawn at `w` pixels wide (fonts: none loaded, so text in SVGs may not show). Needs `ensureSvg()` first. */
export function svgRaster(bytes: Uint8Array, w: number): NativeImage {
  if (!ready) throw new Error("svg renderer not loaded")
  const svg = new Resvg(new TextDecoder().decode(bytes), { fitTo: { mode: "width", value: w } })
  try {
    const out = svg.render()
    try {
      return NativeImage.fromRgba(out.pixels.slice(), out.width, out.height)
    } finally {
      out.free()
    }
  } finally {
    svg.free()
  }
}
