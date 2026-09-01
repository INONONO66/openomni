import { WorkItem } from "@openomni/protocol";

function entropy(byteLength: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(byteLength));
}

export function newWorkItemId(): string {
  return WorkItem.generateHash(entropy(8));
}

export function newAttemptId(): string {
  return WorkItem.generateAttemptId(entropy(16));
}
