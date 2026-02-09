import { Task, TriggerSignal } from "../task/types";
import { TaskManager } from "../task/manager";
import { IngressEngine } from "../ingress/engine";
import type { InboundEvent } from "../ingress/interfaces";
import { randomUUID } from "crypto";

interface ScheduledTrigger {
  taskId: string;
  trigger: Task.TriggerCron | Task.TriggerInterval | Task.TriggerOnce;
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
  nextFireTime: number;
}

type SchedulerKey = `${string}:${string}`;

/**
 * Simple cron parser supporting standard 5-field expressions.
 * Format: minute hour dayOfMonth month dayOfWeek
 * Supports: numbers, *, step values (n), ranges (n-m), lists (n,m,o)
 */
export namespace CronParser {
  export interface CronFields {
    minute: number[];
    hour: number[];
    dayOfMonth: number[];
    month: number[];
    dayOfWeek: number[];
  }

  function parseField(field: string, min: number, max: number): number[] {
    const result: number[] = [];
    const parts = field.split(",");

    for (const part of parts) {
      const stepMatch = part.match(/^(.+)\/(\d+)$/);
      let range: string;
      let step = 1;

      if (stepMatch) {
        range = stepMatch[1]!;
        step = parseInt(stepMatch[2]!, 10);
      } else {
        range = part;
      }

      if (range === "*") {
        for (let i = min; i <= max; i += step) {
          result.push(i);
        }
        continue;
      }

      const rangeMatch = range.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1]!, 10);
        const end = parseInt(rangeMatch[2]!, 10);
        for (let i = start; i <= end && i <= max; i += step) {
          if (i >= min) result.push(i);
        }
        continue;
      }

      const num = parseInt(range, 10);
      if (!isNaN(num) && num >= min && num <= max) {
        result.push(num);
      }
    }

    return [...new Set(result)].sort((a, b) => a - b);
  }

  export function parse(expr: string): CronFields | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
      return null;
    }

    const minute = parseField(parts[0]!, 0, 59);
    const hour = parseField(parts[1]!, 0, 23);
    const dayOfMonth = parseField(parts[2]!, 1, 31);
    const month = parseField(parts[3]!, 1, 12);
    const dayOfWeek = parseField(parts[4]!, 0, 6);

    if (
      minute.length === 0 ||
      hour.length === 0 ||
      dayOfMonth.length === 0 ||
      month.length === 0 ||
      dayOfWeek.length === 0
    ) {
      return null;
    }

    return { minute, hour, dayOfMonth, month, dayOfWeek };
  }

  export function getNextFireTime(fields: CronFields, after: Date): Date {
    const result = new Date(after.getTime());
    result.setSeconds(0, 0);
    result.setMinutes(result.getMinutes() + 1);

    const maxIterations = 366 * 24 * 60;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      if (!fields.month.includes(result.getMonth() + 1)) {
        const currentMonth = result.getMonth() + 1;
        const nextMonth = fields.month.find((m) => m > currentMonth);
        if (nextMonth) {
          result.setMonth(nextMonth - 1, 1);
          result.setHours(0, 0, 0, 0);
        } else {
          result.setFullYear(result.getFullYear() + 1);
          result.setMonth(fields.month[0]! - 1, 1);
          result.setHours(0, 0, 0, 0);
        }
        continue;
      }

      if (!fields.dayOfMonth.includes(result.getDate())) {
        const currentDay = result.getDate();
        const nextDay = fields.dayOfMonth.find((d) => d > currentDay);
        if (nextDay && nextDay <= getDaysInMonth(result)) {
          result.setDate(nextDay);
          result.setHours(0, 0, 0, 0);
        } else {
          result.setMonth(result.getMonth() + 1, 1);
          result.setHours(0, 0, 0, 0);
        }
        continue;
      }

      if (!fields.dayOfWeek.includes(result.getDay())) {
        result.setDate(result.getDate() + 1);
        result.setHours(0, 0, 0, 0);
        continue;
      }

      if (!fields.hour.includes(result.getHours())) {
        const currentHour = result.getHours();
        const nextHour = fields.hour.find((h) => h > currentHour);
        if (nextHour !== undefined) {
          result.setHours(nextHour, 0, 0, 0);
        } else {
          result.setDate(result.getDate() + 1);
          result.setHours(0, 0, 0, 0);
        }
        continue;
      }

      if (!fields.minute.includes(result.getMinutes())) {
        const currentMinute = result.getMinutes();
        const nextMinute = fields.minute.find((m) => m > currentMinute);
        if (nextMinute !== undefined) {
          result.setMinutes(nextMinute, 0, 0);
        } else {
          result.setHours(result.getHours() + 1, 0, 0, 0);
        }
        continue;
      }

      return result;
    }

    return new Date(after.getTime() + 365 * 24 * 60 * 60 * 1000);
  }

  function getDaysInMonth(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  }
}

export namespace Scheduler {
  const registry = new Map<SchedulerKey, ScheduledTrigger>();
  const cronFieldsCache = new Map<string, CronParser.CronFields>();

  function makeKey(taskId: string, triggerId: string): SchedulerKey {
    return `${taskId}:${triggerId}`;
  }

  function createSignal(
    trigger: Task.TriggerCron | Task.TriggerInterval | Task.TriggerOnce,
    occurredAt: number,
  ): TriggerSignal {
    return {
      triggerId: trigger.id,
      type: trigger.type,
      occurredAt,
      context: {
        traceId: randomUUID(),
      },
    };
  }

  async function fire(
    taskId: string,
    trigger: Task.TriggerCron | Task.TriggerInterval | Task.TriggerOnce,
  ): Promise<void> {
    const now = Date.now();

    const inboundEvent: InboundEvent = {
      id: randomUUID(),
      surface: "scheduler",
      name: `scheduler.${trigger.type}`,
      payload: { taskId, triggerId: trigger.id },
      dedupeKey: `scheduler:${taskId}:${trigger.id}:${now}`,
      occurredAt: new Date(now).toISOString(),
      meta: {
        taskId,
        triggerId: trigger.id,
        triggerType: trigger.type,
      },
    };

    try {
      await IngressEngine.ingest(inboundEvent);
    } catch (error) {
      console.error(
        `[Scheduler] Error firing trigger ${trigger.id} for task ${taskId}:`,
        error,
      );
    }
  }

  export function register(task: Task.Info): void {
    for (const trigger of task.triggers) {
      if (
        trigger.type === "cron" ||
        trigger.type === "interval" ||
        trigger.type === "once"
      ) {
        registerTrigger(task.id, trigger);
      }
    }
  }

  export function registerTrigger(
    taskId: string,
    trigger: Task.TriggerCron | Task.TriggerInterval | Task.TriggerOnce,
  ): boolean {
    const key = makeKey(taskId, trigger.id);

    if (registry.has(key)) {
      return false;
    }

    const now = Date.now();

    switch (trigger.type) {
      case "interval": {
        const timer = setInterval(() => {
          fire(taskId, trigger);
        }, trigger.ms);
        timer.unref();

        fire(taskId, trigger);

        registry.set(key, {
          taskId,
          trigger,
          timer,
          nextFireTime: now + trigger.ms,
        });
        return true;
      }

      case "once": {
        const delay = trigger.at - now;
        if (delay <= 0) {
          fire(taskId, trigger);
          return true;
        }

        const timer = setTimeout(() => {
          fire(taskId, trigger);
          registry.delete(key);
        }, delay);
        timer.unref();

        registry.set(key, {
          taskId,
          trigger,
          timer,
          nextFireTime: trigger.at,
        });
        return true;
      }

      case "cron": {
        let fields = cronFieldsCache.get(trigger.expr);
        if (!fields) {
          const parsed = CronParser.parse(trigger.expr);
          if (!parsed) {
            console.error(
              `[Scheduler] Invalid cron expression: ${trigger.expr}`,
            );
            return false;
          }
          fields = parsed;
          cronFieldsCache.set(trigger.expr, fields);
        }

        const nextFire = CronParser.getNextFireTime(fields, new Date(now));
        const delay = nextFire.getTime() - now;

        const scheduleNext = () => {
          const currentFields = cronFieldsCache.get(trigger.expr);
          if (!currentFields) return;

          const nextTime = CronParser.getNextFireTime(
            currentFields,
            new Date(),
          );
          const nextDelay = nextTime.getTime() - Date.now();

          const entry = registry.get(key);
          if (!entry) return;

          const newTimer = setTimeout(() => {
            fire(taskId, trigger);
            scheduleNext();
          }, nextDelay);
          newTimer.unref();

          entry.timer = newTimer;
          entry.nextFireTime = nextTime.getTime();
        };

        const timer = setTimeout(() => {
          fire(taskId, trigger);
          scheduleNext();
        }, delay);
        timer.unref();

        registry.set(key, {
          taskId,
          trigger,
          timer,
          nextFireTime: nextFire.getTime(),
        });
        return true;
      }
    }
  }

  export function unregister(taskId: string): void {
    for (const [key, entry] of registry.entries()) {
      if (entry.taskId === taskId) {
        clearTimeout(entry.timer);
        clearInterval(entry.timer);
        registry.delete(key);
      }
    }
  }

  export function unregisterTrigger(
    taskId: string,
    triggerId: string,
  ): boolean {
    const key = makeKey(taskId, triggerId);
    const entry = registry.get(key);

    if (!entry) {
      return false;
    }

    clearTimeout(entry.timer);
    clearInterval(entry.timer);
    registry.delete(key);
    return true;
  }

  export function getNextFireTime(
    taskId: string,
    triggerId: string,
  ): number | undefined {
    const key = makeKey(taskId, triggerId);
    return registry.get(key)?.nextFireTime;
  }

  export function isRegistered(taskId: string, triggerId: string): boolean {
    return registry.has(makeKey(taskId, triggerId));
  }

  export function getRegisteredTriggers(taskId: string): string[] {
    const result: string[] = [];
    for (const [, entry] of registry.entries()) {
      if (entry.taskId === taskId) {
        result.push(entry.trigger.id);
      }
    }
    return result;
  }

  export function clear(): void {
    for (const entry of registry.values()) {
      clearTimeout(entry.timer);
      clearInterval(entry.timer);
    }
    registry.clear();
    cronFieldsCache.clear();
  }

  export function size(): number {
    return registry.size;
  }
}
