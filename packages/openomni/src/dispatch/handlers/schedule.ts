import type { Dispatch } from "@openomni/protocol";
import type { ScheduleTargetV1 } from "../../execution-runtime/schedule-service.js";
import type { DispatchSchedulerOwner } from "../owners.js";
import type { DispatchHandler } from "../registry.js";
import { asRecord } from "./shared.js";

export interface ScheduleDispatchHandlerOptions {
  readonly scheduler?: Pick<DispatchSchedulerOwner, "create" | "cancel">;
}

function requireScheduler(
  scheduler: Pick<DispatchSchedulerOwner, "create" | "cancel"> | undefined,
): Pick<DispatchSchedulerOwner, "create" | "cancel"> {
  if (!scheduler) throw new Error("dispatch schedule handler requires schedule service");
  return scheduler;
}

function scheduleFromPayload(command: Dispatch.Command): string | undefined {
  const payload = asRecord(command.payload);
  return typeof payload?.schedule === "string" ? payload.schedule : undefined;
}

function payloadRefFromPayload(command: Dispatch.Command): string | undefined {
  const payload = asRecord(command.payload);
  return typeof payload?.payloadRef === "string" && payload.payloadRef.length > 0
    ? payload.payloadRef
    : undefined;
}

function scheduleTarget(command: Dispatch.Command): ScheduleTargetV1 {
  if (command.target.kind === "worker") {
    return {
      kind: "worker",
      ...(command.target.sessionId ? { sessionId: command.target.sessionId } : {}),
    };
  }
  if (command.target.kind === "resident" || command.target.kind === "schedule") {
    return {
      kind: "resident",
      ...(command.target.sessionId ? { sessionId: command.target.sessionId } : {}),
    };
  }
  throw new Error(`schedule.create cannot target ${command.target.kind}`);
}

export function createScheduleDispatchHandlers(
  options: ScheduleDispatchHandlerOptions = {},
): Record<"schedule.create" | "schedule.cancel", DispatchHandler> {
  return {
    async "schedule.create"(command) {
      const scheduler = requireScheduler(options.scheduler);
      const schedule = scheduleFromPayload(command);
      if (!schedule) throw new Error("schedule.create requires payload.schedule");
      const payload = asRecord(command.payload);
      const agentName =
        (typeof payload?.agentName === "string" ? payload.agentName : undefined) ??
        command.target.name ??
        command.actor.agentName;
      if (!agentName) throw new Error("schedule.create requires target.name or payload.agentName");

      const payloadRef = payloadRefFromPayload(command);
      if (!payloadRef) throw new Error("schedule.create requires payload.payloadRef");
      const scheduleId = crypto.randomUUID();
      const jobId = await scheduler.create({
        scheduleId,
        agentName,
        target: scheduleTarget(command),
        expression: schedule,
        payloadRef,
      });
      return { output: { scheduled: true, jobId, messageId: jobId } };
    },

    async "schedule.cancel"(command) {
      const scheduler = requireScheduler(options.scheduler);
      const jobId = command.target.id ?? command.target.name;
      if (!jobId) throw new Error("schedule.cancel requires target.id");
      return { output: { cancelled: await scheduler.cancel(jobId), jobId } };
    },
  };
}
