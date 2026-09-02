import { Trigger, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { commitFact, runCommitTransaction } from "../storage/commit-coordinator";
import { Storage } from "../storage/storage";

type NonAckSchedulerInput = Exclude<
  Trigger.SchedulerInput,
  { readonly type: "delivery_acknowledged" }
>;

type TriggerTransitionRequest = Readonly<{
  triggerId: string;
  expectedRevision: number;
  input: NonAckSchedulerInput;
  traceId: string;
}>;

type TriggerTransitionReceipt = Readonly<{
  trigger: Trigger.Record;
  fire?: Trigger.Fire;
  effects: readonly Trigger.SchedulerEffect[];
}>;

type TriggerAckRequest = Readonly<{
  fireId: string;
  expectedFireRevision: number;
  expectedTriggerRevision: number;
  admission: Trigger.FireAdmission;
  nextReservation?: Readonly<{
    pendingFingerprint: Trigger.CanonicalDigest;
    reservation: Trigger.FireReservation;
  }>;
  traceId: string;
  at: number;
}>;

function requireTriggerAdapter(): ProtocolStorage.TriggerSubAdapter {
  const adapter = Storage.get().trigger;
  if (!adapter) {
    throw storeError(
      "adapter_absent",
      "Storage adapter does not implement trigger — durable Trigger writes fail closed",
    );
  }
  return adapter;
}

function requireFireAdapter(): ProtocolStorage.TriggerFireSubAdapter {
  const adapter = Storage.get().triggerFire;
  if (!adapter) {
    throw storeError(
      "adapter_absent",
      "Storage adapter does not implement triggerFire — durable Trigger Fire writes fail closed",
    );
  }
  return adapter;
}

function requireLedger(): ProtocolStorage.LedgerSubAdapter {
  const ledger = Storage.get().ledger;
  if (!ledger) {
    throw storeError(
      "adapter_absent",
      "Storage adapter does not implement ledger append — durable Trigger writes fail closed",
    );
  }
  return ledger;
}

function triggerStreamId(triggerId: string): string {
  return `trigger:${triggerId}`;
}

function fireStreamId(fireId: string): string {
  return `trigger_fire:${fireId}`;
}

function storeError(
  code: Trigger.StoreErrorCode,
  message: string,
  identity: { triggerId?: string; fireId?: string } = {},
): InstanceType<typeof Trigger.StoreError> {
  return new Trigger.StoreError({ message, code, ...identity });
}

function revisionConflict(
  kind: "Trigger" | "Trigger Fire",
  id: string,
  expected: number,
): InstanceType<typeof Trigger.StoreError> {
  return storeError(
    "revision_conflict",
    `${kind} revision conflict: ${id} expected=${expected}`,
    kind === "Trigger" ? { triggerId: id } : { fireId: id },
  );
}

function runTriggerTransaction<T>(identity: string, write: () => T): T {
  return runCommitTransaction(Storage.get(), write, (cause) =>
    storeError(
      "unavailable",
      `Trigger storage busy: ${identity} — ${cause instanceof Error ? cause.message : String(cause)}`,
    ),
  );
}

function nestedTransaction<T>(operation: () => T): T {
  return Storage.get().transaction(operation);
}

function readTrigger(
  adapter: ProtocolStorage.TriggerSubAdapter,
  id: string,
): Trigger.Record | undefined {
  try {
    return adapter.get(id);
  } catch (error) {
    if (!isCorruptRead(error)) throw error;
    throw storeError("corrupt", `Trigger record is corrupt: ${id} — ${errorMessage(error)}`, {
      triggerId: id,
    });
  }
}

function readFire(
  adapter: ProtocolStorage.TriggerFireSubAdapter,
  id: string,
): Trigger.Fire | undefined {
  try {
    return adapter.get(id);
  } catch (error) {
    if (!isCorruptRead(error)) throw error;
    throw storeError("corrupt", `Trigger Fire record is corrupt: ${id} — ${errorMessage(error)}`, {
      fireId: id,
    });
  }
}

function isCorruptRead(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      (error.name === "ZodError" || error.message.includes("indexed projection mismatch")))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireParent(
  triggerAdapter: ProtocolStorage.TriggerSubAdapter,
  fire: Trigger.Fire,
): Trigger.Record {
  const trigger = readTrigger(triggerAdapter, fire.triggerId);
  if (!trigger || trigger.ownerSessionId !== fire.ownerSessionId) {
    throw storeError(
      "corrupt",
      `Trigger Fire ${fire.id} has no matching parent Trigger ${fire.triggerId}`,
      { triggerId: fire.triggerId, fireId: fire.id },
    );
  }
  return trigger;
}

function buildCreateRecord(input: Trigger.Create): Trigger.Record {
  const parsed = Trigger.Create.parse(input);
  const common = {
    id: parsed.id,
    ownerSessionId: parsed.ownerSessionId,
    prompt: parsed.prompt,
    lifecycle: { state: "armed" as const },
    createdAt: parsed.at,
    updatedAt: parsed.at,
    revision: 1,
    lastObservedAt: parsed.at,
    fireCount: 0,
    coalescedFirePending: false,
  };

  switch (parsed.source.kind) {
    case "time.once":
      return Trigger.Record.parse({ ...common, source: parsed.source });
    case "time.every": {
      const requestedIntervalMs = parsed.source.intervalMs;
      const effectiveIntervalMs = Math.max(
        requestedIntervalMs,
        Trigger.Constants.MIN_RECURRING_INTERVAL_MS,
      );
      const expiresAt = checkedAdd(parsed.at, Trigger.Constants.RECURRING_LIFETIME_MS, parsed.id);
      const nextFireAt = checkedAdd(parsed.at, effectiveIntervalMs, parsed.id);
      if (nextFireAt >= expiresAt) {
        throw storeError(
          "invalid_transition",
          `Trigger ${parsed.id} recurring interval cannot fire before expiry`,
          { triggerId: parsed.id },
        );
      }
      return Trigger.Record.parse({
        ...common,
        source: { kind: "time.every", intervalMs: effectiveIntervalMs },
        expiresAt,
        requestedIntervalMs,
        effectiveIntervalMs,
        nextFireAt,
      });
    }
    case "event.command":
      return Trigger.Record.parse({
        ...common,
        source: parsed.source,
        ...(parsed.source.persistent
          ? {}
          : {
              expiresAt: checkedAdd(parsed.at, Trigger.Constants.SOURCE_TIMEOUT_MS, parsed.id),
            }),
      });
    case "event.file":
      return Trigger.Record.parse({
        ...common,
        source: parsed.source,
        expiresAt: checkedAdd(parsed.at, Trigger.Constants.SOURCE_TIMEOUT_MS, parsed.id),
      });
  }
}

function checkedAdd(left: number, right: number, triggerId: string): number {
  if (right > Trigger.Constants.MAX_COUNTER - left) {
    throw storeError(
      "invalid_transition",
      `Trigger ${triggerId} deadline exceeds the safe-integer range`,
      { triggerId },
    );
  }
  return left + right;
}

function buildFire(trigger: Trigger.Record, reservation: Trigger.FireReservation): Trigger.Fire {
  return Trigger.Fire.parse({
    ...Trigger.FireReservation.parse(reservation),
    triggerId: trigger.id,
    ownerSessionId: trigger.ownerSessionId,
    recordedAt: trigger.updatedAt,
    status: "recorded",
    deliveryAttempts: 0,
    revision: 1,
    updatedAt: trigger.updatedAt,
  });
}

function reservationFromInput(input: NonAckSchedulerInput): Trigger.FireReservation | undefined {
  if (!("fireMaterial" in input) || input.fireMaterial === undefined) return undefined;
  return input.fireMaterial.reservation;
}

function pendingFingerprintFromInput(
  input: NonAckSchedulerInput,
): Trigger.CanonicalDigest | undefined {
  if (!("fireMaterial" in input) || input.fireMaterial === undefined) return undefined;
  return input.fireMaterial.pendingBatch.fingerprint;
}

function exactTransitionReceipt(
  request: TriggerTransitionRequest,
  current: Trigger.Record,
  fireAdapter: ProtocolStorage.TriggerFireSubAdapter,
): TriggerTransitionReceipt | undefined {
  const reservation = reservationFromInput(request.input);
  if (reservation !== undefined && current.inFlightFireId === reservation.id) {
    const fire = readFire(fireAdapter, reservation.id);
    if (
      fire !== undefined &&
      fire.triggerId === current.id &&
      fire.ownerSessionId === current.ownerSessionId &&
      fire.payloadDigest === reservation.payloadDigest
    ) {
      return { trigger: current, fire, effects: [] };
    }
  }
  const fingerprint = pendingFingerprintFromInput(request.input);
  if (fingerprint !== undefined && current.pendingBatch?.fingerprint === fingerprint) {
    return { trigger: current, effects: [] };
  }
  return undefined;
}

type ParentFact = Readonly<{
  type: string;
  data: Record<string, unknown>;
  record: Trigger.Record;
}>;

function parentFacts(
  current: Trigger.Record,
  next: Trigger.Record,
  input: NonAckSchedulerInput,
  reservation: Trigger.FireReservation | undefined,
): ParentFact[] {
  if (next.revision === current.revision) return [];
  const kinds: Array<"reserved" | "coalesced" | "paused" | "rearmed" | "ended" | "restored"> = [];
  if (
    reservation !== undefined &&
    next.inFlightFireId === reservation.id &&
    current.inFlightFireId !== reservation.id
  ) {
    kinds.push("reserved");
  } else if (
    next.pendingBatch !== undefined &&
    next.pendingBatch.fingerprint !== current.pendingBatch?.fingerprint
  ) {
    kinds.push("coalesced");
  }

  if (next.lifecycle.state === "ended" && current.lifecycle.state !== "ended") {
    kinds.push("ended");
  } else if (input.type === "pause" && next.revision > current.revision + kinds.length) {
    kinds.push("paused");
  } else if (input.type === "rearm" && next.revision > current.revision + kinds.length) {
    kinds.push("rearmed");
  } else if (input.type === "restore" && kinds.length === 0) {
    kinds.push("restored");
  }

  if (next.revision !== current.revision + kinds.length) {
    throw storeError(
      "corrupt",
      `Trigger ${current.id} scheduler revision delta does not match its durable facts`,
      { triggerId: current.id },
    );
  }

  return kinds.map((kind, index) => {
    const revision = current.revision + index + 1;
    const record =
      index === kinds.length - 1
        ? next
        : Trigger.Record.parse({
            ...next,
            lifecycle: current.lifecycle,
            revision,
          });
    return { type: parentFactType(kind), data: parentFactData(kind, record, reservation), record };
  });
}

function parentFactType(
  kind: "reserved" | "coalesced" | "paused" | "rearmed" | "ended" | "restored",
) {
  switch (kind) {
    case "reserved":
      return "trigger.fire.reserved";
    case "coalesced":
      return "trigger.fire.coalesced";
    case "paused":
      return "trigger.paused";
    case "rearmed":
      return "trigger.rearmed";
    case "ended":
      return "trigger.ended";
    case "restored":
      return "trigger.restored";
  }
}

function parentFactData(
  kind: "reserved" | "coalesced" | "paused" | "rearmed" | "ended" | "restored",
  record: Trigger.Record,
  reservation: Trigger.FireReservation | undefined,
): Record<string, unknown> {
  switch (kind) {
    case "reserved":
      if (!reservation) throw new Error("reservation fact is missing its reservation");
      return {
        fireId: reservation.id,
        cause: reservation.cause,
        payloadDigest: reservation.payloadDigest,
        revision: record.revision,
      };
    case "coalesced":
      return { fingerprint: record.pendingBatch?.fingerprint, revision: record.revision };
    case "paused":
      return {
        pauseReason: record.lifecycle.state === "paused" ? record.lifecycle.pauseReason : undefined,
        revision: record.revision,
      };
    case "rearmed":
      return { nextFireAt: record.nextFireAt, revision: record.revision };
    case "ended":
      return {
        endReason: record.lifecycle.state === "ended" ? record.lifecycle.endReason : undefined,
        revision: record.revision,
      };
    case "restored":
      return { state: record.lifecycle.state, revision: record.revision };
  }
}

function appendParentFact(
  adapter: ProtocolStorage.TriggerSubAdapter,
  ledger: ProtocolStorage.LedgerSubAdapter,
  triggerId: string,
  expectedRevision: number,
  fact: ParentFact,
): void {
  const committed = commitFact(
    ledger,
    {
      streamId: triggerStreamId(triggerId),
      expectedHead: expectedRevision,
      fact: { type: fact.type, data: fact.data },
    },
    () => adapter.compareAndSet(triggerId, expectedRevision, fact.record) || false,
    nestedTransaction,
  );
  if (committed.kind !== "committed") {
    throw revisionConflict("Trigger", triggerId, expectedRevision);
  }
}

function appendFireCreate(
  adapter: ProtocolStorage.TriggerFireSubAdapter,
  ledger: ProtocolStorage.LedgerSubAdapter,
  fire: Trigger.Fire,
): void {
  const committed = commitFact(
    ledger,
    {
      streamId: fireStreamId(fire.id),
      expectedHead: 0,
      fact: {
        type: "trigger.fire.recorded",
        data: {
          triggerId: fire.triggerId,
          status: fire.status,
          cause: fire.cause,
          payloadDigest: fire.payloadDigest,
          revision: fire.revision,
        },
      },
    },
    () => adapter.create(fire) || false,
    nestedTransaction,
  );
  if (committed.kind !== "committed") {
    throw storeError("duplicate", `Trigger Fire already exists: ${fire.id}`, {
      triggerId: fire.triggerId,
      fireId: fire.id,
    });
  }
}

function publishParentFacts(facts: readonly ParentFact[], traceId: string): void {
  for (const fact of facts) {
    const trigger = fact.record;
    const base = {
      traceId,
      time: trigger.updatedAt,
      triggerId: trigger.id,
      triggerRevision: trigger.revision,
    };
    switch (fact.type) {
      case "trigger.paused":
        if (trigger.lifecycle.state === "paused") {
          Bus.publish(Trigger.Events.Paused, {
            ...base,
            pauseReason: trigger.lifecycle.pauseReason,
          });
        }
        break;
      case "trigger.rearmed":
        Bus.publish(Trigger.Events.Rearmed, { ...base, nextFireAt: trigger.nextFireAt });
        break;
      case "trigger.ended":
        if (trigger.lifecycle.state === "ended") {
          Bus.publish(Trigger.Events.Ended, { ...base, endReason: trigger.lifecycle.endReason });
        }
        break;
    }
  }
}

function publishFireRecorded(fire: Trigger.Fire, triggerRevision: number, traceId: string): void {
  Bus.publish(Trigger.Events.FireRecorded, {
    traceId,
    time: fire.recordedAt,
    triggerId: fire.triggerId,
    fireId: fire.id,
    fireRevision: fire.revision,
    cause: fire.cause,
    triggerRevision,
  });
}

function publishTransition(
  facts: readonly ParentFact[],
  receipt: TriggerTransitionReceipt,
  traceId: string,
): void {
  for (const fact of facts) {
    if (fact.type === "trigger.fire.reserved" && receipt.fire) {
      publishFireRecorded(receipt.fire, receipt.trigger.revision, traceId);
    }
    publishParentFacts([fact], traceId);
  }
}

function applyTransition(
  request: TriggerTransitionRequest,
  triggerAdapter: ProtocolStorage.TriggerSubAdapter,
  fireAdapter: ProtocolStorage.TriggerFireSubAdapter,
  ledger: ProtocolStorage.LedgerSubAdapter,
): { receipt: TriggerTransitionReceipt; parentFacts: ParentFact[] } {
  const current = readTrigger(triggerAdapter, request.triggerId);
  if (!current) {
    throw storeError("not_found", `Trigger not found: ${request.triggerId}`, {
      triggerId: request.triggerId,
    });
  }
  if (current.revision !== request.expectedRevision) {
    const receipt = exactTransitionReceipt(request, current, fireAdapter);
    if (receipt) return { receipt, parentFacts: [] };
    throw revisionConflict("Trigger", request.triggerId, request.expectedRevision);
  }

  const result = Trigger.Scheduler.step(current, request.input);
  const reservation = reservationFromInput(request.input);
  const facts = parentFacts(current, result.record, request.input, reservation);
  const fire =
    reservation !== undefined &&
    result.record.inFlightFireId === reservation.id &&
    current.inFlightFireId !== reservation.id
      ? buildFire(result.record, reservation)
      : undefined;

  for (const fact of facts) {
    appendParentFact(triggerAdapter, ledger, current.id, fact.record.revision - 1, fact);
    if (fact.type === "trigger.fire.reserved") {
      if (!fire) {
        throw storeError("corrupt", `Trigger ${current.id} reserved no Fire`, {
          triggerId: current.id,
        });
      }
      appendFireCreate(fireAdapter, ledger, fire);
    }
  }
  return {
    receipt: { trigger: result.record, ...(fire ? { fire } : {}), effects: result.effects },
    parentFacts: facts,
  };
}

export namespace TriggerStore {
  export type TransitionRequest = TriggerTransitionRequest;
  export type TransitionReceipt = TriggerTransitionReceipt;

  export function create(input: Trigger.Create, traceId: string): Trigger.Record {
    const triggerAdapter = requireTriggerAdapter();
    const ledger = requireLedger();
    const record = buildCreateRecord(input);
    runTriggerTransaction(record.id, () => {
      if (readTrigger(triggerAdapter, record.id) !== undefined) {
        throw storeError("duplicate", `Trigger already exists: ${record.id}`, {
          triggerId: record.id,
        });
      }
      if (
        triggerAdapter.countActiveByOwner(record.ownerSessionId) >=
        Trigger.Constants.ACTIVE_TRIGGER_CAP
      ) {
        throw storeError(
          "active_cap",
          `Trigger active cap reached for owner session ${record.ownerSessionId}`,
          { triggerId: record.id },
        );
      }
      const committed = commitFact(
        ledger,
        {
          streamId: triggerStreamId(record.id),
          expectedHead: 0,
          fact: {
            type: "trigger.created",
            data: {
              ownerSessionId: record.ownerSessionId,
              kind: record.source.kind,
              revision: record.revision,
            },
          },
        },
        () => triggerAdapter.create(record) || false,
        nestedTransaction,
      );
      if (committed.kind !== "committed") {
        throw storeError("duplicate", `Trigger already exists: ${record.id}`, {
          triggerId: record.id,
        });
      }
    });
    Bus.publish(Trigger.Events.Created, {
      traceId,
      time: record.createdAt,
      triggerId: record.id,
      ownerSessionId: record.ownerSessionId,
      kind: record.source.kind,
      triggerRevision: record.revision,
    });
    return record;
  }

  export function get(id: string): Trigger.Record | undefined {
    return readTrigger(requireTriggerAdapter(), id);
  }

  export function list(filter?: ProtocolStorage.TriggerListFilter): Trigger.Record[] {
    try {
      return requireTriggerAdapter().list(filter);
    } catch (error) {
      if (!isCorruptRead(error)) throw error;
      throw storeError(
        "corrupt",
        `Trigger list contains a corrupt record — ${errorMessage(error)}`,
      );
    }
  }

  export function listActiveIds(): string[] {
    return requireTriggerAdapter().listActiveIds();
  }

  export function transition(request: TriggerTransitionRequest): TriggerTransitionReceipt {
    const triggerAdapter = requireTriggerAdapter();
    const fireAdapter = requireFireAdapter();
    const ledger = requireLedger();
    const committed = runTriggerTransaction(request.triggerId, () =>
      applyTransition(request, triggerAdapter, fireAdapter, ledger),
    );
    publishTransition(committed.parentFacts, committed.receipt, request.traceId);
    return committed.receipt;
  }

  export function transitionBatch(
    requests: readonly TriggerTransitionRequest[],
  ): readonly TriggerTransitionReceipt[] {
    if (requests.length < 1 || requests.length > Trigger.Constants.TRANSITION_BATCH_CAP) {
      throw storeError(
        "invalid_transition",
        `Trigger transition batch must contain 1..${Trigger.Constants.TRANSITION_BATCH_CAP} requests`,
      );
    }
    const triggerAdapter = requireTriggerAdapter();
    const fireAdapter = requireFireAdapter();
    const ledger = requireLedger();
    const committed = runTriggerTransaction("batch", () =>
      requests.map((request) => ({
        request,
        ...applyTransition(request, triggerAdapter, fireAdapter, ledger),
      })),
    );
    for (const item of committed) {
      publishTransition(item.parentFacts, item.receipt, item.request.traceId);
    }
    return committed.map((item) => item.receipt);
  }
}

type FireWriteRequest = Readonly<{
  fireId: string;
  expectedFireRevision: number;
  traceId: string;
  at: number;
}>;

function appendFireUpdate(
  adapter: ProtocolStorage.TriggerFireSubAdapter,
  ledger: ProtocolStorage.LedgerSubAdapter,
  current: Trigger.Fire,
  next: Trigger.Fire,
  type: string,
  data: Record<string, unknown>,
): void {
  const committed = commitFact(
    ledger,
    {
      streamId: fireStreamId(current.id),
      expectedHead: current.revision,
      fact: { type, data: { ...data, revision: next.revision } },
    },
    () => adapter.compareAndSet(current.id, current.revision, next) || false,
    nestedTransaction,
  );
  if (committed.kind !== "committed") {
    throw revisionConflict("Trigger Fire", current.id, current.revision);
  }
}

function assertMutableFire(
  fire: Trigger.Fire,
  expectedRevision: number,
  triggerAdapter: ProtocolStorage.TriggerSubAdapter,
): Trigger.Record {
  const parent = requireParent(triggerAdapter, fire);
  if (fire.revision !== expectedRevision) {
    throw revisionConflict("Trigger Fire", fire.id, expectedRevision);
  }
  if (fire.status !== "recorded") {
    throw storeError(
      "invalid_transition",
      `Trigger Fire ${fire.id} cannot transition from ${fire.status}`,
      { triggerId: fire.triggerId, fireId: fire.id },
    );
  }
  return parent;
}

function sameAdmission(left: Trigger.FireAdmission, right: Trigger.FireAdmission): boolean {
  return (
    left.fireId === right.fireId &&
    left.sessionId === right.sessionId &&
    left.messageId === right.messageId &&
    left.payloadDigest === right.payloadDigest
  );
}

export namespace TriggerFireStore {
  export function get(fireId: string): Trigger.Fire | undefined {
    const fire = readFire(requireFireAdapter(), fireId);
    if (!fire) return undefined;
    requireParent(requireTriggerAdapter(), fire);
    return fire;
  }

  export function list(filter?: ProtocolStorage.TriggerFireListFilter): Trigger.Fire[] {
    const fireAdapter = requireFireAdapter();
    const triggerAdapter = requireTriggerAdapter();
    let fires: Trigger.Fire[];
    try {
      fires = fireAdapter.list(filter);
    } catch (error) {
      if (!isCorruptRead(error)) throw error;
      throw storeError(
        "corrupt",
        `Trigger Fire list contains a corrupt record — ${errorMessage(error)}`,
      );
    }
    for (const fire of fires) requireParent(triggerAdapter, fire);
    return fires;
  }

  export function listUnackedIds(): string[] {
    return requireFireAdapter().listUnackedIds();
  }

  export function claimDeliveryAttempt(request: FireWriteRequest): Trigger.Fire {
    const fireAdapter = requireFireAdapter();
    const triggerAdapter = requireTriggerAdapter();
    const ledger = requireLedger();
    return runTriggerTransaction(request.fireId, () => {
      const current = readFire(fireAdapter, request.fireId);
      if (!current) {
        throw storeError("not_found", `Trigger Fire not found: ${request.fireId}`, {
          fireId: request.fireId,
        });
      }
      assertMutableFire(current, request.expectedFireRevision, triggerAdapter);
      if (current.deliveryAttempts === Trigger.Constants.MAX_COUNTER) {
        throw storeError("corrupt", `Trigger Fire attempt counter is exhausted: ${current.id}`, {
          triggerId: current.triggerId,
          fireId: current.id,
        });
      }
      const next = Trigger.Fire.parse({
        ...current,
        deliveryAttempts: current.deliveryAttempts + 1,
        revision: current.revision + 1,
        updatedAt: request.at,
      });
      appendFireUpdate(fireAdapter, ledger, current, next, "trigger.fire.delivery_attempted", {
        deliveryAttempts: next.deliveryAttempts,
      });
      return next;
    });
  }

  export function markDelivered(request: FireWriteRequest): Trigger.Fire {
    const fireAdapter = requireFireAdapter();
    const triggerAdapter = requireTriggerAdapter();
    const ledger = requireLedger();
    const committed = runTriggerTransaction(request.fireId, () => {
      const current = readFire(fireAdapter, request.fireId);
      if (!current) {
        throw storeError("not_found", `Trigger Fire not found: ${request.fireId}`, {
          fireId: request.fireId,
        });
      }
      const parent = requireParent(triggerAdapter, current);
      if (current.status === "delivered" || current.status === "acked") {
        return { fire: current, parent, changed: false };
      }
      assertMutableFire(current, request.expectedFireRevision, triggerAdapter);
      const next = Trigger.Fire.parse({
        ...current,
        status: "delivered",
        deliveredAt: request.at,
        revision: current.revision + 1,
        updatedAt: request.at,
      });
      appendFireUpdate(fireAdapter, ledger, current, next, "trigger.fire.delivered", {
        status: next.status,
        deliveredAt: next.deliveredAt,
      });
      return { fire: next, parent, changed: true };
    });
    if (committed.changed) {
      Bus.publish(Trigger.Events.FireDelivered, {
        traceId: request.traceId,
        time: committed.fire.deliveredAt ?? committed.fire.updatedAt,
        triggerId: committed.fire.triggerId,
        fireId: committed.fire.id,
        fireRevision: committed.fire.revision,
        sessionId: committed.fire.ownerSessionId,
      });
    }
    return committed.fire;
  }

  export function ack(request: TriggerAckRequest): {
    fire: Trigger.Fire;
    trigger: Trigger.Record;
    nextFire?: Trigger.Fire;
  } {
    const admission = Trigger.FireAdmission.parse(request.admission);
    const fireAdapter = requireFireAdapter();
    const triggerAdapter = requireTriggerAdapter();
    const ledger = requireLedger();
    const committed = runTriggerTransaction(request.fireId, () => {
      const currentFire = readFire(fireAdapter, request.fireId);
      if (!currentFire) {
        throw storeError("not_found", `Trigger Fire not found: ${request.fireId}`, {
          fireId: request.fireId,
        });
      }
      const currentTrigger = requireParent(triggerAdapter, currentFire);
      if (currentFire.status === "acked") {
        if (currentFire.admission && sameAdmission(currentFire.admission, admission)) {
          return {
            fire: currentFire,
            trigger: currentTrigger,
            effects: [] as readonly Trigger.SchedulerEffect[],
            changed: false,
          };
        }
        throw storeError(
          "admission_conflict",
          `Trigger Fire admission conflicts: ${currentFire.id}`,
          {
            triggerId: currentFire.triggerId,
            fireId: currentFire.id,
          },
        );
      }
      if (
        admission.fireId !== currentFire.id ||
        admission.sessionId !== currentFire.ownerSessionId ||
        admission.payloadDigest !== currentFire.payloadDigest
      ) {
        throw storeError(
          "admission_conflict",
          `Trigger Fire admission conflicts: ${currentFire.id}`,
          {
            triggerId: currentFire.triggerId,
            fireId: currentFire.id,
          },
        );
      }
      if (currentFire.status !== "delivered") {
        throw storeError(
          "invalid_transition",
          `Trigger Fire ${currentFire.id} must be delivered before acknowledgement`,
          { triggerId: currentFire.triggerId, fireId: currentFire.id },
        );
      }
      if (currentFire.revision !== request.expectedFireRevision) {
        throw revisionConflict("Trigger Fire", currentFire.id, request.expectedFireRevision);
      }
      if (currentTrigger.revision !== request.expectedTriggerRevision) {
        throw revisionConflict("Trigger", currentTrigger.id, request.expectedTriggerRevision);
      }
      if (currentTrigger.inFlightFireId !== currentFire.id) {
        throw storeError(
          "invalid_transition",
          `Trigger ${currentTrigger.id} is not gated by Fire ${currentFire.id}`,
          { triggerId: currentTrigger.id, fireId: currentFire.id },
        );
      }
      if (currentTrigger.pendingBatch === undefined && request.nextReservation !== undefined) {
        throw storeError(
          "invalid_transition",
          `Trigger ${currentTrigger.id} has no pending batch to reserve`,
          { triggerId: currentTrigger.id, fireId: currentFire.id },
        );
      }
      if (
        currentTrigger.pendingBatch !== undefined &&
        (request.nextReservation === undefined ||
          request.nextReservation.pendingFingerprint !== currentTrigger.pendingBatch.fingerprint)
      ) {
        throw revisionConflict("Trigger", currentTrigger.id, request.expectedTriggerRevision);
      }

      const scheduler = Trigger.Scheduler.step(currentTrigger, {
        type: "delivery_acknowledged",
        fireId: currentFire.id,
        at: request.at,
        admission,
        ...(request.nextReservation === undefined
          ? {}
          : { nextReservation: request.nextReservation }),
      });
      const acked = Trigger.Fire.parse({
        ...currentFire,
        status: "acked",
        admission,
        ackedAt: request.at,
        revision: currentFire.revision + 1,
        updatedAt: request.at,
      });
      appendFireUpdate(fireAdapter, ledger, currentFire, acked, "trigger.fire.acked", {
        status: acked.status,
        sessionId: admission.sessionId,
        messageId: admission.messageId,
        payloadDigest: admission.payloadDigest,
        ackedAt: acked.ackedAt,
      });

      const hasPending = currentTrigger.pendingBatch !== undefined;
      const releaseRecord = hasPending
        ? Trigger.Record.parse({
            ...currentTrigger,
            inFlightFireId: undefined,
            coalescedFirePending: false,
            pendingBatch: undefined,
            lastObservedAt: scheduler.record.lastObservedAt,
            updatedAt: scheduler.record.updatedAt,
            revision: currentTrigger.revision + 1,
          })
        : scheduler.record;
      appendParentFact(triggerAdapter, ledger, currentTrigger.id, currentTrigger.revision, {
        type: "trigger.fire.released",
        data: { fireId: currentFire.id, revision: releaseRecord.revision },
        record: releaseRecord,
      });

      let nextFire: Trigger.Fire | undefined;
      if (hasPending) {
        const nextReservation = request.nextReservation;
        if (!nextReservation) throw new Error("pending acknowledgement lost its reservation");
        if (scheduler.record.revision !== currentTrigger.revision + 2) {
          throw storeError(
            "corrupt",
            `Trigger ${currentTrigger.id} pending drain has an invalid revision delta`,
            { triggerId: currentTrigger.id },
          );
        }
        nextFire = buildFire(scheduler.record, nextReservation.reservation);
        appendParentFact(triggerAdapter, ledger, currentTrigger.id, releaseRecord.revision, {
          type: "trigger.fire.reserved",
          data: {
            fireId: nextFire.id,
            cause: nextFire.cause,
            payloadDigest: nextFire.payloadDigest,
            revision: scheduler.record.revision,
          },
          record: scheduler.record,
        });
        appendFireCreate(fireAdapter, ledger, nextFire);
      } else if (scheduler.record.revision !== currentTrigger.revision + 1) {
        throw storeError(
          "corrupt",
          `Trigger ${currentTrigger.id} release has an invalid revision delta`,
          { triggerId: currentTrigger.id },
        );
      }
      return {
        fire: acked,
        trigger: scheduler.record,
        ...(nextFire ? { nextFire } : {}),
        effects: scheduler.effects,
        changed: true,
      };
    });

    if (committed.changed) {
      Bus.publish(Trigger.Events.FireAcked, {
        traceId: request.traceId,
        time: committed.fire.ackedAt ?? committed.fire.updatedAt,
        triggerId: committed.fire.triggerId,
        fireId: committed.fire.id,
        fireRevision: committed.fire.revision,
        sessionId: admission.sessionId,
        messageId: admission.messageId,
      });
      if (committed.nextFire) {
        publishFireRecorded(committed.nextFire, committed.trigger.revision, request.traceId);
      }
    }
    return {
      fire: committed.fire,
      trigger: committed.trigger,
      ...(committed.nextFire ? { nextFire: committed.nextFire } : {}),
    };
  }
}
