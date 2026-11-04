// App: pictures in Preview: the reserved rows, the <image> over them, the cell size, what falls back to text.
import { expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NativeImage, TextRenderable } from "@opentui/core"
import { hexOf } from "../../src/graph/canvas"
import { solidPng } from "../helpers/png"
import { hex } from "../helpers/theme"
import {
  B,
  filler,
  HINT_ROW,
  imagesOf,
  keys,
  kittyTerminal,
  type Setup,
  setResolution,
  sleep,
  spansOf,
  useAppHarness,
  W120,
  waitFor,
  waitFrame,
  walk,
  withClock,
} from "./helpers"

const { tmp, mount, savedConfig, configFile } = useAppHarness()

/** Cells of 10 × 20 pixels on the 100 × 30 terminal, the harness's default. */
const RES = { width: 1000, height: 600 }
/** 20 columns and 5 rows at that cell size. */
const PLAN = solidPng(200, 100, [200, 100, 50, 255])
/** First and last body rows at 30 rows: the top line, the gap, then 26 rows. */
const BODY_TOP = 2
const BODY_END = 28

function vault(note: string, files: Record<string, Uint8Array> = { "plan.png": PLAN }) {
  const d = tmp({ "n.md": note })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(d, name), bytes)
  return d
}
const NOTE = "# Top\n\n![Plan](plan.png)\n\n# After\n\nend"
const LONG = `# Top\n\n![Plan](plan.png)\n\n${filler(40)}\n\n![Plan](plan.png)\n\n${filler(40)}`

/** The note mounted on a kitty terminal that has said its pixel size. */
async function pictured(note = NOTE, files?: Record<string, Uint8Array>, size?: typeof W120) {
  const s = await mount(vault(note, files), "n.md", size && { size })
  kittyTerminal(s)
  setResolution(s, RES)
  return s
}
const shown = (s: Setup, n = 1) => waitFor(s, () => imagesOf(s).length === n)

test("no image support: the placeholder row, and the heading after it", async () => {
  const s = await mount(vault(NOTE), "n.md")
  const f = await waitFrame(s, (x) => x.includes("▣ Plan · 200×100 · ⏎ view"))
  expect(f).toContain("After")
  expect(imagesOf(s)).toHaveLength(0)
})

test("kitty: an <image> over the reserved rows once the resolution lands", async () => {
  const s = await pictured()
  await shown(s)
  const [img] = imagesOf(s)
  expect(img!.source).toBeInstanceOf(NativeImage)
  expect([img!.width, img!.height]).toEqual([20, 5])
  const f = s.captureCharFrame()
  const rows = f.split("\n")
  // the heading row, its rule row, a blank, the picture, its caption
  const caption = rows.findIndex((r) => r.includes("Plan"))
  expect(caption).toBe(img!.y + 5)
  expect(f).toContain("After")
  expect(f).not.toContain("⏎ view")
})

test("the decoded picture has the size of its cells, background underneath", async () => {
  const s = await pictured("![Clear](clear.png)", { "clear.png": solidPng(200, 100, [0, 0, 0, 0]) })
  await shown(s)
  const source = imagesOf(s)[0]!.source as NativeImage
  expect([source.width, source.height]).toEqual([200, 100])
  const px = source.raw().data
  expect(hexOf([px[0]!, px[1]!, px[2]!])).toBe(B.background)
  expect(px[3]).toBe(255)
})

test("T: the picture is decoded again with nothing under it", async () => {
  const s = await pictured("![Clear](clear.png)", { "clear.png": solidPng(200, 100, [0, 0, 0, 0]) })
  await shown(s)
  const opaque = imagesOf(s)[0]!.source
  await keys(s, "T")
  await waitFor(s, () => imagesOf(s).length === 1 && imagesOf(s)[0]!.source !== opaque)
  expect((imagesOf(s)[0]!.source as NativeImage).raw().data[3]).toBe(0)
})

test("no resolution → no image, then image", async () => {
  const s = await mount(vault(NOTE), "n.md")
  kittyTerminal(s)
  // laid out as pixels with the default 8 × 16 cell: 25 columns, 6 rows
  await waitFrame(s, (f) => f.includes("Plan") && !f.includes("⏎ view"))
  await sleep(150)
  await s.renderOnce()
  expect(imagesOf(s)).toHaveLength(0)
  setResolution(s, RES)
  await shown(s)
  expect([imagesOf(s)[0]!.width, imagesOf(s)[0]!.height]).toEqual([20, 5])
})

test("a resolution that never lands: text; it landing after all brings the picture", async () => {
  const s = await mount(vault(NOTE), "n.md")
  kittyTerminal(s)
  await waitFrame(s, (f) => f.includes("▣ Plan · 200×100 · ⏎ view"), 3000)
  setResolution(s, RES)
  await keys(s, "j")
  await shown(s)
})

test("a resize drops the cell until the new resolution lands, and the picture follows it", async () => {
  const s = await pictured()
  await shown(s)
  setResolution(s, null)
  s.renderer.emit("resize", 100, 30)
  await waitFor(s, () => imagesOf(s).length === 0)
  expect(s.captureCharFrame()).not.toContain("⏎ view")
  setResolution(s, { width: 500, height: 300 })
  await shown(s)
  // 5 × 10 pixels a cell: the picture is 40 columns wide now, 10 rows
  const [img] = imagesOf(s)
  expect([img!.width, img!.height]).toEqual([40, 10])
  const source = img!.source as NativeImage
  expect([source.width, source.height]).toEqual([200, 100])
})

test("picture partly above top: cropped, inside the body, never over a status row", async () => {
  const s = await pictured(LONG)
  await shown(s)
  const whole = imagesOf(s)[0]!
  const y = whole.y
  expect(whole.crop).toEqual({ left: 0, top: 0, width: 200, height: 100 })
  await keys(s, ...Array(y - BODY_TOP + 2).fill("j"))
  await shown(s)
  const img = imagesOf(s)[0]!
  expect([img.y, img.height]).toEqual([BODY_TOP, 3])
  expect(img.crop).toEqual({ left: 0, top: 40, width: 200, height: 60 })
})

test("a picture cut by the bottom edge shows its first rows only", async () => {
  // the heading's 2 rows and a blank, then filler rows and their gaps: the picture starts 3 rows above the bottom
  const rows = BODY_END - BODY_TOP - 3
  const lead = Math.floor((rows - 3) / 2)
  const s = await pictured(`# Top\n\n${filler(lead)}\n\n![Plan](plan.png)\n\nend`)
  await shown(s)
  const img = imagesOf(s)[0]!
  expect(img.y + img.height).toBeLessThanOrEqual(BODY_END)
  expect(img.height).toBeLessThan(5)
  expect(img.crop).toEqual({ left: 0, top: 0, width: 200, height: img.height * 20 })
})

test("a picture scrolled out is not drawn, and comes back", async () => {
  const s = await pictured(LONG)
  await shown(s)
  await keys(s, "C-d", "C-d")
  await waitFor(s, () => imagesOf(s).length === 0)
  await keys(s, "g", "g")
  await shown(s)
})

test("the wheel over a picture scrolls the note", async () => {
  const s = await pictured(LONG)
  await shown(s)
  const img = imagesOf(s)[0]!
  const y = img.y
  await s.mockMouse.scroll(img.x + 5, y + 1, "down")
  await waitFor(s, () => imagesOf(s)[0]?.y !== y)
})

test("a landing's footnote: the picture stops above it", async () => {
  const tall = solidPng(200, 400, [200, 100, 50, 255])
  const note = `# T\n\n## One\n\nold\n\n${filler(3)}\n\n![Plan](plan.png)\n\nend`
  const d = vault(note, { "plan.png": tall })
  const s = await mount(d, "n.md", { size: W120 })
  kittyTerminal(s)
  setResolution(s, { width: 1200, height: 600 })
  await shown(s)
  writeFileSync(join(d, "n.md"), note.replace("old", "new"))
  await waitFrame(s, (f) => f.includes("changed"), 4000)
  const f = await keys(s, "3", "j", "enter")
  const rule = f.split("\n").findIndex((r) => /─{16} {2,}¹ of 1/.test(r))
  expect(rule).toBeGreaterThan(0)
  await shown(s)
  const img = imagesOf(s)[0]!
  expect(img.y + img.height).toBe(rule - 1)
})

/** The rows of the `<text>` boxes that reach into `img`'s cells: an empty one counts, it would paint black all the same. */
const textOn = (s: Setup, img: ReturnType<typeof imagesOf>[number]) =>
  walk(s.renderer.root)
    .filter((r) => {
      if (!(r instanceof TextRenderable) || r.y < img.y || r.y >= img.y + img.height) return false
      if (r.x >= img.x + img.width || r.x + r.width <= img.x) return false
      const text = r.plainText.trimEnd()
      return !text || r.x + text.length > img.x
    })
    .map((r) => r.y)

test("no <text> on a picture's rows", async () => {
  const s = await pictured()
  await shown(s)
  expect(textOn(s, imagesOf(s)[0]!)).toEqual([])
})

test("in a quote the bar keeps its row and stays left of the picture", async () => {
  const s = await pictured("> ![Plan](plan.png)\n>\n> quoted")
  await shown(s)
  const img = imagesOf(s)[0]!
  expect(textOn(s, img)).toEqual([])
  const rows = s.captureCharFrame().split("\n")
  for (let y = img.y; y < img.y + img.height; y++) expect(rows[y]!.slice(0, img.x)).toContain("▎")
})

test("a picture that won't decode says so on its first row; one toast for the note", async () => {
  const broken = PLAN.subarray(0, 40)
  const s = await pictured("# Top\n\n![One](one.png)\n\ntext\n\n![Two](two.png)\n\nend", {
    "one.png": broken,
    "two.png": broken,
  })
  const f = await waitFrame(s, (x) => x.includes("▣ One · unreadable") && x.includes("▣ Two · unreadable"))
  expect(imagesOf(s)).toHaveLength(0)
  expect(f.match(/pictures · \w+ unreadable/g)).toHaveLength(1)
  const warn = spansOf(s).find((sp) => sp.text.includes("unreadable") && !sp.text.includes("pictures"))
  expect(hex(warn!.fg)).toBe(B.warning)
})

test("pixels failing in the terminal: text for the rest of the run", async () => {
  const s = await pictured()
  await shown(s)
  imagesOf(s)[0]!.onError?.(new Error("no"))
  const f = await waitFrame(s, (x) => x.includes("▣ Plan · 200×100 · ⏎ view"))
  expect(f).toContain("pictures · pixels failed · text instead")
  expect(imagesOf(s)).toHaveLength(0)
})

test("Source draws no picture", async () => {
  const s = await pictured()
  await shown(s)
  const f = await keys(s, "s")
  expect(imagesOf(s)).toHaveLength(0)
  expect(f).toContain("![Plan](plan.png)")
})

test("minimap: a picture's reserved rows are a muted block, past the band too", async () => {
  const d = vault(`# Top\n\n${filler(60)}\n\n![Plan](plan.png)\n\n${filler(60)}`)
  const s = await mount(d, "n.md", { size: W120 })
  kittyTerminal(s)
  setResolution(s, { width: 1200, height: 600 })
  const offBand = () =>
    spansOf(s).filter((sp) => /[⠁-⣿]/.test(sp.text) && hex(sp.fg) === B.textMuted && hex(sp.bg) !== B.backgroundElement)
  await waitFor(s, () => offBand().length > 0)
})

test("zen keeps the rows and draws no picture yet", async () => {
  const s = await pictured()
  await shown(s)
  const f = await keys(s, "z")
  expect(imagesOf(s)).toHaveLength(0)
  expect(f).toContain("Plan")
  expect(f).not.toContain("⏎ view")
})

test("a piped document resolves pictures from the folder", async () => {
  const s = await mount(vault(NOTE), undefined, { stdin: NOTE })
  kittyTerminal(s)
  setResolution(s, RES)
  await shown(s)
})

test("a piped document keeps Files empty but a wikilink finds the picture by name once the folder is scanned", async () => {
  const d = tmp({ "n.md": "x" })
  writeFileSync(join(d, "plan.png"), PLAN)
  const s = await mount(d, undefined, { stdin: "![[plan.png]]" })
  kittyTerminal(s)
  setResolution(s, RES)
  await shown(s)
})

const PLACEHOLDER = "▣ Plan · 200×100 · ⏎ view"
const hintRow = (f: string) => f.split("\n")[HINT_ROW]!

test("p: text and the placeholder, saved; p again: pixels back, saved; the footer names what p switches to", async () => {
  const s = await pictured(NOTE, undefined, W120)
  await shown(s)
  expect(hintRow(s.captureCharFrame())).toContain("p text")
  let f = await keys(s, "p")
  expect(f).toContain("pictures · text")
  expect(f).toContain(PLACEHOLDER)
  expect(imagesOf(s)).toHaveLength(0)
  // once the toast has gone, the footer has room for the hint again
  await sleep(2500)
  await keys(s, "tab", "tab")
  expect(hintRow(await waitFrame(s, (x) => hintRow(x).includes("p pixels")))).toContain("p pixels")
  expect(savedConfig().pictures).toBe("text")
  f = await keys(s, "p")
  expect(f).toContain("pictures · pixels")
  await shown(s)
  expect(savedConfig().pictures).toBe("pixels")
})

test("p where pixels can't show: the toast says so and nothing is saved", async () => {
  const s = await mount(vault(NOTE), "n.md")
  expect(await keys(s, "p")).toContain("pictures · pixels unavailable here · text")
  expect(existsSync(configFile())).toBe(false)
})

test("p after pixels failed: the toast, nothing saved", async () => {
  const s = await pictured()
  await shown(s)
  imagesOf(s)[0]!.onError?.(new Error("no"))
  await waitFrame(s, (x) => x.includes(PLACEHOLDER))
  // the failure's own error toast holds for a while; let it pass
  const later = new Date(Date.now() + 10_000)
  expect(await withClock(later, () => keys(s, "p"))).toContain("pictures · pixels unavailable here · text")
  expect(existsSync(configFile())).toBe(false)
})

test("p while the resolution never landed: the toast, nothing saved", async () => {
  const s = await mount(vault(NOTE), "n.md")
  kittyTerminal(s)
  await waitFrame(s, (f) => f.includes(PLACEHOLDER), 3000)
  expect(await keys(s, "p")).toContain("pictures · pixels unavailable here · text")
  expect(existsSync(configFile())).toBe(false)
})

test("the footer offers p only for a note with a picture, and not in Source", async () => {
  const bare = await mount(vault("# Top\n\nno picture"), "n.md", { size: W120 })
  kittyTerminal(bare)
  setResolution(bare, RES)
  expect(hintRow(await keys(bare, "j"))).not.toContain("p ")
  const s = await pictured(NOTE, undefined, W120)
  await shown(s)
  expect(hintRow(s.captureCharFrame())).toContain("p text")
  expect(hintRow(await keys(s, "s"))).not.toContain("p ")
})

test("p works in zen", async () => {
  const s = await pictured()
  await shown(s)
  await keys(s, "z")
  expect(await keys(s, "p")).toContain("pictures · text")
  expect(savedConfig().pictures).toBe("text")
})
