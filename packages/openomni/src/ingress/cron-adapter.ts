import type { Ingress } from "@openomni/protocol";
import type { ScheduleFire } from "../execution-runtime/schedule-service.js";

export interface CronIngressPort {
  ingestInternal(event: Ingress.InboundEvent): Promise<Ingress.IngressResult>;
}

export namespace CronAdapter {
  export interface CronJob {
    id: string;
    agentName: string;
    payload: string;
    workspace?: string;
    target?: Ingress.Target;
  }

  export interface Options {
    readonly ingress: CronIngressPort;
    readonly nowMs?: () => number;
  }

  export function create(options: Options): {
    fire(job: CronJob, fire: ScheduleFire): Promise<Ingress.IngressResult>;
  } {
    return Object.freeze({
      fire(job: CronJob, fire: ScheduleFire): Promise<Ingress.IngressResult> {
        const firedAt = options.nowMs?.() ?? Date.now();
        return options.ingress.ingestInternal({
          id: crypto.randomUUID(),
          surface: "cron",
          mode: "internal",
          agentName: job.agentName,
          workspace: job.workspace,
          payload: job.payload,
          target: job.target ?? { kind: "resident" },
          meta: { actor: { role: "system", id: `cron:${job.id}` } },
          runtime: {
            trigger: {
              kind: "cron",
              id: job.id,
              scheduledAt: fire.schedule.nextFireAtDbMs ?? undefined,
              firedAt,
            },
          },
        });
      },
    });
  }
}
