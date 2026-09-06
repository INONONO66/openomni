import { describe, expect, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/renderer/app";
import { uiMessagesToTranscript } from "../src/renderer/chat/adapter";
import type { OpenOmniUIMessage } from "../src/renderer/chat/message";
import { createMockChatTransport } from "../src/renderer/chat/mock-transport";
import { selectedSessionId } from "../src/renderer/mock/console";
import { timelines } from "../src/renderer/mock/timelines";

/**
 * The shell's transcript is now the SDK's message list, put through the
 * adapter — not a hand-built node array.
 *
 * That is the whole claim under test here, and it is asserted through the
 * rendered markup rather than by inspecting the component's props, because the
 * defect this replaces was exactly a surface that type-checked against one
 * model while rendering another. If `App` ever stops routing its chat state
 * through `uiMessagesToTranscript`, prose from the fixture, the tool row's
 * status word, and the approval tray all stop appearing at once.
 *
 * `renderToStaticMarkup` is the runner's only mount: there is no DOM here, so
 * what can be pinned is the first paint of the selected session — which is
 * precisely where the fixture-to-adapter path is decided.
 */

const html = renderToStaticMarkup(<App />);
const transcript = uiMessagesToTranscript(timelines[selectedSessionId] ?? []);

describe("the shell renders the selected session's SDK messages", () => {
  test("Given the fixture's prompt, When the app renders, Then the operator's own words appear", () => {
    const prompt = transcript.nodes.find((node) => node.kind === "prompt");

    expect(prompt).toBeDefined();
    expect(html).toContain("The ledger append path takes the lease twice");
    if (prompt?.kind === "prompt") expect(html).toContain(prompt.text.slice(0, 60));
  });

  test("Given the fixture's assistant prose, When the app renders, Then the answer appears", () => {
    // Prose that arrives BETWEEN two tool calls: it only survives if the
    // adapter's arrival-order walk is what produced the nodes.
    expect(html).toContain("The retry branch re-enters acquire()");
  });

  test("Given a tool call in the fixture, When the app renders, Then its row is drawn", () => {
    const tool = transcript.nodes.find((node) => node.kind === "tool");

    expect(tool).toBeDefined();
    expect(html).toContain(`data-tool-row="${tool?.id ?? ""}"`);
    // The target the adapter parsed out of the call's input — a path this
    // fixture only carries inside `input`, so a raw node array cannot produce it.
    expect(html).toContain("packages/kernel/src/ledger/append.rs");
  });

  test("Given a blocked call, When the app renders, Then the row reports the wait", () => {
    const waiting = transcript.nodes.find(
      (node) => node.kind === "tool" && node.status === "waiting",
    );

    expect(waiting).toBeDefined();
    expect(html).toContain("waiting for approval");
    expect(html).toContain(`data-tool-row="${waiting?.id ?? ""}"`);
  });

  test("Given an approval-requested part, When the app renders, Then the tray offers the decision", () => {
    const approval = transcript.pending[0];

    expect(approval).toBeDefined();
    expect(html).toContain('aria-label="Pending approval"');
    expect(html).toContain(approval?.summary ?? "");
    expect(approval?.summary).toContain("npm test");
    expect(approval?.reason).toBe("outside declared scope");
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
  });

  test("Given turn metadata, When the app renders, Then the turn's cost is printed", () => {
    const costs = Object.values(transcript.costs);

    expect(costs.length).toBeGreaterThan(0);
    for (const cost of costs) {
      expect(html).toContain(cost.elapsed);
    }
  });

  test("Given the fixture's turns, When the composer meta renders, Then it counts them", () => {
    expect(html).toContain(`${Object.keys(transcript.costs).length} turns`);
  });
});

describe("the chat is scoped to the selected session", () => {
  test("Given another session's timeline, When the app renders, Then its prose is absent", () => {
    // One `Chat` per session, and only the selected one is adapted. A shell
    // that concatenated timelines — or that adapted the wrong key — would put
    // this session's Korean summary under the ledger session's header.
    const other = uiMessagesToTranscript(timelines["kernel-lease"] ?? []);
    const prose = other.nodes.find((node) => node.kind === "assistant");

    expect(prose?.kind).toBe("assistant");
    expect(html).not.toContain("generation은 리스를 새로 획득할 때만 증가한다");
  });

  test("Given every mock session, When looked up, Then each adapts to a drawable transcript", () => {
    for (const id of Object.keys(timelines)) {
      const { nodes } = uiMessagesToTranscript(timelines[id] ?? []);
      expect(nodes.length, `no nodes for ${id}`).toBeGreaterThan(0);
    }
  });
});

/**
 * What the tray's two buttons actually do.
 *
 * `App` hands `onApprove`/`onDeny` straight to `addToolApprovalResponse`, so
 * what has to be pinned is that the id the tray gives back is one the SDK
 * accepts and that the outcome reaches the transcript. There is no DOM runner
 * here, so the decision is made on the same `Chat` the shell builds — the
 * fixture, the mock transport, and the adapter — rather than by clicking.
 *
 * The distinction matters: `addToolApprovalResponse` is keyed by the APPROVAL's
 * id, and the adapter deliberately puts that id on the row instead of the tool
 * call's. Passing a `toolCallId` here would silently no-op, which is exactly
 * the failure this test exists to catch.
 */
const BLOCKED_TOOL_CALL_ID = "tool10";
const BLOCKED_APPROVAL_ID = "approval-tool10";

function blockedChat() {
  return new Chat<OpenOmniUIMessage>({
    id: selectedSessionId,
    messages: [...(timelines[selectedSessionId] ?? [])],
    transport: createMockChatTransport(),
  });
}

describe("the tray's decision reaches the SDK", () => {
  test("Given a pending approval, When approved by its id, Then the call runs and the tray clears", async () => {
    const chat = blockedChat();
    const approval = uiMessagesToTranscript(chat.messages).pending[0];
    expect(approval?.toolId).toBe(BLOCKED_APPROVAL_ID);

    await chat.addToolApprovalResponse({ id: approval?.toolId ?? "", approved: true });
    const after = uiMessagesToTranscript(chat.messages);

    expect(after.pending).toHaveLength(0);
    const row = after.nodes.find(
      (node) => node.kind === "tool" && node.id === BLOCKED_TOOL_CALL_ID,
    );
    expect(row?.kind === "tool" && row.status).toBe("running");
  });

  test("Given a pending approval, When denied by its id, Then the row reads denied", async () => {
    const chat = blockedChat();
    const approval = uiMessagesToTranscript(chat.messages).pending[0];
    expect(approval?.toolId).toBe(BLOCKED_APPROVAL_ID);

    await chat.addToolApprovalResponse({ id: approval?.toolId ?? "", approved: false });
    const after = uiMessagesToTranscript(chat.messages);

    expect(after.pending).toHaveLength(0);
    const row = after.nodes.find(
      (node) => node.kind === "tool" && node.id === BLOCKED_TOOL_CALL_ID,
    );
    expect(row?.kind === "tool" && row.status).toBe("denied");
  });
});

const REPLY = "The lease is hoisted out of the retry branch, and then";

/**
 * Stop, while a turn is streaming.
 *
 * `App` pulls `stop` off `useChat` and hands it to `Console` as `onStop`, and
 * the composer swaps its primary action for a Stop button whenever a turn is in
 * flight. Neither half can be observed in the same place:
 *
 *   - The BUTTON is a static-render fact, and the shell's own render is always
 *     `ready` — `renderToStaticMarkup` is one synchronous pass, so no stream can
 *     be in flight during it. What is pinned here is the idle end of the swap:
 *     the shell draws Send and no Stop when nothing is running. The swap itself
 *     is pinned on `Composer`/`Console` in `packages/ui/test/composer.test.tsx`,
 *     where the sending state is a prop.
 *   - The HANDLER is a behaviour fact, so it is exercised the way this file
 *     already exercises approve, deny and send: on a real `Chat` over the real
 *     mock transport, with the stream held open by a gated tick so `stop()` has
 *     something to interrupt. No timers — the gate is a promise this test
 *     resolves itself.
 */
describe("stop while streaming", () => {
  test("Given nothing in flight, When the app renders, Then the composer offers Send", () => {
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain('aria-label="Stop response"');
  });

  test("Given a streaming turn, When stopped, Then the stream is cut and the chat is ready again", async () => {
    // The tick the mock transport awaits between chunks, held open by this test
    // rather than by a clock: the transport cannot emit its second chunk until
    // `release()` is called, so the window in which the turn is streaming is
    // deterministic instead of a race against a timeout.
    let release: () => void = () => {
      // Replaced synchronously by the promise's executor below.
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;

    const chat = new Chat<OpenOmniUIMessage>({
      id: selectedSessionId,
      messages: [...(timelines[selectedSessionId] ?? [])],
      transport: createMockChatTransport({
        replies: [REPLY],
        chunkSize: 4,
        tick: async () => {
          if (held) return;
          held = true;
          await gate;
        },
      }),
    });

    // Subscribed BEFORE the send, and awaited on the chat's own message
    // notification rather than on a count of microtasks or a clock: the moment
    // the first delta is IN the message list is the moment a turn is visibly in
    // flight, and how many turns of the SDK's loop that takes is the SDK's
    // business, not this test's.
    const streamed = new Promise<void>((resolve) => {
      const unsubscribe = chat["~registerMessagesCallback"](() => {
        if (streamedText(chat.messages).length > 0) {
          unsubscribe();
          resolve();
        }
      });
    });

    const sent = chat.sendMessage({ text: "hoist it" });
    // The first chunk has landed and the transport is parked on the gate, which
    // is exactly the state the Stop button exists for.
    await streamed;
    expect(chat.status).toBe("streaming");

    await chat.stop();
    release();
    await sent;

    expect(chat.status).toBe("ready");
    // What was streamed is KEPT. A stop that discarded the partial answer would
    // punish the Owner for interrupting, and the transcript would lose the very
    // output that told them to.
    const kept = streamedText(chat.messages);
    expect(kept.length).toBeGreaterThan(0);
    // A PREFIX, not the whole reply: the stop landed while the transport still
    // had chunks to send, so a test that saw the full string would be reporting
    // a stop that stopped nothing.
    expect(REPLY.startsWith(kept)).toBe(true);
    expect(kept).not.toBe(REPLY);
    const answer = uiMessagesToTranscript(chat.messages).nodes.at(-1);
    expect(answer?.kind).toBe("assistant");
    expect(answer?.kind === "assistant" && answer.blocks[0]?.text).toBe(kept);
  });
});

/** Everything the last assistant message has received so far, as one string. */
function streamedText(messages: readonly OpenOmniUIMessage[]): string {
  const last = messages.at(-1);
  if (last === undefined || last.role !== "assistant") return "";
  return last.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

describe("the composer's send reaches the transport", () => {
  test("Given a draft, When sent, Then the reply is appended as an assistant answer", async () => {
    const chat = new Chat<OpenOmniUIMessage>({
      id: selectedSessionId,
      messages: [...(timelines[selectedSessionId] ?? [])],
      transport: createMockChatTransport({ replies: ["Hoisted the lease."] }),
    });
    const before = uiMessagesToTranscript(chat.messages).nodes.length;

    await chat.sendMessage({ text: "hoist it" });
    const after = uiMessagesToTranscript(chat.messages);

    expect(chat.status).toBe("ready");
    // The prompt AND the streamed answer, both derived from the one message
    // list — not a fixture rendered beside a live stream.
    expect(after.nodes.length).toBe(before + 2);
    const answer = after.nodes.at(-1);
    expect(answer?.kind).toBe("assistant");
    expect(answer?.kind === "assistant" && answer.blocks[0]?.text).toBe("Hoisted the lease.");
  });
});
