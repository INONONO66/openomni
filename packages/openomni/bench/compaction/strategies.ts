import { PolicyEngine } from "@openomni/agent";
import { Session, Storage } from "@openomni/ledger";
import type { Message } from "@openomni/protocol";
import { buildWorkerMiddleware } from "@openomni/openomni";
import { chat } from "./llm";

/**
 * Window builders. `anchored*` runs the SHIPPED pipeline — the real
 * `run.completion.pre` seam through `buildWorkerMiddleware`, so the L2
 * verbatim cut, the senpi-shaped anchored merge (real LLM), L6 decoration,
 * and the L7 byte guard are all live. `uniformReal` is a REAL (not
 * hardcoded) regenerate-everything baseline: the same LLM summarizes the
 * same cut span with user turns included — the industry-default shape.
 * `fullHistory` is the no-compaction upper-bound reference.
 */

export interface BuiltWindow {
  readonly texts: readonly string[];
  readonly chars: number;
}

function windowTexts(messages: readonly Message.WithParts[]): string[] {
  return messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
}
const totalChars = (texts: readonly string[]) => texts.reduce((sum, t) => sum + t.length, 0);

export function fullHistory(messages: readonly Message.WithParts[]): BuiltWindow {
  const texts = windowTexts(messages);
  return { texts, chars: totalChars(texts) };
}

export async function anchored(
  messages: Message.WithParts[],
  sessionID: string,
  summarizerModel: string,
  preserveUserMessageChars?: number,
): Promise<BuiltWindow> {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Session.create({ traceId: "bench", title: "bench", model: { providerID: "p", modelID: "m" } });
  const registration = buildWorkerMiddleware({
    compaction: {
      contextWindowTokens: 10_000,
      // Production's anchor completion sets no low output cap; 1500 starved
      // reasoning-class summarizers (completion tokens include reasoning) and
      // truncated checkpoints mid-section. Applied to BOTH strategies below.
      summarizeWith: (prompt: string) =>
        chat({ model: summarizerModel, user: prompt, maxTokens: 6000 }),
      ...(preserveUserMessageChars === undefined ? {} : { preserveUserMessageChars }),
      speculate: false,
    },
  }).find((r) => r.name === "builtin:compaction");
  if (!registration) throw new Error("no compaction registration");
  const engine = PolicyEngine.create({ audit: false });
  engine.register(registration);
  const decision = await engine.dispatchPoint("run.completion.pre", {
    sessionId: sessionID,
    runId: "bench-run",
    completionCandidate: { type: "stop" },
    traceContext: { traceId: "bench", sessionId: sessionID },
    messages,
    contextTokens: 9_999,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 1,
    isCompletion: true,
    continuationCount: 0,
    elapsedMs: 0,
  } as never);
  const d = decision as {
    effects: Array<{ type: string; messages?: unknown }>;
    reasonCodes?: string[];
  };
  const effect = d.effects.find((e) => e.type === "run.replace_messages");
  if (effect?.type !== "run.replace_messages") {
    throw new Error(`seam refused: ${JSON.stringify(d.reasonCodes)}`);
  }
  const texts = windowTexts(effect.messages as Message.WithParts[]);
  return { texts, chars: totalChars(texts) };
}

const UNIFORM_PROMPT = `The messages above are a long conversation to compress. Write ONE structured summary that a later assistant will rely on INSTEAD of the original messages. Cover both speakers' statements, commitments, dates, and facts as faithfully as you can. Output only the summary.`;

export async function uniformReal(
  messages: readonly Message.WithParts[],
  summarizerModel: string,
  protectRecent = 6,
): Promise<BuiltWindow> {
  const cut = messages.slice(0, Math.max(0, messages.length - protectRecent));
  const tail = messages.slice(-protectRecent);
  const serialized = cut.map((m) => `${m.info.role}: ${windowTexts([m]).join("\n")}`).join("\n");
  const summary = await chat({
    model: summarizerModel,
    user: `<conversation>\n${serialized}\n</conversation>\n\n${UNIFORM_PROMPT}`,
    maxTokens: 6000,
  });
  const texts = [`[Conversation Summary]\n${summary}`, ...windowTexts(tail)];
  return { texts, chars: totalChars(texts) };
}
