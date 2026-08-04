import type { CompletionStakesBinding } from "@openomni/openomni/ledger";
import { stakesDigest } from "./stakes-fixture.js";

export type BindingMutation<T> = Readonly<{
  name: string;
  denial: "binding_mismatch" | "invalid_subject";
  apply(binding: T): unknown;
}>;

type SharedBinding = Pick<
  CompletionStakesBinding,
  | "ownerKey"
  | "actionRef"
  | "windowRef"
  | "asOfOwnerSeq"
  | "calculatorVersion"
  | "basisRef"
  | "ledgerRangeDigest"
  | "noveltyBasisDigest"
>;

export const sharedBindingMutations: readonly BindingMutation<SharedBinding>[] = [
  mutation("ownerKey", (binding) => ({ ...binding, ownerKey: "owner:other" })),
  mutation("actionRef", (binding) => ({ ...binding, actionRef: "action:other" })),
  mutation("windowRef", (binding) => ({ ...binding, windowRef: stakesDigest("other-window") })),
  mutation("asOfOwnerSeq", (binding) => ({
    ...binding,
    asOfOwnerSeq: binding.asOfOwnerSeq + 1,
  })),
  mutation(
    "calculatorVersion",
    (binding) => ({
      ...binding,
      calculatorVersion: "stakes-policy-other",
    }),
    "invalid_subject",
  ),
  mutation("basisRef", (binding) => ({ ...binding, basisRef: stakesDigest("other-basis") })),
  mutation("ledgerRangeDigest", (binding) => ({
    ...binding,
    ledgerRangeDigest: stakesDigest("other-ledger-range"),
  })),
  mutation("noveltyBasisDigest", (binding) => ({
    ...binding,
    noveltyBasisDigest: stakesDigest("other-novelty-basis"),
  })),
];

function mutation<T>(
  name: string,
  apply: (binding: T) => unknown,
  denial: "binding_mismatch" | "invalid_subject" = "binding_mismatch",
): BindingMutation<T> {
  return { name, denial, apply };
}
