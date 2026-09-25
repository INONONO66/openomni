import type { z } from "zod";
import type { ToolExecutionContext } from "@openomni/protocol";
import type { ProvisionInput } from "../tools/provision";
import { contactDomainRevisions } from "../tools/core/contact-mutations";
import {
  approvalRequirement,
  executePersonDeclare,
  executePersonRemove,
  mutateContact,
  refusal,
} from "./contacts";
import {
  executeChannelDeclare,
  executeChannelEnable,
  executeChannelDisable,
  executeSecretRotate,
  type ProvisionPort,
} from "./channels";
import { executeProvisionStatus } from "./status";
function provisionExecutors(port: ProvisionPort) {
  return {
    contact_add: executePersonDeclare(port),
    contact_remove: executePersonRemove(port),
    channel_add: executeChannelDeclare(port),
    channel_enable: executeChannelEnable(port),
    channel_disable: executeChannelDisable(port),
    secret_rotate: executeSecretRotate(port),
    status: executeProvisionStatus(port),
  };
}

export function executeProvision(port: ProvisionPort | undefined) {
  const composed = port === undefined ? undefined : provisionExecutors(port);
  const executors = () => composed ?? refusal("provision", "provisioning is not composed");
  return async ({ operation }: z.output<typeof ProvisionInput>, context: ToolExecutionContext) => {
    if (operation.op === "contact_promote" || operation.op === "contact_merge")
      return mutateContact(operation, context.domainRevisions);
    const run = executors();
    switch (operation.op) {
      case "contact_add":
        return {
          op: operation.op,
          result: await run.contact_add(operation.args, context.domainRevisions),
        };
      case "contact_remove":
        return { op: operation.op, ...(await run.contact_remove(operation.args)) };
      case "channel_add":
        return { op: operation.op, ...(await run.channel_add(operation.args)) };
      case "channel_enable":
        return {
          op: operation.op,
          ...(await run.channel_enable(operation.args)),
          action: "enabled" as const,
        };
      case "channel_disable":
        return {
          op: operation.op,
          ...(await run.channel_disable(operation.args)),
          action: "disabled" as const,
        };
      case "secret_rotate":
        return { op: operation.op, ...(await run.secret_rotate(operation.args)) };
      case "status":
        return { op: operation.op, ...(await run.status(operation.args)) };
    }
  };
}

export function provisionApproval(port: ProvisionPort | undefined) {
  return ({ operation }: z.output<typeof ProvisionInput>) => {
    if (operation.op === "contact_promote" || operation.op === "contact_merge")
      return { required: false, domainRevisions: contactDomainRevisions(operation) };
    if (operation.op !== "contact_add" || port === undefined)
      return { required: false, domainRevisions: {} };
    const manifest = {
      ...operation.args.manifest,
      displayName: operation.args.manifest.displayName ?? operation.args.manifest.id,
    };
    const existing = port.persons.get(manifest.id);
    return {
      required: approvalRequirement(existing, manifest) !== undefined,
      domainRevisions: { [manifest.id]: existing?.revision ?? -1 },
      timeoutMs: operation.args.timeoutMs,
    };
  };
}
