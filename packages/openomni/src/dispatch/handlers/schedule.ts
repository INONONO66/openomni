import { CronJob, type Dispatch } from "@openomni/protocol";
import type { DispatchSchedulerOwner } from "../owners.js";
import type { DispatchHandler } from "../registry.js";
import { extractText } from "../../ingress/handlers.js";
import { asRecord } from "./shared.js";

export interface ScheduleDispatchHandlerOptions {
  readonly scheduler?: DispatchSchedulerOwner;
}

function requireScheduler(scheduler: DispatchSchedulerOwner | undefined): DispatchSchedulerOwner {
  if (!scheduler) throw new Error("dispatch schedule handler requires scheduler owner");
  return scheduler;
}

function scheduleFromPayload(command: Dispatch.Command): string | undefined {
  const payload = asRecord(command.payload);
  return typeof payload?.schedule === "string" ? payload.schedule : undefined;
}

function payloadText(command: Dispatch.Command): string {
  const payload = asRecord(command.payload);
  if (payload && "payload" in payload) return extractText(payload.payload);
  return extractText(command.payload);
}

function scheduleTarget(command: Dispatch.Command): CronJob.Target {
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
    "schedule.create"(command) {
      const scheduler = requireScheduler(options.scheduler);
      const schedule = scheduleFromPayload(command);
      if (!schedule) throw new Error("schedule.create requires payload.schedule");
      const payload = asRecord(command.payload);
      const agentName =
        (typeof payload?.agentName === "string" ? payload.agentName : undefined) ??
        command.target.name ??
        command.actor.agentName;
      if (!agentName) throw new Error("schedule.create requires target.name or payload.agentName");

      const job = CronJob.Info.parse({
        id: crypto.randomUUID(),
        agentName,
        payload: payloadText(command),
        schedule,
        target: scheduleTarget(command),
        createdAt: Date.now(),
      });
      const jobId = scheduler.register(job);
      return { output: { scheduled: true, jobId, messageId: jobId } };
    },

    "schedule.cancel"(command) {
      const scheduler = requireScheduler(options.scheduler);
      const jobId = command.target.id ?? command.target.name;
      if (!jobId) throw new Error("schedule.cancel requires target.id");
      return { output: { cancelled: scheduler.remove(jobId), jobId } };
    },
  };
}
