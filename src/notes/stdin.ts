// A piped document, read by the CLI: at most MAX_BYTES, so an endless or huge producer
// (`yes | brothy`) stops early instead of filling memory before the size check.

/** Notes and piped documents above this are refused rather than rendered. */
export const MAX_BYTES = 5 * 1024 * 1024

/** The stream as UTF-8 text, or null as soon as it passes `max` bytes (the rest is not read). */
export async function readCapped(stream: ReadableStream<Uint8Array>, max = MAX_BYTES): Promise<string | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
