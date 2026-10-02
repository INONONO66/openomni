import { RendererInvariantError } from "./errors";

/**
 * The element the app mounts into. Its absence is a build defect in
 * `index.html`, not a runtime state, so the entry refuses to boot. Kept out of
 * `main.tsx` so the invariant is testable without evaluating the entry a
 * second time (a second module instance of one source path makes Bun's
 * coverage report only the last instance's counters).
 */
export function rendererRoot(document: Pick<Document, "getElementById">): HTMLElement {
  const root = document.getElementById("root");
  if (!root) throw new RendererInvariantError("renderer root element missing");
  return root;
}
