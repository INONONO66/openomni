import type { EffectDriver } from "./driver.js";

/**
 * #492 effect manifest — the kind registry and input boundary. A request for
 * an unmanifested kind, or input that fails the kind's sanitizer, is REFUSED
 * before any ledger write: a refusal leaves the effect unmanifested (zero
 * facts, materializationCount 0), never a dangling intent. This is the "no
 * record, no action" boundary running one step earlier than the store — an
 * unsafe request must not even reach record-before-act.
 */
export type EffectRefusalCode = "unmanifested_request" | "unsanitized_input";

export class EffectRefusal extends Error {
  readonly name = "EffectRefusal";
  /** A refused request never materializes: no intent, no outcome, no fact. */
  readonly materializationCount = 0;

  constructor(
    readonly code: EffectRefusalCode,
    message: string,
    readonly kind?: string,
  ) {
    super(message);
  }
}

/** Validates/normalizes transient request input; throws {@link EffectRefusal} on reject. */
export type InputSanitizer = (input: unknown) => unknown;

export class EffectManifest {
  private readonly drivers = new Map<string, EffectDriver>();
  private readonly sanitizers = new Map<string, InputSanitizer>();

  register(driver: EffectDriver, sanitize?: InputSanitizer): void {
    if (this.drivers.has(driver.kind)) {
      throw new Error(`effect kind already manifested: ${driver.kind}`);
    }
    this.drivers.set(driver.kind, driver);
    if (sanitize) this.sanitizers.set(driver.kind, sanitize);
  }

  tryResolve(kind: string): EffectDriver | undefined {
    return this.drivers.get(kind);
  }

  resolve(kind: string): EffectDriver {
    const driver = this.drivers.get(kind);
    if (!driver) {
      throw new EffectRefusal(
        "unmanifested_request",
        `no effect driver manifested for kind: ${kind}`,
        kind,
      );
    }
    return driver;
  }

  sanitize(kind: string, input: unknown): unknown {
    const sanitizer = this.sanitizers.get(kind);
    if (!sanitizer) return input;
    try {
      return sanitizer(input);
    } catch (error) {
      if (error instanceof EffectRefusal) throw error;
      throw new EffectRefusal(
        "unsanitized_input",
        `effect input rejected for kind ${kind}: ${error instanceof Error ? error.message : String(error)}`,
        kind,
      );
    }
  }
}
