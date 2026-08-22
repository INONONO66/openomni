import { typedCall, type IpcClient } from "../../src/index.js";

declare const client: IpcClient;

// Compile-red provenance: before typedCall, both of these compiled through
// IpcClient.call (targeted tsc exit 0; fixture SHA recorded in Todo 16 receipt).
// @ts-expect-error known method params must come from the protocol schema
typedCall(client, "worker.shutdown_idle", { definitelyWrong: true });

// @ts-expect-error known method results must come from the protocol schema
const wrongResult: Promise<{ acknowledged: "not-a-boolean" }> = typedCall(
  client,
  "worker.shutdown_idle",
  { authToken: "token", workerId: "worker-1" },
);

const validResult: Promise<{ acknowledged: boolean; error?: string }> = typedCall(
  client,
  "worker.shutdown_idle",
  { authToken: "token", workerId: "worker-1" },
);

// The original generic surface intentionally supports unknown mixed-version methods.
const mixedVersionResult: Promise<unknown> = client.call("future.peer_method", { future: true });

void wrongResult;
void validResult;
void mixedVersionResult;
