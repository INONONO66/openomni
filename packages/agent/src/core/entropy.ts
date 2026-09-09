/** Resolves a runtime's id source, defaulting to random UUIDs when none was injected. */
export function entropyOf(runtime: { readonly entropy?: () => string }): () => string {
  return runtime.entropy ?? (() => crypto.randomUUID());
}
