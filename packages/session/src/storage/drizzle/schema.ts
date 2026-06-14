import {
  actorEndpointTable,
  actorIdentityTable,
  blacklistTable,
  channelGrantTable,
} from "./actor-authority-tables";
import { appConnectorInstallationTable } from "./app-connector-tables";
import { messageTable, partTable, sessionTable, surfaceKeyTable } from "./core-tables";
import { artifactTable, busEventTable } from "./event-artifact-tables";
import { cronJobTable, workItemTable } from "./work-scheduling-tables";
import {
  pendingAskTable,
  pendingInteractionTable,
  workerGrantTable,
  workerRunStateTable,
} from "./worker-communication-tables";

export const drizzleSchema = {
  actorEndpointTable,
  actorIdentityTable,
  appConnectorInstallationTable,
  artifactTable,
  blacklistTable,
  busEventTable,
  channelGrantTable,
  cronJobTable,
  messageTable,
  partTable,
  pendingAskTable,
  pendingInteractionTable,
  sessionTable,
  surfaceKeyTable,
  workerGrantTable,
  workerRunStateTable,
  workItemTable,
} as const;
