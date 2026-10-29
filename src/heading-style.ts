// How the document draws headings (`#` cycles them; config `headings`). Pure, and a leaf, so config.ts can validate
// the setting without loading the renderer.

/** The heading styles, in the order `#` cycles through them; "classic" is the default. */
export const HEADING_STYLES = ["classic", "bars", "ladder", "rules"] as const
export type HeadingStyle = (typeof HEADING_STYLES)[number]
