import { expect, test } from "bun:test";
import { GitHubAdapter } from "../src/provider/github/surface";
import { signedWebhook } from "./helpers/github";

const invalidBodies = [
  { body: "{", status: 400 },
  { body: "", status: 400 },
  { body: "not json", status: 400 },
  { body: "null", status: 200 },
  { body: "[]", status: 200 },
  { body: "42", status: 200 },
  { body: '"text"', status: 200 },
];

test.each(invalidBodies)("signed non-event payload $body returns $status without dispatch", async ({
  body,
  status,
}) => {
  const adapter = new GitHubAdapter("secret", {}, () => undefined);
  let calls = 0;
  adapter.onMessage(async () => {
    calls += 1;
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await adapter.handleWebhook(signedWebhook(body, "secret", "delivery"));
    expect(response.status).toBe(status);
  }
  expect(calls).toBe(0);
});
