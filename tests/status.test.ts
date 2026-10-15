import { describe, expect, test } from "bun:test"
import {
  clusterText,
  fillWidth,
  fitHints,
  headerLayout,
  LOGO_HOLD,
  logoState,
  mainHeadingVisible,
  shrinkFolder,
  locationParts,
  nextToast,
  noteTitle,
  progressLabel,
  stateCluster,
  toastIcon,
  toastStep,
  truncate,
  tooSmall,
  truncateLeft,
  type Toast,
} from "../src/status"
import { width as sw } from "../src/markdown"

describe("truncate", () => {
  test("cuts at either end with …, by columns", () => {
    expect(truncate("abcdef", 4)).toBe("abc…")
    expect(truncate("abc", 4)).toBe("abc")
    expect(truncateLeft("Self Service", 8)).toBe("…Service")
    expect(truncateLeft("日本語", 5)).toBe("…本語")
  })
})

describe("noteTitle", () => {
  test("front-matter title first, quotes and markup stripped, key case-insensitive", () => {
    expect(noteTitle([["Title", '"Calm"']], "/v/x.md")).toBe("Calm")
    expect(noteTitle([["title", "*Calm* _tech_ `x`"]], "/v/x.md")).toBe("Calm tech x")
  })
  test("empty, quote-only or list titles fall back to the file name", () => {
    expect(noteTitle([["title", "  "]], "/v/x.md")).toBe("x")
    expect(noteTitle([["title", "''"]], "/v/x.md")).toBe("x")
    expect(noteTitle([["title", ["a"]]], "/v/x.md")).toBe("x")
  })
  test("extensions are dropped case-insensitively; dotfiles keep their name", () => {
    expect(noteTitle([], "/v/README.md")).toBe("README")
    expect(noteTitle([], "/v/notes.markdown")).toBe("notes")
    expect(noteTitle([], "/v/a.MDX")).toBe("a")
    expect(noteTitle([], "/v/.md")).toBe(".md")
  })
})

describe("locationParts", () => {
  const at = (room: number, section = "Status") =>
    locationParts("Reading/Calm", "Calm Technology", ["Calm Technology", "The periphery", section], room)
  test("everything fits; a first heading equal to the title is dropped", () => {
    expect(at(200)).toEqual({ folder: "Reading/Calm", title: "Calm Technology", ancestors: ["The periphery"], section: "Status" })
  })
  test("the folder loses segments from the left, then goes", () => {
    expect(at(50).folder).toBe("…/Calm")
    expect(at(40)).toEqual({ folder: "", title: "Calm Technology", ancestors: ["The periphery"], section: "Status" })
  })
  test("then the ancestors, outermost first", () => expect(at(30).ancestors).toEqual([]))
  test("then the section is cut, never below 8 columns, then dropped", () => {
    expect(at(30, "Status as periphery").section).toBe("Status as p…")
    expect(at(22).section).toBe("")
  })
  test("the title is cut last", () => expect(at(10).title).toBe("Calm Tech…"))
  test("wide characters are measured in columns", () => {
    expect(locationParts("", "日本語のノート", [], 9).title).toBe("日本語の…")
  })
  test("a note at the root has no folder", () => expect(locationParts(".", "a", [], 80).folder).toBe(""))
})

describe("stateCluster", () => {
  const base = { query: "periphery", matchIdx: 3 as number | null, count: 9, source: true, wide: true, zen: false }
  test("search, source and wide, in that order", () => {
    expect(stateCluster(base, 100).map(clusterText)).toEqual(["/periphery 3/9", "source", "wide"])
  })
  test("an unknown index shows –; no hits show no match", () => {
    expect(clusterText(stateCluster({ ...base, matchIdx: null }, 100)[0]!)).toBe("/periphery –/9")
    expect(clusterText(stateCluster({ ...base, count: 0 }, 100)[0]!)).toBe("/periphery no match")
  })
  test("wide drops first, then source; the query shrinks to 3 characters but i/n stays", () => {
    expect(stateCluster(base, 25).map(clusterText)).toEqual(["/periphery 3/9", "source"])
    expect(stateCluster(base, 20).map(clusterText)).toEqual(["/periphery 3/9"])
    expect(stateCluster(base, 10).map(clusterText)).toEqual(["/peri… 3/9"])
    expect(stateCluster(base, 3).map(clusterText)).toEqual(["/per… 3/9"])
  })
  test("zen shows no wide chip; no query, no search item", () => {
    expect(stateCluster({ ...base, zen: true }, 100).map(clusterText)).toEqual(["/periphery 3/9", "source"])
    expect(stateCluster({ ...base, query: "", source: false }, 100).map(clusterText)).toEqual(["wide"])
  })
})

describe("progressLabel", () => {
  test("percentage and time left", () => {
    expect(progressLabel({ top: 34, maxTop: 100, minutes: 3 })).toEqual({ pre: "", main: "34%", rest: " · 3 min left" })
  })
  test("at the end of a long note: 100% and no time", () => {
    expect(progressLabel({ top: 100, maxTop: 100, minutes: 1 })).toEqual({ pre: "", main: "100%", rest: "" })
  })
  test("a note that fits: 100% with the whole note's time; an empty one: just 100%", () => {
    expect(progressLabel({ top: 0, maxTop: 0, minutes: 2 })).toEqual({ pre: "", main: "100%", rest: " · 2 min left" })
    expect(progressLabel({ top: 0, maxTop: 0, minutes: 0 })).toEqual({ pre: "", main: "100%", rest: "" })
  })
  test("pages replace the percentage; the teleprompter adds its rate", () => {
    expect(progressLabel({ top: 9, maxTop: 50, minutes: 3, page: { index: 2, count: 7 } }).main).toBe("page 3 of 7")
    expect(progressLabel({ top: 9, maxTop: 50, minutes: 3, wpm: 220 }).pre).toBe("▶ 220 wpm · ")
  })
  test("fillWidth", () => {
    expect([fillWidth(0, 100, 61), fillWidth(50, 100, 61), fillWidth(5, 0, 61), fillWidth(200, 100, 61)]).toEqual([0, 31, 61, 61])
  })
})

describe("fitHints", () => {
  const items = [
    { key: "j k", word: "scroll" },
    { key: "/", word: "find" },
    { key: "?", word: "keys" },
  ]
  test("keeps the leading hints that fit, with 3-space gaps", () => {
    expect(fitHints(items, 100).length).toBe(3)
    expect(fitHints(items, 27).length).toBe(2)
    expect(fitHints(items, 19).length).toBe(2)
    expect(fitHints(items, 18).length).toBe(1)
    expect(fitHints(items, 0)).toEqual([])
  })
  test("spare hints are the first to go when not all fit", () => {
    const withSpare = [items[0]!, { key: "f", word: "links", spare: true }, ...items.slice(1)]
    expect(fitHints(withSpare, 100).map((h) => h.key)).toEqual(["j k", "f", "/", "?"])
    expect(fitHints(withSpare, 27).map((h) => h.key)).toEqual(["j k", "/"])
  })
})

describe("toasts", () => {
  const err: Toast = { msg: "nothing to find", kind: "error", at: 0 }
  test("an error that is still holding is not replaced by ok or info", () => {
    expect(nextToast(err, { msg: "reloaded", kind: "info", at: 1000 }, 1000)).toBe(err)
    expect(nextToast(err, { msg: "reloaded", kind: "info", at: 4000 }, 4000).msg).toBe("reloaded")
  })
  test("an error replaces anything; info replaces info", () => {
    const ok: Toast = { msg: "theme · x", kind: "ok", at: 0 }
    expect(nextToast(ok, err, 10)).toBe(err)
    expect(nextToast(ok, { msg: "b", kind: "info", at: 10 }, 10).msg).toBe("b")
  })
  test("toastStep holds by kind, then fades", () => {
    expect(toastStep({ msg: "", kind: "info", at: 0 }, 1799)).toBe(0)
    expect(toastStep({ msg: "", kind: "info", at: 0 }, 1800)).toBe(1)
    expect(toastStep(err, 3999)).toBe(0)
    expect(toastStep(err, 4480)).toBeNull()
  })
  test("icons", () => {
    expect(toastIcon(err)).toBe("✗")
    expect(toastIcon({ msg: "theme", kind: "ok", at: 0 })).toBe("✓")
    expect(toastIcon({ msg: "reloaded from disk", kind: "info", at: 0 })).toBe("↻")
    expect(toastIcon({ msg: "measure 80", kind: "info", at: 0 })).toBe("·")
  })
})

describe("shrinkFolder", () => {
  const deep = "Home/Cookbook/Stockpots/Simmered/Onion Soups"
  test("a folder that fits is shown in full with ' / ' joints", () => {
    expect(shrinkFolder("Kitchenware/brothy/specs", 40)).toBe("Kitchenware / brothy / specs")
  })
  test("one that does not fit becomes first / … / last", () => {
    expect(shrinkFolder(deep, 30)).toBe("Home / … / Onion Soups")
  })
  test("two segments that do not fit keep the last, then cut it", () => {
    expect(shrinkFolder("Home/Onion Soups", 14)).toBe("Onion Soups")
    expect(shrinkFolder("Home/Onion Soups", 8)).toBe("Onion S…")
  })
  test("when first / … / last is still too wide, falls back to … / last", () => {
    expect(shrinkFolder(deep, 16)).toBe("… / Onion Soups")
  })
  test("empty folder or no room is empty", () => {
    expect(shrinkFolder("", 20)).toBe("")
    expect(shrinkFolder(deep, 0)).toBe("")
  })
})

describe("logoState", () => {
  test("watching by default, live for LOGO_HOLD after a reload, gone while the file is missing", () => {
    expect(logoState({ gone: false, reloadedAt: null, now: 5000 })).toBe("watching")
    expect(logoState({ gone: false, reloadedAt: 4500, now: 5000 })).toBe("live")
    expect(logoState({ gone: false, reloadedAt: 5000 - LOGO_HOLD, now: 5000 })).toBe("watching")
    expect(logoState({ gone: true, reloadedAt: 4900, now: 5000 })).toBe("gone")
  })
})

describe("mainHeadingVisible", () => {
  const hs = [
    { depth: 1, text: "Calm Technology", line: 0 },
    { depth: 2, text: "Periphery", line: 30 },
  ]
  test("true while the first heading equal to the title is on screen", () => {
    expect(mainHeadingVisible(hs, "Calm Technology", 0, 20)).toBe(true)
    expect(mainHeadingVisible(hs, "calm technology ", 0, 20)).toBe(true)
  })
  test("false once scrolled past it, or when no heading is the title", () => {
    expect(mainHeadingVisible(hs, "Calm Technology", 1, 20)).toBe(false)
    expect(mainHeadingVisible(hs, "Other", 0, 20)).toBe(false)
    expect(mainHeadingVisible(hs, "Periphery", 0, 20)).toBe(false)
    expect(mainHeadingVisible(hs, "Periphery", 20, 20)).toBe(true)
  })
})

describe("headerLayout", () => {
  const deep = "Home/Cookbook/Stockpots/Simmered/Onion Soups"
  // layout() columns: SW = clamp(27% of W, 24, 40); text starts at 1 + SW + 1 + pad when the panel is inline
  const at = (W: number, o: Partial<Parameters<typeof headerLayout>[0]> = {}) => {
    const inline = W >= 100
    const SW = Math.min(40, Math.max(24, Math.round(W * 0.27)))
    const areaW = W - 2 - (inline ? SW + 1 : 0)
    const CW = Math.max(20, Math.min(80, areaW - 4))
    const textLeft = 1 + (inline ? SW + 1 : 0) + Math.floor((areaW - CW) / 2)
    return headerLayout({
      inline, SW, textLeft, textWidth: CW, zen: false, gap: true, vault: "My Vault", folder: deep,
      title: "Onion Gratin (Stovetop Steps)", trail: ["Flavour base — how flavours build"],
      query: "", matchIdx: null, count: 0, source: false, wide: false, ...o,
    })
  }
  const head = (l: ReturnType<typeof headerLayout>) => {
    const h = l.head
    return (h.folder ? h.folder + " / " : "") + h.title + h.ancestors.map((a) => " › " + a).join("") + (h.section ? " › " + h.section : "")
  }

  test("inline panel (120, 160): folder over the panel, title at the text's left edge", () => {
    for (const W of [120, 160]) {
      const l = at(W)
      expect(l.panel).toEqual({ col: 2, text: "Home / … / Onion Soups" })
      expect(l.head.folder).toBe("")
      expect(l.head.col).toBeGreaterThanOrEqual(W === 120 ? 36 : 60)
    }
    expect(at(120).head.col).toBe(36)
    expect(at(160).head.col).toBe(60)
  })
  test("a root note shows the vault name over the panel", () => {
    expect(at(120, { folder: "." }).panel?.text).toBe("My Vault")
  })
  test("a full path is shown when it fits", () => {
    expect(at(160, { folder: "Kitchenware/brothy/specs" }).panel?.text).toBe("Kitchenware / brothy / specs")
  })
  test("the cluster ends at the text's right edge, not the terminal's", () => {
    const l = at(120, { query: "tool", matchIdx: 3, count: 25, source: true })
    expect(l.cluster.length).toBe(2)
    expect(l.clusterCol + l.clusterWidth).toBe(36 + 80)
    expect(l.clusterCol + l.clusterWidth).toBeLessThan(120 - 2)
  })
  test("the head never runs into the cluster", () => {
    const l = at(120, { query: "tool", matchIdx: 3, count: 25, source: true })
    expect(l.head.col + sw(head(l))).toBeLessThanOrEqual(l.clusterCol - 3)
  })
  test("the gap row's rule spans the text column only; none in zen or without a gap row", () => {
    expect(at(120).rule).toEqual({ col: 36, width: 80 })
    expect(at(120, { gap: false }).rule).toBeNull()
    expect(at(120, { zen: true, inline: false }).rule).toBeNull()
  })
  test("drawer width (80): everything inline, the immediate folder leads the title", () => {
    const l = at(80, { trail: [] })
    expect(l.panel).toBeNull()
    expect(l.head.folder).toBe("Onion Soups")
    expect(head(l)).toBe("Onion Soups / Onion Gratin (Stovetop Steps)")
  })
  test("a root note has no folder in drawer width", () => {
    expect(at(80, { folder: "." }).head.folder).toBe("")
  })
  test("zen has no panel and no folder", () => {
    const l = at(80, { zen: true, inline: false })
    expect(l.panel).toBeNull()
    expect(l.head.folder).toBe("")
  })
  test("60 columns: pressure drops the folder first, then parent headings, then cuts the title", () => {
    const tight = (o: Partial<Parameters<typeof headerLayout>[0]>) => at(60, { trail: ["Parent", "Flavour base — how flavours build"], ...o })
    const full = tight({ title: "Short", trail: ["Parent", "Section"] })
    expect(head(full)).toBe("Onion Soups / Short › Parent › Section")
    const noFolder = tight({ title: "A fairly long note title", trail: ["Parent", "Section is long"] })
    expect(noFolder.head.folder).toBe("")
    expect(noFolder.head.ancestors).toEqual(["Parent"])
    const noAnc = tight({ title: "A fairly long note title here", trail: ["Parent heading", "Section is long"] })
    expect(noAnc.head.ancestors).toEqual([])
    const cut = tight({ title: "An extremely long note title that cannot possibly fit in the column", trail: [] })
    expect(cut.head.title.endsWith("…")).toBe(true)
    for (const l of [full, noFolder, noAnc, cut]) expect(l.head.col + sw(head(l))).toBeLessThanOrEqual(60 - 2)
  })
  test("nothing overflows its width at 60, 80, 120, 160", () => {
    for (const W of [60, 80, 120, 160]) {
      const l = at(W, { query: "periphery", matchIdx: 1, count: 115, source: true, wide: true })
      expect(l.head.col + sw(head(l))).toBeLessThanOrEqual(W)
      expect(l.clusterCol + l.clusterWidth).toBeLessThanOrEqual(W - 1)
      if (l.panel) expect(l.panel.col + sw(l.panel.text)).toBeLessThan(l.head.col)
    }
  })
})

describe("wordmark", () => {
  const { LOGO, WORDMARK, WORDMARK_W, fitWordmark } = require("../src/status")
  const { width } = require("../src/markdown")
  test("logo is one cell", () => expect(width(LOGO)).toBe(1))
  test("rows are 3, equal width in cells", () => {
    expect(WORDMARK.length).toBe(3)
    for (const l of WORDMARK) expect(width(l)).toBe(WORDMARK_W)
  })
  test("fit: needs width and height", () => {
    expect(fitWordmark(WORDMARK_W, 3)).toBe(WORDMARK)
    expect(fitWordmark(WORDMARK_W - 1, 10)).toBeNull()
    expect(fitWordmark(80, 2)).toBeNull()
  })
})

describe("tooSmall", () => {
  test("whole words only, each line within W, always names the minimum", () => {
    for (const [W, H] of [[10, 3], [20, 5], [40, 10], [5, 2], [59, 20]] as const) {
      const lines = tooSmall(W, H)
      expect(lines.join(" ")).toContain("60×14")
      for (const l of lines) expect(sw(l)).toBeLessThanOrEqual(W)
    }
    expect(tooSmall(80, 10)).toEqual(["terminal too small (80×10) · need 60×14"])
    expect(tooSmall(20, 5)).toEqual(["too small (20×5)", "need 60×14"])
  })
})
