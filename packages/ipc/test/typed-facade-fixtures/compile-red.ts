import { typedCall, type IpcClient } from "../../src/index.js";

declare const client: IpcClient;

// Compile-red provenance: before typedCall, both of these compiled through
// IpcClient.call (targeted tsc exit 0; fixture SHA recorded in Todo 16 receipt).
// @ts-expect-error known method params must come from the protocol schema
typedCall(client, "machine.run_cell", { definitelyWrong: true });

// @ts-expect-error known method results must come from the protocol schema
const wrongResult: Promise<{ status: "not-a-cell-terminal" }> = typedCall(
  client,
  "machine.run_cell",
  { cellId: "cell-1", code: "print(1)", timeoutMs: 1_000 },
);

const validResult: ReturnType<typeof typedCall<"machine.run_cell">> = typedCall(
  client,
  "machine.run_cell",
  { cellId: "cell-1", code: "print(1)", timeoutMs: 1_000 },
);

// The original generic surface intentionally supports unknown mixed-version methods.
const mixedVersionResult: Promise<unknown> = client.call("future.peer_method", { future: true });

void wrongResult;
void validResult;
void mixedVersionResult;
