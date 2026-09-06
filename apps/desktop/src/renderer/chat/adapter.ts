import type { PendingApproval, TranscriptNode, TurnCost } from "@openomni/ui";
import { segmentTurns } from "@openomni/ui";
import { getToolName, isToolUIPart } from "ai";
import type { OpenOmniUIMessage, TurnMetadata } from "./message";

/**
 * The one crossing between the AI SDK's message model and the design system's
 * transcript model.
 *
 * It is a pure function on purpose. Everything the surface draws is derivable
 * from the message list `useChat` already owns, so there is no second store to
 * keep in sync, nothing to invalidate, and no state that can disagree with the
 * stream. Re-running this on every render is cheaper than being wrong once.
 *
 * ## What the boundary buys
 *
 * `@openomni/ui` stays data-blind: it never learns the word `tool-call`, never
 * imports `ai`, and could render a transcript produced by a different engine
 * tomorrow. And the SDK stays unaware that a `TranscriptTool` exists. The two
 * vocabularies meet in this file and nowhere else, which is the only reason the
 * design system can claim to be a design system rather than this SDK's view
 * layer.
 *
 * ## What it deliberately does NOT do
 *
 * It composes no sentences about tools beyond the approval summary the tray
 * needs, invents no rows for parts the transcript has no shape for, and throws
 * on nothing. A stream that grows a part kind this build has never seen must
 * degrade to a missing row, not to a blank screen — a transcript that refuses
 * to render is worse than one that is one row short.
 */

/**
 * The two node shapes this file builds by hand, narrowed out of the union the
 * design system exports.
 *
 * `@openomni/ui` exports `TranscriptNode` and not its members, which is the
 * right boundary: the transcript takes a ledger, not a kit of row types. The
 * narrowing happens here so the consumer that DOES assemble rows still gets a
 * compiler error when a member changes.
 */
type TranscriptTool = Extract<TranscriptNode, { kind: "tool" }>;
type TranscriptMarkdown = Extract<TranscriptNode, { kind: "assistant" }>["blocks"][number];

/** `done` is the transcript's implicit default; only the loud states print. */
type LoudStatus = Exclude<TranscriptTool["status"], undefined>;

interface Transcript {
  readonly nodes: readonly TranscriptNode[];
  /** Per-turn cost, keyed the way `Timeline` reads it: 1-based turn index. */
  readonly costs: Readonly<Record<number, TurnCost>>;
  readonly pending: readonly PendingApproval[];
}

export function uiMessagesToTranscript(messages: readonly OpenOmniUIMessage[]): Transcript {
  const nodes: TranscriptNode[] = [];
  const pending: PendingApproval[] = [];
  /** Which node ids each turn's cost should attach to, once turns are known. */
  const costAnchors: { readonly nodeId: string; readonly cost: TurnCost }[] = [];

  for (const message of messages) {
    const before = nodes.length;

    if (message.role === "user") {
      const text = textOf(message);
      if (text !== "") nodes.push({ kind: "prompt", id: message.id, text });
      continue;
    }
    // A system message is an instruction to the model, not a thing that
    // happened in the conversation. The transcript has no row for it and must
    // not invent one.
    if (message.role !== "assistant") continue;

    appendAssistant(message, nodes, pending);

    const cost = costOf(message.metadata);
    const anchor = nodes[before];
    if (cost !== undefined && anchor !== undefined) {
      costAnchors.push({ nodeId: anchor.id, cost });
    }
  }

  return { nodes, costs: costsByTurn(nodes, costAnchors), pending };
}

/**
 * One assistant message, part by part, in ARRIVAL ORDER.
 *
 * Order is the whole contract. The agent read a file, said something, then ran
 * a test, and the column has to show read → text → test; gathering the calls
 * into a per-turn appendix would be tidier and would misreport the order the
 * agent thought in. So a tool part CLOSES the open prose node, and the next
 * text part opens a new one.
 */
function appendAssistant(
  message: OpenOmniUIMessage,
  nodes: TranscriptNode[],
  pending: PendingApproval[],
): void {
  let blocks: TranscriptMarkdown[] = [];
  let blocksAt = 0;
  let streaming = false;

  const flush = () => {
    if (blocks.length === 0) return;
    nodes.push({ kind: "assistant", id: `${message.id}.${blocksAt}`, blocks, streaming });
    blocks = [];
    streaming = false;
  };

  for (const [at, part] of message.parts.entries()) {
    if (part.type === "text") {
      // Adjacent text parts are one answer with several paragraphs, not several
      // answers: the SDK splits on stream boundaries, which are not sentences.
      if (blocks.length === 0) blocksAt = at;
      blocks.push({ kind: "p", text: part.text });
      // The tail of a streaming answer is the one place a caret may blink.
      streaming = part.state === "streaming";
      continue;
    }

    if (isToolUIPart(part)) {
      flush();
      const { node, approval } = toolNode(part);
      nodes.push(node);
      if (approval !== undefined) pending.push(approval);
      continue;
    }

    if (part.type === "data-epoch") {
      flush();
      nodes.push({
        kind: "epoch",
        id: part.id ?? `${message.id}.${at}`,
        label: part.data.label,
        // The ledger event carries no clock of its own. An empty string prints
        // nothing rather than inventing a time the boundary did not have.
        at: "",
      });
    }

    // step-start, reasoning, sources, files: real parts of the message with no
    // row in this transcript. Dropped silently, on purpose.
  }

  flush();
}

/** A tool part, as one ledger row plus — if it is blocked — one decision. */
function toolNode(part: ToolPart): {
  readonly node: TranscriptTool;
  readonly approval?: PendingApproval;
} {
  const tool = getToolName(part);
  const target = targetOf(part.input);
  const status =
    part.state === "approval-responded" && !part.approval.approved
      ? "denied"
      : STATUS[part.state];

  // The row's id is the APPROVAL's id while a decision is outstanding.
  //
  // `PendingApproval.toolId` joins the tray's buttons to the row they belong
  // to, and that same string is what comes back through `onApprove`. The SDK's
  // response is keyed by approval, not by call — one call can be asked about
  // twice — so keying the row by `toolCallId` would hand the app an identifier
  // it cannot answer with.
  const id = part.state === "approval-requested" ? part.approval.id : part.toolCallId;

  const node: TranscriptTool = {
    kind: "tool",
    id,
    tool,
    target,
    ...(status === undefined ? {} : { status }),
    ...(part.state === "output-error" ? { payload: [part.errorText] } : {}),
  };

  if (part.state !== "approval-requested") return { node };

  return {
    node,
    approval: {
      toolId: part.approval.id,
      // The product's sentence, composed here because `@openomni/ui` prints
      // what it is handed and never writes a sentence about a tool.
      summary: target === "" ? `${tool} wants to run` : `${tool} wants to run ${target}`,
      reason: part.approval.requestReason ?? "requires approval",
    },
  };
}

type ToolPart = Extract<OpenOmniUIMessage["parts"][number], { toolCallId: string }>;

/**
 * The call outcome each SDK state reports.
 *
 * `input-streaming` and `input-available` are both `running`: the difference
 * between them is whether the ARGUMENTS have finished arriving, which is the
 * SDK's concern and never the reader's — both mean the call has not returned.
 * An approved `approval-responded` call is running again. A rejected response
 * is already denied, even before the SDK replaces it with `output-denied`.
 */
const STATUS: Readonly<Record<ToolPart["state"], LoudStatus | undefined>> = {
  "input-streaming": "running",
  "input-available": "running",
  "approval-requested": "waiting",
  "approval-responded": "running",
  "output-error": "failed",
  "output-denied": "denied",
  "output-available": undefined,
};

/**
 * What the call acted on, as one line: a command, a path, a pattern.
 *
 * A static tool's input is typed, but a `dynamic-tool` part's is `unknown` by
 * construction — the gateway may offer tools this build has never heard of.
 * That is a system boundary, so the value is PARSED into the one string the row
 * has space for rather than trusted, and an input with none of these keys
 * yields an empty target instead of a stringified object dumped into the row.
 */
function targetOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (!isRecord(input)) return "";

  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** In the order a row would want them: what ran, then what it ran against. */
const TARGET_KEYS = ["command", "path", "pattern", "query", "target"] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/** A user message's text: its text parts, joined. Files and the rest are not prose. */
function textOf(message: OpenOmniUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Raw instants become the two already-formatted strings the transcript prints.
 *
 * The formatting happens HERE because `TurnCost` is documented as read-ready
 * text: the moment the design system parses a timestamp it owns a locale, and
 * the reader's clock is the app's fact, not the layout's.
 */
function costOf(metadata: TurnMetadata | undefined): TurnCost | undefined {
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
function costsByTurn(
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
