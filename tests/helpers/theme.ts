// The theme the tests render in (looked up by name: list order is not identity) and reading colours back from a captured frame.
import { themeByName } from "../../src/theme/theme"

export const brothy = themeByName("brothy")

/** A captured frame's colour as `#rrggbb`; null for a transparent cell. */
export const hex = (c: { r: number; g: number; b: number; a: number }) =>
  c.a === 0
    ? null
    : "#" +
      [c.r, c.g, c.b]
        .map((x) =>
          Math.round(x * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
