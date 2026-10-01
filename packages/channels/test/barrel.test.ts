import { expect, test } from "bun:test";
import * as barrel from "../src/index";

test("channels barrel exposes only its runtime public surface", () => {
  expect(Object.keys(barrel).sort()).toEqual([
    "ChannelProviders",
    "ChannelsFailure",
    "SendAdmissionConflict",
    "WebSocketHandler",
    "createChannelStores",
    "createGatewayRouter",
    "decodeChannelFailure",
    "resolveChannelGrant",
    "unconfiguredChannelStores",
  ]);
  expect("WebSocketFrames" in barrel).toBe(false);
  expect("InvalidInbound" in barrel).toBe(false);
});
