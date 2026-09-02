import { defineTool } from "../core/define";
import {
  EMPTY_INPUT,
  executeProvisionStatus,
  ProvisionStatusOutput,
  renderProvisionStatus,
} from "../mutation/provision";

export const provisionStatusTool = defineTool({
  name: "provision_status",
  category: "query",
  description: "Read-only: where channel truth comes from (declared store vs env), per-instance mount state including vault_locked and paused_by_breaker, and vault lock state.",
  input: EMPTY_INPUT,
  output: ProvisionStatusOutput,
  safe: true,
  execution: { kind: "host" },
  placement: "host",
  visibility: { model: ["resident"], cell: ["resident"] },
  bind: (ports) => ports.provisioning === undefined ? undefined : executeProvisionStatus(ports.provisioning),
  render: (_args, value) => renderProvisionStatus(value),
});
