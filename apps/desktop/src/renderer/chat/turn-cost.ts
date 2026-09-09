import { segmentTurns, type TranscriptNode, type TurnCost } from "@openomni/ui";
import type { TurnMetadata } from "./message";

/**
 * Raw instants become the two already-formatted strings the transcript prints.
 *
 * The formatting happens HERE because `TurnCost` is documented as read-ready
 * text: the moment the design system parses a timestamp it owns a locale, and
 * the reader's clock is the app's fact, not the layout's.
 */
export function costOf(metadata: TurnMetadata | undefined): TurnCost | undefined {
  if (metadata?.startedAt === undefined || metadata.elapsedMs === undefined) return;
  return { at: clock(metadata.startedAt), elapsed: elapsed(metadata.elapsedMs) };
}

function clock(at: number): string {
  const local = new Date(at);
  return `${pad(local.getHours())}:${pad(local.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function elapsed(ms: number): string {
  if (ms < SECOND) return `${Math.round(ms)}ms`;
  if (ms < MINUTE) return `${(ms / SECOND).toFixed(1)}s`;
  return `${Math.floor(ms / MINUTE)}m ${Math.round((ms % MINUTE) / SECOND)}s`;
}

/**
 * Costs, re-keyed onto the turn numbers `Timeline` will look them up by.
 *
 * `segmentTurns` is the design system's own segmentation, so calling it here
 * rather than counting prompts is what guarantees the two agree. Counting user
 * messages would drift the moment an epoch opens a turn of its own — which it
 * does — and the cost would then be attached to the turn below the one that
 * paid it.
 */
export function costsByTurn(
  nodes: readonly TranscriptNode[],
  anchors: readonly { readonly nodeId: string; readonly cost: TurnCost }[],
): Readonly<Record<number, TurnCost>> {
  if (anchors.length === 0) return {};

  const turnOf = new Map<string, number>();
  for (const turn of segmentTurns(nodes)) {
    for (const part of turn.parts) {
      if (part.kind === "tools") {
        for (const call of part.calls) turnOf.set(call.id, turn.index);
        continue;
      }
      // A prose part is addressed `${nodeId}.${blockIndex}`; the anchor is the
      // node, so the prefix is what identifies it.
      turnOf.set(
        part.kind === "prose" ? part.id.slice(0, part.id.lastIndexOf(".")) : part.id,
        turn.index,
      );
    }
  }

  const costs: Record<number, TurnCost> = {};
  for (const { nodeId, cost } of anchors) {
    const index = turnOf.get(nodeId);
    if (index !== undefined) costs[index] = cost;
  }
  return costs;
}
