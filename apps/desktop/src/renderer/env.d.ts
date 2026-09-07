/**
 * The one Vite build constant the renderer reads.
 *
 * Declared by hand rather than through `vite/client`, and only for the web
 * program: `tsconfig.web.json` compiles with `types: []`, so this is the only
 * place `import.meta.env` exists there, while the test program picks up Bun's
 * own `ImportMeta` and must not be handed a second, conflicting one.
 */
interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}
