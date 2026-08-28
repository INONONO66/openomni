import { z } from "zod";

/**
 * Internal single owner for timestamp vocabulary. Not exported from the
 * package barrel: protocol schemas import it relatively so every wall-clock
 * field shares one contract instead of re-declaring bare `z.number()`.
 *
 * Epoch instants are finite and non-negative. No integer constraint: a
 * fractional millisecond is a valid instant, and persisted rows must keep
 * parsing across eras.
 */
export const EpochMs = z.number().finite().nonnegative();
export type EpochMs = z.infer<typeof EpochMs>;
