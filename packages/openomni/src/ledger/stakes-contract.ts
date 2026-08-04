import { z } from "zod";
import { snapshotFirstJsonSchema } from "../evidence/verifier-conformance-canonical.js";
import {
  expectedStakesComparison,
  expectedStakesReference,
  expectedWindowRef,
} from "./stakes-reference.js";
import { STAKES_POLICY_VERSION, STAKES_THETA } from "./stakes-policy.js";

export {
  STAKES_AMOUNT_DENOMINATION,
  STAKES_EPSILON,
  STAKES_POLICY_VERSION,
  STAKES_THETA,
} from "./stakes-policy.js";

export function createStakesSchemas() {
  const identifier = z.string().min(1).max(256);
  const safeTime = z.number().int().safe().nonnegative();
  const boundedCount = z.number().int().safe().nonnegative().max(1_000);
  const boundedMicros = z.number().int().safe().nonnegative().max(1_000_000_000_000);
  const safeScore = z.number().int().safe().nonnegative();
  const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
  const windowFields = {
    ownerKey: identifier,
    windowId: identifier,
    openedAt: safeTime,
    closesAt: safeTime,
  } as const;

  const StakesWindowInput = snapshotFirstJsonSchema(
    z
      .object(windowFields)
      .strict()
      .superRefine((window, context) => {
        if (window.closesAt <= window.openedAt) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "closesAt must be greater than openedAt",
            path: ["closesAt"],
          });
        }
      }),
  );
  const StakesWindow = snapshotFirstJsonSchema(
    z
      .object({
        ...windowFields,
        version: z.literal("stakes-window-v1"),
        policyVersion: z.literal(STAKES_POLICY_VERSION),
        windowRef: digest,
      })
      .strict()
      .superRefine((window, context) => {
        if (window.closesAt <= window.openedAt) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "closesAt must be greater than openedAt",
            path: ["closesAt"],
          });
        }
        if (window.windowRef !== expectedWindowRef(window)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "windowRef does not match window identity",
            path: ["windowRef"],
          });
        }
      })
      .readonly(),
  );
  const StakesAction = snapshotFirstJsonSchema(
    z
      .object({
        actionId: identifier,
        ownerKey: identifier,
        windowRef: digest,
        ledgerObservedAt: safeTime,
        facts: z
          .object({
            irreversibleChangeCount: boundedCount,
            externalSurfaceCount: boundedCount,
            spendMicros: boundedMicros,
            budgetReservedMicros: boundedMicros,
            outreachRecipientCount: boundedCount,
            contentFingerprints: z.array(digest).min(1).max(100).readonly(),
          })
          .strict()
          .readonly(),
      })
      .strict()
      .readonly(),
  );
  const StakesKnownFingerprint = snapshotFirstJsonSchema(
    z
      .object({
        ownerKey: identifier,
        fingerprint: digest,
        firstObservedAt: safeTime,
      })
      .strict()
      .readonly(),
  );
  const StakesWindowedLedgerState = snapshotFirstJsonSchema(
    z
      .object({
        window: StakesWindow,
        actions: z.array(StakesAction).max(100).readonly(),
        knownFingerprints: z.array(StakesKnownFingerprint).max(1_000).readonly(),
      })
      .strict()
      .superRefine((state, context) => {
        const actionIds = new Set<string>();
        for (const [index, action] of state.actions.entries()) {
          if (actionIds.has(action.actionId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "actionId must be unique",
              path: ["actions", index, "actionId"],
            });
          }
          actionIds.add(action.actionId);
        }
      })
      .readonly(),
  );
  const StakesAxes = snapshotFirstJsonSchema(
    z
      .object({
        irreversibility: safeScore,
        externalSurface: safeScore,
        spend: safeScore,
        budget: safeScore,
        outreach: safeScore,
        novelty: safeScore,
      })
      .strict()
      .readonly(),
  );
  const StakesValue = snapshotFirstJsonSchema(
    z
      .object({
        version: z.literal("stakes-v1"),
        policyVersion: z.literal(STAKES_POLICY_VERSION),
        reference: digest,
        inputDigest: digest,
        windowRef: digest,
        window: StakesWindow,
        axes: StakesAxes,
        value: safeScore,
        theta: z.literal(STAKES_THETA),
        comparison: z.enum(["below", "at", "above"]),
        includedActionIds: z.array(identifier).max(101).readonly(),
      })
      .strict()
      .superRefine((stakes, context) => {
        const expectedValue = Object.values(stakes.axes).reduce((total, axis) => total + axis, 0);
        if (stakes.value !== expectedValue) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "value does not match axes",
            path: ["value"],
          });
        }
        if (stakes.comparison !== expectedStakesComparison(stakes.value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "comparison does not match theta",
            path: ["comparison"],
          });
        }
        if (stakes.windowRef !== stakes.window.windowRef) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "windowRef does not match window",
            path: ["windowRef"],
          });
        }
        if (stakes.reference !== expectedStakesReference(stakes)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "reference does not match Stakes value",
            path: ["reference"],
          });
        }
      })
      .readonly(),
  );
  const StakesCriterionResult = snapshotFirstJsonSchema(
    z.enum([
      "verified",
      "asserted",
      "missing",
      "refuted",
      "inconclusive",
      "invalidated",
      "basis_mismatched",
      "verification_error",
    ]),
  );

  return {
    StakesWindowInput,
    StakesWindow,
    StakesAction,
    StakesKnownFingerprint,
    StakesWindowedLedgerState,
    StakesAxes,
    StakesValue,
    StakesCriterionResult,
  };
}

const schemas = createStakesSchemas();

export const StakesWindowInput = schemas.StakesWindowInput;
export type StakesWindowInput = z.infer<typeof StakesWindowInput>;
export const StakesWindow = schemas.StakesWindow;
export type StakesWindow = z.infer<typeof StakesWindow>;
export const StakesAction = schemas.StakesAction;
export type StakesAction = z.infer<typeof StakesAction>;
export const StakesKnownFingerprint = schemas.StakesKnownFingerprint;
export type StakesKnownFingerprint = z.infer<typeof StakesKnownFingerprint>;
export const StakesWindowedLedgerState = schemas.StakesWindowedLedgerState;
export type StakesWindowedLedgerState = z.infer<typeof StakesWindowedLedgerState>;
export const StakesAxes = schemas.StakesAxes;
export type StakesAxes = z.infer<typeof StakesAxes>;
export const StakesValue = schemas.StakesValue;
export type StakesValue = z.infer<typeof StakesValue>;
export const StakesCriterionResult = schemas.StakesCriterionResult;
export type StakesCriterionResult = z.infer<typeof StakesCriterionResult>;
