import type { WorkItemLinkage } from "../../src/delegation/work-item-linkage";

/** A linkage that mints ids without touching the ledger, for kernel-focused tests. */
export function fakeWorkItemLinkage(): WorkItemLinkage {
  let sequence = 0;
  return {
    openAssign: () => {
      sequence += 1;
      return Promise.resolve(`wi-fake-${sequence}`);
    },
    closeAttempt: () => Promise.resolve(),
  };
}
