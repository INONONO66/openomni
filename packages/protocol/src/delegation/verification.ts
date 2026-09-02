import { z } from "zod";

/**
 * #807 — what an `assign` DECLARES will check its acceptance criteria, and the
 * closed vocabulary for "nothing checked it".
 *
 * A worker's own report is never verification. An assign that wants a verified
 * terminal names the check UP FRONT, at delegation time: an Owner-registered
 * executable id (never a path, never a shell string), a literal argv array,
 * and expectations that each bind to ONE acceptance criterion by index.
 * Binding by index is what lets the recorded result satisfy exactly the
 * criterion the requester meant, without re-deriving intent from text later.
 *
 * Deliberately absent: `shell`, `cwd`, `env`. The working directory is the
 * asking session's sandbox workspace and the environment is empty — both are
 * properties of the isolation profile, not per-request knobs, so there is no
 * field here to negotiate them with.
 */

/** Lowercase sha256 hex digest — the only expected-output form we compare. */
type Sha256Hex = string;
const Sha256Hex: z.ZodType<Sha256Hex> = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * One criterion's expected observation. Digests are optional because plenty of
 * checks are exit-code-only; when present they are compared byte-exactly
 * against the captured stream digest — raw output never becomes a fact.
 */
type CommandExpectation = {
  readonly criterionIndex: number;
  readonly exitCode: number;
  readonly stdoutSha256?: Sha256Hex;
  readonly stderrSha256?: Sha256Hex;
};
const CommandExpectation: z.ZodType<CommandExpectation> = z
  .object({
    criterionIndex: z.number().int().nonnegative(),
    exitCode: z.number().int(),
    stdoutSha256: Sha256Hex.optional(),
    stderrSha256: Sha256Hex.optional(),
  })
  .strict();

/**
 * The one verification kind v1 ships: run a registered executable with a fixed
 * argv and compare its exit code (and optionally its output digests) against
 * the declared expectation. `executable.id` resolves through the Owner's
 * registry — the declaration cannot name a path, so a delegation can never
 * widen what the verifier is allowed to execute.
 */
export const CommandV1 = z
  .object({
    kind: z.literal("command.v1"),
    executable: z.object({ id: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/) }).strict(),
    argv: z.array(z.string().max(4096)).max(64),
    timeoutMs: z.number().int().positive().max(600_000),
    expectations: z.array(CommandExpectation).min(1),
  })
  .strict()
  .superRefine((declaration, ctx) => {
    const bound = new Set<number>();
    for (const [index, expectation] of declaration.expectations.entries()) {
      if (bound.has(expectation.criterionIndex)) {
        ctx.addIssue({
          code: "custom",
          message: `criterionIndex ${expectation.criterionIndex} is already bound by another expectation`,
          path: ["expectations", index, "criterionIndex"],
        });
      }
      bound.add(expectation.criterionIndex);
    }
  });
export type CommandV1 = z.infer<typeof CommandV1>;

export const VerificationDeclaration = z.discriminatedUnion("kind", [CommandV1]);
export type VerificationDeclaration = z.infer<typeof VerificationDeclaration>;

/**
 * Why an assign ended WITHOUT verification. Closed vocabulary: an unverified
 * terminal states which of the honest reasons applies, never free text, so the
 * Owner can tell "nobody declared a check" from "the check refuted the work".
 *
 * - not_declared: the request carried no declaration (or left a required
 *   criterion unbound) — the worker's report is all that exists.
 * - verifier_unavailable: a declaration existed but no verifier was wired.
 * - verification_failed: the check ran and did not confirm every criterion.
 * - verification_error: the verifier itself could not produce a verdict.
 * - scope_superseded: the attempt/basis the check was bound to closed first.
 * - legacy_self_report: a pre-#807 row that recorded the worker's own
 *   "completed" claim, normalized on read.
 */
export const UnverifiedReason = z.enum([
  "not_declared",
  "verifier_unavailable",
  "verification_failed",
  "verification_error",
  "scope_superseded",
  "legacy_self_report",
]);
export type UnverifiedReason = z.infer<typeof UnverifiedReason>;
