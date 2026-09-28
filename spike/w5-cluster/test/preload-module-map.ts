// SPIKE-ONLY resolution shim. Bun resolves "@openomni/*" through the importing
// file's nearest tsconfig `paths`; packages/agent has no paths entry and the
// workspace packages' `dist/` is not built in this worktree, so deep imports of
// agent sources (check 4 imports decideSessionAdmission/decideRequestTransition
// from packages/agent/src) cannot resolve their own "@openomni/protocol" etc.
// Register each @openomni package as a virtual module backed by the SAME src
// entry file the ledger tsconfig paths already resolve to, so every importer
// (spike, ledger, agent internals) shares one module instance per package.
import { plugin } from "bun";
import { join } from "node:path";

const packagesRoot = join(import.meta.dir, "..", "..", "..", "packages");

plugin({
  name: "openomni-src-map",
  setup(build) {
    for (const name of ["protocol", "ledger", "llm", "policy", "agent"]) {
      build.module(`@openomni/${name}`, async () => ({
        loader: "object",
        exports: { ...(await import(join(packagesRoot, name, "src", "index.ts"))) },
      }));
    }
  },
});
