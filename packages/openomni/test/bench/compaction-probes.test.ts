import { beforeAll, describe, expect, it } from "bun:test";
import { PolicyEngine } from "@openomni/agent";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/ledger";
import { buildWorkerMiddleware } from "../../src/execution-runtime/middleware";
import { findRegistration } from "../../src/execution-runtime/middleware-test-fixture";

/**
 * L7 (#717): probe-based compaction evaluation — Factory's methodology
 * (probe what the compacted window can still answer; the target metric is
 * tokens-per-task, not compression ratio) made deterministic: probes are
 * byte-presence checks against a seeded corpus, so scores are exact and
 * reproducible with no live judge. This includes the user-verbatim vs
 * uniform-summarization A/B no published benchmark has run: the uniform
 * baseline models the regenerate-everything summarizer (user text included,
 * paraphrased), which is what the industry ships by default.
 *
 * A live blind-judge pass (continuation/decision quality beyond presence)
 * remains a pluggable manual step — presence probes are the CI-safe floor.
 */

const CONSTRAINT_PROBES = [
  "재시도는 최대 3회, 각 시도는 500ms 이내여야 한다",
  "출력 파일은 반드시 UTF-8 with BOM 없이 저장할 것",
  "the deploy window is 02:00-03:00 UTC on Tuesdays only",
];
const GOAL_PROBE = "최종 목표: p95 레이턴시를 120ms 아래로";
const ARTIFACT_PROBE = "/src/hot/path.ts";

let sessionId: string;

function seedStore(): void {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  sessionId = Session.create({
    traceId: "t-probe-bench",
    title: "probe bench",
    model: { providerID: "p", modelID: "m" },
  }).id;
  // The artifact ledger row the anchored strategy's table derives from.
  const id = crypto.randomUUID();
  Session.addMessage(sessionId, {
    id,
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "m",
    providerID: "p",
    agent: "t",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  Session.addPart(id, {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: id,
    type: "tool",
    callID: "call-probe-1",
    tool: "edit",
    state: {
      status: "completed",
      input: { path: ARTIFACT_PROBE },
      output: "ok",
      title: "edit",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  });
}

function corpus(): Message.WithParts[] {
  const bulk = "filler ".repeat(80);
  const mk = (role: "user" | "assistant", text: string): Message.WithParts => {
    const id = crypto.randomUUID();
    return {
      info:
        role === "user"
          ? {
              id,
              sessionID: sessionId,
              role,
              time: { created: 1 },
              agent: "t",
              model: { providerID: "", modelID: "" },
            }
          : {
              id,
              sessionID: sessionId,
              role,
              time: { created: 1 },
              parentID: "",
              modelID: "m",
              providerID: "p",
              agent: "t",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
      parts: [{ id: crypto.randomUUID(), sessionID: sessionId, messageID: id, type: "text", text }],
    };
  };
  return [
    mk("user", CONSTRAINT_PROBES[0] ?? ""),
    mk("assistant", `decided: use a queue. ${bulk}`),
    mk("user", CONSTRAINT_PROBES[1] ?? ""),
    mk("assistant", `edited ${ARTIFACT_PROBE}. ${bulk}`),
    mk("user", CONSTRAINT_PROBES[2] ?? ""),
    mk("assistant", `benchmarks recorded. ${bulk}`),
    mk("user", GOAL_PROBE),
    mk("assistant", "on it."),
  ];
}

function windowChars(window: ReadonlyArray<{ content: string }>): number {
  return window.reduce((sum, entry) => sum + entry.content.length, 0);
}

function presenceScore(texts: readonly string[], probes: readonly string[]): number {
  const joined = texts.join("\n");
  return probes.filter((probe) => joined.includes(probe)).length / probes.length;
}

/**
 * ILLUSTRATIVE hardcoded baseline modeling the regenerate-everything shape
 * (#729 review F3): its scores are byte-absent by construction, so the
 * uniform half of the A/B is an illustration, not a measurement — the
 * meaningful half is the anchored side, which runs the REAL shipped seam
 * (guard live, decoration live) and proves the shipped path preserves.
 */
function uniformBaseline(history: Message.WithParts[]): Array<{ content: string }> {
  const tail = history.slice(-2);
  return [
    {
      content:
        "[Conversation Summary]\nThe user stated several retry, encoding, and deploy-window constraints; files were edited; the goal is lower latency.",
    },
    ...tail.map((message) => ({
      content: message.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    })),
  ];
}

describe("compaction probe bench (L7 — deterministic, seeded)", () => {
  beforeAll(seedStore);

  it("anchored user-verbatim keeps 100% of user probes; the uniform baseline does not", async () => {
    const history = corpus();
    const fullChars = history.reduce(
      (sum, m) => sum + m.parts.reduce((s, p) => s + (p.type === "text" ? p.text.length : 0), 0),
      0,
    );

    // Strategy A — the shipped anchored seam (real policy path).
    const registration = findRegistration(
      buildWorkerMiddleware({
        compaction: {
          contextWindowTokens: 100,
          protectRecentMessages: 2,
          summarizeWith: async () => "decisions: queue adopted; benchmarks recorded",
        },
      }),
      "builtin:compaction",
    );
    if (registration === undefined) throw new Error("expected compaction registration");
    const engine = PolicyEngine.create({ audit: false });
    engine.register(registration);
    const decision = await engine.dispatchPoint("run.completion.pre", {
      sessionId,
      runId: "run-probe",
      completionCandidate: { type: "stop" },
      traceContext: { traceId: "t-probe-bench", sessionId },
      messages: history,
      contextTokens: 99,
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 1,
      isCompletion: true,
      continuationCount: 0,
      elapsedMs: 0,
    });
    const effect = (
      decision as { effects: Array<{ type: string; messages?: unknown }> }
    ).effects.find((entry) => entry.type === "run.replace_messages");
    if (effect?.type !== "run.replace_messages") throw new Error("expected anchored cut");
    const anchored = (effect.messages as Message.WithParts[]).map((message) => ({
      content: message.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    }));

    // Strategy B — the uniform regenerate baseline on the same corpus.
    const uniform = uniformBaseline(history);

    const scores = {
      anchored: {
        constraints: presenceScore(
          anchored.map((entry) => entry.content),
          CONSTRAINT_PROBES,
        ),
        goal: presenceScore(
          anchored.map((entry) => entry.content),
          [GOAL_PROBE],
        ),
        artifact: presenceScore(
          anchored.map((entry) => entry.content),
          [ARTIFACT_PROBE],
        ),
        chars: windowChars(anchored),
      },
      uniform: {
        constraints: presenceScore(
          uniform.map((entry) => entry.content),
          CONSTRAINT_PROBES,
        ),
        goal: presenceScore(
          uniform.map((entry) => entry.content),
          [GOAL_PROBE],
        ),
        artifact: presenceScore(
          uniform.map((entry) => entry.content),
          [ARTIFACT_PROBE],
        ),
        chars: windowChars(uniform),
      },
    };

    // The A/B: user tokens are the irreplaceable part. Anchored-verbatim
    // answers every user probe byte-exact; the uniform baseline paraphrased
    // them away. Deterministic corpus → exact, reproducible scores.
    expect(scores.anchored.constraints).toBe(1);
    expect(scores.anchored.goal).toBe(1);
    expect(scores.anchored.artifact).toBe(1); // ledger-derived table (L6)
    // By construction (illustrative baseline): see uniformBaseline's doc.
    expect(scores.uniform.constraints).toBe(0);
    // The goal sits in the protected tail, which BOTH strategies keep — the
    // A/B differentiator is user text outside the tail (constraints) and the
    // ledger-derived artifact, which uniform paraphrased away.
    expect(scores.uniform.goal).toBe(1);
    expect(scores.uniform.artifact).toBe(0);

    // Tokens-per-task floor: both strategies must actually compact.
    expect(scores.anchored.chars).toBeLessThan(fullChars);
    expect(scores.uniform.chars).toBeLessThan(fullChars);
  });
});
