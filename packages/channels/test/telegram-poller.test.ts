import { describe, expect, it } from "bun:test";
import { TelegramPoller } from "../src/provider/telegram/poller";
import type { TelegramMessage, TelegramUpdate } from "../src/provider/telegram/types";

function message(updateId: number): TelegramMessage {
  return {
    message_id: updateId + 90,
    from: { id: 7, is_bot: false, first_name: "Ada" },
    chat: { id: 7, type: "private" },
    date: 1,
    text: `update ${updateId}`,
  };
}

describe("TelegramPoller checkpoints", () => {
  it("resumes at a failed handoff without skipping later updates", async () => {
    const batch: TelegramUpdate[] = [
      { update_id: 10 },
      { update_id: 11, message: message(11) },
      { update_id: 12, message: message(12) },
    ];
    const requestedOffsets: number[] = [];
    const client = {
      async getUpdates(offset: number): Promise<TelegramUpdate[]> {
        requestedOffsets.push(offset);
        return batch.filter((update) => update.update_id >= offset);
      },
    };
    const handedOff: number[] = [];
    let fail = true;
    const poller = new TelegramPoller(
      client,
      {
        onMessage: async (telegramMessage) => {
          handedOff.push(telegramMessage.message_id);
          if (fail) {
            fail = false;
            throw new Error("handoff failed");
          }
        },
      },
      () => undefined,
    );

    let failure: unknown;
    try {
      await poller.pollOnce("trace-failed-batch");
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("handoff failed");

    await poller.pollOnce("trace-retry-batch");
    await poller.pollOnce("trace-after-success");

    // update 10 is non-deliverable and checkpoints in order; failure at 11
    // prevents 12 from being touched until 11 succeeds on the next cycle.
    expect(requestedOffsets).toEqual([0, 11, 13]);
    expect(handedOff).toEqual([101, 101, 102]);
  });
});
