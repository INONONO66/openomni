/**
 * Fork ancestry projections (#1257). The `forkedFrom` pin on a forked child's
 * genesis configure is projected here for inspect surfaces only: the ancestry
 * tree and the history-only aside text. Nothing in this module feeds model
 * context — `foldSessionHistory` never reads `session.configure` intents into
 * messages, and compaction folds over that same history — so the aside is
 * invisible to the model unless the opt-in `forkAsideTransformer` is
 * registered in a composition's handler table and an explicit `prompt.pre`
 * policy row (`verdict {type: "transform", ref: "inspect/fork-aside"}`)
 * promotes it through the compiled gate.
 */
import { SessionGeneration } from "@openomni/protocol";
import type { SessionKernel } from "../core/entity";
import type { NamedTransformer } from "../core/gate/registry";

/** Reads the fork pin off a session's genesis configure; null for a root. */
export function forkAncestryOf(
  kernel: SessionKernel,
  sessionId: string,
): SessionGeneration.ForkAncestry | null {
  const genesis = kernel.historyPage(sessionId, { afterRevision: 0, limit: 1 }).actions[0];
  if (genesis === undefined || genesis.kind !== "session.configure") return null;
  const intent = genesis.intent.value;
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) return null;
  const parsed = SessionGeneration.ForkAncestry.safeParse(intent.forkedFrom);
  return parsed.success ? parsed.data : null;
}

/** The history-only aside text for one fork pin; projection, never context. */
export function forkAside(ancestry: SessionGeneration.ForkAncestry): string {
  return (
    `Forked from session ${ancestry.session} at anchor ${ancestry.anchor} ` +
    `(parent seq ${ancestry.parentSeq}, parent head ${ancestry.parentHead}, ` +
    `${ancestry.copied} rows copied).`
  );
}

export interface SessionTreeNode {
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly forkedFrom: SessionGeneration.ForkAncestry | null;
  readonly aside: string | null;
  readonly children: readonly SessionTreeNode[];
  /** Children continuation: the last child id read when the page filled. */
  readonly nextChildrenCursor: string | null;
}

export interface InspectTreeRequest {
  readonly depth?: number;
  readonly limit?: number;
}

/**
 * The ancestry tree projection: each node carries its fork pin and aside text,
 * children follow the catalog's `parent_id` edges (fork children and
 * commissioned sub-sessions alike). Bounded by `depth` (default 3) and a
 * per-node child page `limit` (default 64).
 */
export function inspectTree(
  kernel: SessionKernel,
  rootId: string,
  request: InspectTreeRequest = {},
  openKernel: (id: string) => SessionKernel = () => kernel,
): SessionTreeNode {
  const depth = request.depth ?? 3;
  const limit = request.limit ?? 64;
  const visit = (id: string, remaining: number): SessionTreeNode => {
    const reader = id === rootId ? kernel : openKernel(id);
    const row = reader.row(id);
    const forkedFrom = forkAncestryOf(reader, id);
    const childRows = remaining === 0 ? [] : reader.childSessionsPage(id, "", limit);
    return {
      sessionId: id,
      parentId: row.parentId,
      forkedFrom,
      aside: forkedFrom === null ? null : forkAside(forkedFrom),
      children: childRows.map((child) => visit(child.id, remaining - 1)),
      nextChildrenCursor:
        childRows.length === limit ? (childRows[childRows.length - 1]?.id ?? null) : null,
    };
  };
  return visit(rootId, depth);
}

/**
 * Opt-in promotion (#1257): the registration-ready `prompt.pre` transformer
 * that prepends the fork aside to a string prompt value. Registered nowhere
 * by default — only a composition that puts it in the handler table AND
 * commits a policy row `{type: "transform", ref: "inspect/fork-aside"}` on
 * `prompt.pre` moves the aside into model context; anything else (a root
 * session, a non-string value) passes through unchanged.
 */
export const FORK_ASIDE_REF = "inspect/fork-aside";

export function forkAsideTransformer(
  ancestryOf: (sessionId: string) => SessionGeneration.ForkAncestry | null,
  sessionId: string,
): NamedTransformer {
  return {
    name: FORK_ASIDE_REF,
    apply: (args) => {
      const ancestry = ancestryOf(sessionId);
      if (ancestry === null || args === null || typeof args !== "object" || Array.isArray(args))
        return args;
      // The prompt.pre point's one rewritable text field is `body`.
      const body = args.body;
      if (typeof body !== "string") return args;
      return { ...args, body: `${forkAside(ancestry)}\n\n${body}` };
    },
  };
}
