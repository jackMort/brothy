// A `with { type: "file" }` import gives the file's path (a path inside the binary once compiled).
declare module "*.wasm" {
  const path: string
  export default path
}
