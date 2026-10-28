const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹"
/** `n` in superscript digits (tab key numbers). */
export const superscript = (n: number) => [...String(n)].map((d) => SUP[Number(d)] ?? d).join("")
