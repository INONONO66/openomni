import { describe, expect, it, spyOn } from "bun:test";
import { PolicyEngine } from "@openomni/agent";
import { Operational } from "@openomni/protocol";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { SessionBridge } from "../ingress/session-bridge";
import { InjectionQueue } from "./injection-queue";
import { buildWorkerMiddleware } from "./middleware";
import { findRegistration, invokeTool } from "./middleware-test-fixture";

describe("buildWorkerMiddleware backward compatibility", () => {
  it("returns worker-owned registrations", () => {
    const registrations = buildWorkerMiddleware({});
    expect(registrations.map((r) => r.name)).toEqual([
      "builtin:budget-reassurance",
      "builtin:budget-warning",
      "builtin:compaction",
      "builtin:tool-permission",
      "builtin:idle-nudge",
    ]);
  });

  it("tool permission registration is fail-closed", () => {
    const registrations = buildWorkerMiddleware({});
    const toolPermission = findRegistration(registrations, "builtin:tool-permission");
    if (toolPermission == null || toolPermission.kind !== "point")
      throw new Error("expected tool permission registration");
    expect(toolPermission.name).toBe("builtin:tool-permission");
    expect(toolPermission.failPolicy).toBe("fail-closed");
  });

  it("can omit idle-nudge middleware", () => {
    const registrations = buildWorkerMiddleware({ includeIdle: false });
    const idleNudge = registrations.find((r) => r.name === "builtin:idle-nudge");
    expect(idleNudge).toBeUndefined();
  });

  it("passes permissions to tool permission middleware", async () => {
    const permissions = { action: "tool.call", allowlist: ["tool:read"] };
    const registrations = buildWorkerMiddleware({ permissions });
    const toolPermission = findRegistration(registrations, "builtin:tool-permission");
    await expect(invokeTool(toolPermission, "tool:read")).resolves.toMatchObject({
      verdict: "allow",
    });
    await expect(invokeTool(toolPermission, "tool:write")).resolves.toMatchObject({
      verdict: "deny",
    });
  });

  // Audit batch A: an ABSENT permission is a composition bug, never an
  // implicit allow-all — nothing declared a ruleset, so every tool denies.
  it("fails closed when no permissions and no policy plan are composed", async () => {
    const registrations = buildWorkerMiddleware({});
    const toolPermission = findRegistration(registrations, "builtin:tool-permission");
    await expect(invokeTool(toolPermission, "any_tool")).resolves.toMatchObject({
      verdict: "deny",
    });
  });
});

describe("buildWorkerMiddleware injection queue persistence", () => {
  it("emits a queued response when history persistence throws a non-Error value", async () => {
    const queue = InjectionQueue.create();
    queue.enqueue(
      "run-storage-failure",
      {
        messageId: "message-storage-failure",
        output: "deliver despite non-Error storage failure",
        injectToHistory: true,
        timestamp: 1,
      },
      "trace-middleware-test",
    );
    const registration = findRegistration(
      buildWorkerMiddleware({ injectionQueue: queue }),
      "builtin:injection-queue-drain",
    );
    if (registration === undefined) throw new Error("expected injection queue registration");
    const addMessageSpy = spyOn(Session, "addMessage").mockImplementation(() => {
      // biome-ignore lint/style/useThrowOnlyError: exercises the defensive catch for hostile non-Error throws.
      throw "storage unavailable";
    });
    const engine = PolicyEngine.create({ audit: false });
    engine.register(registration);

    try {
      const decision = await engine.dispatchPoint("run.turn.post", {
        sessionId: "session-storage-failure",
        runId: "run-storage-failure",
        traceContext: { traceId: "trace-middleware-test" },
        turnIndex: 0,
        turnResult: { type: "stop" },
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnCount: 0,
        isCompletion: true,
        continuationCount: 0,
        elapsedMs: 0,
      });

      expect(decision.effects).toEqual([
        {
          type: "prompt.inject_message",
          message: "deliver despite non-Error storage failure",
          role: "assistant",
        },
      ]);
      expect(queue.hasPending("run-storage-failure")).toBe(false);
    } finally {
      addMessageSpy.mockRestore();
    }
  });

  it("summarizeWith wires the anchored summarizer into the compaction seam (L2)", async () => {
    const prompts: string[] = [];
    const registration = findRegistration(
      buildWorkerMiddleware({
        compaction: {
          contextWindowTokens: 100,
          protectRecentMessages: 2,
          summarizeWith: async (prompt: string) => {
            prompts.push(prompt);
            return "merged checkpoint";
          },
        },
      }),
      "builtin:compaction",
    );
    if (registration === undefined) throw new Error("expected compaction registration");
    const engine = PolicyEngine.create({ audit: false });
    engine.register(registration);

    const sessionID = "session-anchor-wire";
    const user = (id: string, text: string) => ({
      info: {
        id,
        sessionID,
        role: "user" as const,
        time: { created: 1 },
        agent: "test",
        model: { providerID: "", modelID: "" },
      },
      parts: [{ id: `${id}-t`, sessionID, messageID: id, type: "text" as const, text }],
    });
    const assistant = (id: string, text: string) => ({
      info: {
        id,
        sessionID,
        role: "assistant" as const,
        time: { created: 1 },
        parentID: "",
        modelID: "m",
        providerID: "p",
        agent: "test",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: `${id}-t`,
          sessionID,
          messageID: id,
          type: "text" as const,
          text: `${text}\n${"filler ".repeat(60)}`,
        },
      ],
    });

    const decision = await engine.dispatchPoint("run.completion.pre", {
      sessionId: sessionID,
      runId: "run-anchor-wire",
      completionCandidate: { type: "stop" },
      traceContext: { traceId: "trace-anchor-wire", sessionId: sessionID },
      messages: [
        user("u0", "the goal"),
        assistant("a1", "work one"),
        assistant("a2", "work two"),
        user("u3", "tail question"),
        assistant("a4", "tail answer"),
      ],
      contextTokens: 99,
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 1,
      isCompletion: true,
      continuationCount: 0,
      elapsedMs: 0,
    });

    // The senpi-shaped template reached the completion function…
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("## Goal");
    expect(prompts[0]).toContain("work one");
    expect(prompts[0]).not.toContain("the goal");
    // …and the seam rewrote history with the anchor render heading it.
    const effect = decision.effects.find((entry) => entry.type === "run.replace_messages");
    if (effect?.type !== "run.replace_messages") throw new Error("expected replace effect");
    const first = (effect.messages as Array<{ parts: Array<{ text?: string }> }>)[0];
    expect(first?.parts[0]?.text).toContain("merged checkpoint");
  });

  it("compaction survives a production-shaped resume: ids are re-minted, content survives (#702)", async () => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    const session = Session.create({
      traceId: "trace-702",
      title: "702 repro",
      model: { providerID: "p", modelID: "m" },
    });
    const sessionID = session.id;

    // A fixed PAST date (#737): the assertions below can then tell a marker
    // derived from the recorded time apart from one stamped with "now".
    const storedDay = Date.UTC(2023, 4, 8, 13, 56);
    const store = (role: "user" | "assistant", text: string, createdMs = storedDay) => {
      const id = crypto.randomUUID();
      const info =
        role === "user"
          ? ({
              id,
              sessionID,
              role,
              time: { created: createdMs },
              agent: "t",
              model: { providerID: "", modelID: "" },
            } as const)
          : ({
              id,
              sessionID,
              role,
              time: { created: createdMs },
              parentID: "",
              modelID: "m",
              providerID: "p",
              agent: "t",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            } as const);
      Session.addMessage(sessionID, info);
      Session.addPart(id, {
        id: crypto.randomUUID(),
        sessionID,
        messageID: id,
        type: "text" as const,
        text,
      });
    };

    // The full pre-compaction history, persisted the way production writes it.
    store("user", "the original goal");
    store("assistant", `old work\n${"filler ".repeat(60)}`);
    store("assistant", `more old work\n${"filler ".repeat(60)}`);
    store("user", "recent question");
    store("assistant", "recent answer");

    // Production-shaped hydration (#722 review finding 1): the run receives
    // role/content strings and re-mints message ids — store ids are erased
    // at this seam. Any record keyed on ids would resolve to nothing.
    const rehydrate = () =>
      SessionBridge.buildDirectMessages(sessionID).map(({ role, content, partMetadata, time }) => {
        const id = crypto.randomUUID();
        // Mirrors toMessagesWithParts → createUserMessage (#737): the
        // recorded creation time rides through hydration; only a record
        // without one falls back to "now".
        const created = time ?? Date.now();
        const info =
          role === "user"
            ? ({
                id,
                sessionID,
                role,
                time: { created },
                agent: "t",
                model: { providerID: "", modelID: "" },
              } as const)
            : ({
                id,
                sessionID,
                role,
                time: { created },
                parentID: "",
                modelID: "m",
                providerID: "p",
                agent: "t",
                path: { cwd: "/", root: "/" },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              } as const);
        return {
          info,
          parts: [
            {
              id: crypto.randomUUID(),
              sessionID,
              messageID: id,
              type: "text" as const,
              text: content,
              // Mirrors toMessagesWithParts → createUserMessage: structural
              // identity rides through hydration (#722 re-review finding 1).
              ...(partMetadata === undefined ? {} : { metadata: partMetadata }),
            },
          ],
        };
      });

    const registration = findRegistration(
      buildWorkerMiddleware({
        compaction: {
          contextWindowTokens: 100,
          protectRecentMessages: 2,
          summarizeWith: async () => "checkpoint after cut",
        },
      }),
      "builtin:compaction",
    );
    if (registration === undefined) throw new Error("expected compaction registration");
    const engine = PolicyEngine.create({ audit: false });
    engine.register(registration);

    const decision = await engine.dispatchPoint("run.completion.pre", {
      sessionId: sessionID,
      runId: "run-702",
      completionCandidate: { type: "stop" },
      traceContext: { traceId: "trace-702", sessionId: sessionID },
      messages: rehydrate(),
      contextTokens: 99,
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 1,
      isCompletion: true,
      continuationCount: 0,
      elapsedMs: 0,
    });
    const applied = decision.effects.find((entry) => entry.type === "run.replace_messages");
    if (applied?.type !== "run.replace_messages") throw new Error("expected replacement");
    // #737: in the applied window every preserved user message wears its
    // recorded date beside it — derived from the STORED time, not today.
    const appliedTexts = (applied.messages as Message.WithParts[]).flatMap((m) =>
      m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])),
    );
    const goalAt = appliedTexts.indexOf("the original goal");
    expect(goalAt).toBeGreaterThan(0);
    expect(appliedTexts[goalAt - 1]).toBe("[recorded 2023-05-08]");

    // Resume AGAIN through the same production-shaped seam: the compacted
    // window must carry the preserved user content byte-exact — not collapse
    // to the summary line.
    const window = SessionBridge.buildDirectMessages(sessionID);
    expect(window[0]?.content).toContain("checkpoint after cut");
    expect(window.some((m) => m.content === "the original goal")).toBe(true);
    expect(window.some((m) => m.content === "recent question")).toBe(true);
    expect(window.some((m) => m.content === "recent answer")).toBe(true);
    expect(window.some((m) => m.content.includes("old work"))).toBe(false);
    expect(window.length).toBeLessThan(6);
    // L6: the render carries the deterministic goal recitation — produced by
    // the wrapper from verbatim window text, NOT by the summarizer (whose
    // constant output is "checkpoint after cut" and nothing else).
    expect(window[0]?.content).toContain(
      "## Current goal (latest user message; full text is in the window)",
    );
    // Anchor identity survived decoration: the record still carries the raw body.
    expect(window[0]?.partMetadata?.anchorBody).toBe("checkpoint after cut");
    // Record purity (#737): markers are derived render and never enter the
    // record — the hydrated window carries the structured time instead, so
    // resume re-derives markers rather than replaying them as pseudo-speech.
    expect(window.some((m) => m.content.startsWith("[recorded "))).toBe(false);
    const hydratedGoal = window.find((m) => m.content === "the original goal");
    expect(hydratedGoal?.time).toBe(storedDay);

    // And the re-hydrated run is itself compact and coherent.
    const secondRun = rehydrate();
    expect(secondRun.length).toBe(window.length);

    // Second cycle (#722 re-review finding 1): anchor identity must survive
    // the resume seam — the next compaction merges into the SAME chain
    // (previousAnchor threads through) and the window never stacks stale
    // summary renders as pseudo-user messages.
    // The store lists messages by time_created: production times are
    // monotonic (ingress stamps "now"), so epoch-2 must sort after the
    // anchor's persist time. A future offset keeps that shape while staying
    // a KNOWN epoch the marker assertion can derive its expected date from.
    const secondDay = Date.now() + 60_000;
    store("user", "second epoch question", secondDay);
    store("assistant", `second epoch work\n${"filler ".repeat(60)}`, secondDay);
    store("assistant", `second epoch more\n${"filler ".repeat(60)}`, secondDay);
    store("assistant", "second epoch answer", secondDay);

    const previousAnchors: Array<string | undefined> = [];
    const registration2 = findRegistration(
      buildWorkerMiddleware({
        compaction: {
          contextWindowTokens: 100,
          protectRecentMessages: 2,
          onSummarize: async (_input, previousAnchor) => {
            previousAnchors.push(previousAnchor);
            return previousAnchor === undefined ? "epoch-1" : `${previousAnchor}+epoch-2`;
          },
        },
      }),
      "builtin:compaction",
    );
    if (registration2 === undefined) throw new Error("expected compaction registration");
    const engine2 = PolicyEngine.create({ audit: false });
    engine2.register(registration2);
    const decision2 = await engine2.dispatchPoint("run.completion.pre", {
      sessionId: sessionID,
      runId: "run-702-cycle2",
      completionCandidate: { type: "stop" },
      traceContext: { traceId: "trace-702-2", sessionId: sessionID },
      messages: rehydrate(),
      contextTokens: 99,
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 1,
      isCompletion: true,
      continuationCount: 0,
      elapsedMs: 0,
    });

    // The merge chain threaded across resume: the second cut saw the first
    // epoch's anchor body as state, not as content.
    expect(previousAnchors).toEqual(["checkpoint after cut"]);
    // #737 across resume: the second cut stamps the RECORDED dates — a
    // window that says today's date onto last year's words would be the
    // exact dishonesty time carriage exists to prevent. And markers never
    // stack: exactly one per preserved user message, none consecutive.
    const applied2 = decision2.effects.find((entry) => entry.type === "run.replace_messages");
    if (applied2?.type !== "run.replace_messages") throw new Error("expected replacement");
    const texts2 = (applied2.messages as Message.WithParts[]).flatMap((m) =>
      m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])),
    );
    const goal2At = texts2.indexOf("the original goal");
    expect(goal2At).toBeGreaterThan(0);
    expect(texts2[goal2At - 1]).toBe("[recorded 2023-05-08]");
    const q2At = texts2.indexOf("second epoch question");
    expect(q2At).toBeGreaterThan(0);
    expect(texts2[q2At - 1]).toBe(`[recorded ${new Date(secondDay).toISOString().slice(0, 10)}]`);
    for (let i = 1; i < texts2.length; i += 1) {
      const both =
        texts2[i]?.startsWith("[recorded ") === true &&
        texts2[i - 1]?.startsWith("[recorded ") === true;
      expect(both).toBe(false);
    }
    const finalWindow = SessionBridge.buildDirectMessages(sessionID);
    const renders = finalWindow.filter((m) => m.content.startsWith("[Conversation Summary]"));
    expect(renders).toHaveLength(1);
    expect(renders[0]?.content).toContain("checkpoint after cut+epoch-2");
    expect(finalWindow.some((m) => m.content === "the original goal")).toBe(true);
  });

  it("replacement persistence is fail-open when the store is unavailable (#702)", async () => {
    const warns: Array<{ component: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, (event) => {
      warns.push(event as unknown as { component: string });
    });
    const addMessageSpy = spyOn(Session, "addMessage").mockImplementation(() => {
      throw new Error("store down");
    });
    try {
      const registration = findRegistration(
        buildWorkerMiddleware({
          compaction: {
            contextWindowTokens: 100,
            protectRecentMessages: 2,
            summarizeWith: async () => "checkpoint",
          },
        }),
        "builtin:compaction",
      );
      if (registration === undefined) throw new Error("expected compaction registration");
      const engine = PolicyEngine.create({ audit: false });
      engine.register(registration);
      const sessionID = "session-702-failopen";
      const mk = (role: "user" | "assistant", id: string, text: string) => ({
        info:
          role === "user"
            ? {
                id,
                sessionID,
                role: "user" as const,
                time: { created: 1 },
                agent: "t",
                model: { providerID: "", modelID: "" },
              }
            : {
                id,
                sessionID,
                role: "assistant" as const,
                time: { created: 1 },
                parentID: "",
                modelID: "m",
                providerID: "p",
                agent: "t",
                path: { cwd: "/", root: "/" },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              },
        parts: [
          {
            id: `${id}-t`,
            sessionID,
            messageID: id,
            type: "text" as const,
            text,
          },
        ],
      });

      const decision = await engine.dispatchPoint("run.completion.pre", {
        sessionId: sessionID,
        runId: "run-702-failopen",
        completionCandidate: { type: "stop" },
        traceContext: { traceId: "trace-702-fo", sessionId: sessionID },
        messages: [
          mk("user", "u0", "goal"),
          mk("assistant", "a1", `w1\n${"filler ".repeat(60)}`),
          mk("assistant", "a2", `w2\n${"filler ".repeat(60)}`),
          mk("user", "u3", "tail"),
          mk("assistant", "a4", "ta"),
        ],
        contextTokens: 99,
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnCount: 1,
        isCompletion: true,
        continuationCount: 0,
        elapsedMs: 0,
      });

      // The run keeps its compacted window; only resumability degrades —
      // VISIBLY (#722 review M3): the skip publishes an operational warn.
      expect(decision.effects.some((entry) => entry.type === "run.replace_messages")).toBe(true);
      await Bun.sleep(0);
      expect(warns.some((w) => w.component === "compaction-replacement-persistence")).toBe(true);
    } finally {
      unsubscribe();
      addMessageSpy.mockRestore();
    }
  });

  it("replacement persistence refuses a cross-session anchor, visibly (#722 M4)", async () => {
    const warns: Array<{ component: string; msg: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, (event) => {
      warns.push(event as unknown as { component: string; msg: string });
    });
    const addMessageSpy = spyOn(Session, "addMessage").mockImplementation(() => {
      throw new Error("must never be reached on mismatch");
    });
    try {
      const registration = findRegistration(
        buildWorkerMiddleware({
          compaction: {
            contextWindowTokens: 100,
            protectRecentMessages: 2,
            summarizeWith: async () => "checkpoint",
          },
        }),
        "builtin:compaction",
      );
      if (registration === undefined) throw new Error("expected compaction registration");
      const engine = PolicyEngine.create({ audit: false });
      engine.register(registration);
      // History stamped with a FOREIGN session id: the anchor copies it, and
      // the wrapper must refuse the cross-session write.
      const foreign = "someone-elses-session";
      const mk = (role: "user" | "assistant", id: string, text: string) => ({
        info:
          role === "user"
            ? {
                id,
                sessionID: foreign,
                role: "user" as const,
                time: { created: 1 },
                agent: "t",
                model: { providerID: "", modelID: "" },
              }
            : {
                id,
                sessionID: foreign,
                role: "assistant" as const,
                time: { created: 1 },
                parentID: "",
                modelID: "m",
                providerID: "p",
                agent: "t",
                path: { cwd: "/", root: "/" },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              },
        parts: [{ id: `${id}-t`, sessionID: foreign, messageID: id, type: "text" as const, text }],
      });
      const decision = await engine.dispatchPoint("run.completion.pre", {
        sessionId: "the-real-session",
        runId: "run-mismatch",
        completionCandidate: { type: "stop" },
        traceContext: { traceId: "trace-mismatch", sessionId: "the-real-session" },
        messages: [
          mk("user", "u0", "goal"),
          mk("assistant", "a1", `w1\n${"filler ".repeat(60)}`),
          mk("assistant", "a2", `w2\n${"filler ".repeat(60)}`),
          mk("user", "u3", "tail"),
          mk("assistant", "a4", "ta"),
        ],
        contextTokens: 99,
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnCount: 1,
        isCompletion: true,
        continuationCount: 0,
        elapsedMs: 0,
      });
      await Bun.sleep(0);
      expect(decision.effects.some((entry) => entry.type === "run.replace_messages")).toBe(true);
      expect(addMessageSpy).not.toHaveBeenCalled();
      expect(warns.some((w) => w.msg.includes("session mismatch"))).toBe(true);
    } finally {
      unsubscribe();
      addMessageSpy.mockRestore();
    }
  });
});

describe("compaction config merge semantics (#734 F7)", () => {
  it("a summarizer-only config keeps the elision defaults", async () => {
    const registration = findRegistration(
      buildWorkerMiddleware({
        compaction: { summarizeWith: async () => "x" },
      }),
      "builtin:compaction",
    );
    expect(registration).toBeDefined();
    // The default elision knobs survive the partial: dispatch a seam over a
    // bulky-tool history with NO explicit elision config and observe the
    // elision-only reduction (a replace effect with the same message count).
    if (registration === undefined) throw new Error("expected registration");
    const engine = PolicyEngine.create({ audit: false });
    engine.register(registration);
    const sessionID = "s-merge";
    const id = "m-tool";
    const decision = await engine.dispatchPoint("run.completion.pre", {
      sessionId: sessionID,
      runId: "r-merge",
      completionCandidate: { type: "stop" },
      traceContext: { traceId: "t-merge", sessionId: sessionID },
      messages: [
        {
          info: {
            id: "u0",
            sessionID,
            role: "user",
            time: { created: 1 },
            agent: "t",
            model: { providerID: "", modelID: "" },
          },
          parts: [{ id: "u0-t", sessionID, messageID: "u0", type: "text", text: "q" }],
        },
        {
          info: {
            id,
            sessionID,
            role: "assistant",
            time: { created: 1 },
            parentID: "",
            modelID: "m",
            providerID: "p",
            agent: "t",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            {
              id: `${id}-tool`,
              sessionID,
              messageID: id,
              type: "tool",
              callID: "c-merge",
              tool: "read",
              state: {
                status: "completed",
                input: {},
                output: "x".repeat(9000),
                title: "read",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            },
          ],
        },
        ...Array.from({ length: 6 }, (_u, i) => ({
          info: {
            id: `tail-${i}`,
            sessionID,
            role: "user" as const,
            time: { created: 1 },
            agent: "t",
            model: { providerID: "", modelID: "" },
          },
          parts: [
            {
              id: `tail-${i}-t`,
              sessionID,
              messageID: `tail-${i}`,
              type: "text" as const,
              text: `tail ${i}`,
            },
          ],
        })),
      ],
      contextTokens: 99,
      contextWindowTokens: 100,
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
    if (effect?.type !== "run.replace_messages") throw new Error("expected elision effect");
    const texts = JSON.stringify(effect.messages);
    // Default elideToolOutputs (minOutputChars 4000) fired: the 9k output
    // became a recall marker — the partial config did not clobber it.
    expect(texts).toContain("output elided by compaction");
  });

  it("speculate: false still disables the turn.post registration", () => {
    const registration = findRegistration(
      buildWorkerMiddleware({
        compaction: { summarizeWith: async () => "x", speculate: false },
      }),
      "builtin:compaction",
    );
    if (registration === undefined || registration.kind !== "factory") {
      throw new Error("expected factory");
    }
    expect(registration.create().pointIds).toEqual(["run.completion.pre"]);
  });

  it("an explicitly-undefined key does not clobber the default", () => {
    const registration = findRegistration(
      buildWorkerMiddleware({
        compaction: { summarizeWith: async () => "x", elideToolOutputs: undefined },
      }),
      "builtin:compaction",
    );
    expect(registration).toBeDefined();
    // No throw + factory shape suffices here; the elision behavior itself is
    // pinned by the first case (same merge path).
    if (registration === undefined || registration.kind !== "factory") {
      throw new Error("expected factory");
    }
    expect(registration.create().pointIds).toEqual(["run.turn.post", "run.completion.pre"]);
  });
});
