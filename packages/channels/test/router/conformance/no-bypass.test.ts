import { beforeEach, expect, test } from "bun:test";
import { registerChannelGrant } from "../../helpers/channel-grant";
import {
  commits,
  kernelRouter,
  ownerFacts,
  ownerSender,
  resetRouterState,
} from "../_router-fixture";

beforeEach(resetRouterState);

test("unauthorized external sender cannot reach inbox commit", async () => {
  registerChannelGrant();
  expect(await kernelRouter().ingest(ownerSender, ownerFacts)).toMatchObject({
    status: "blocked_pre",
  });
  expect(commits).toEqual([]);
});
