import {
  createConnectorEndpointProcessDriver,
  type ConnectorEndpointCredentialMap,
  type ConnectorQuestionBridgeHandler,
} from "./process-driver.js";

export { ServerConnectorDefinitions } from "./definitions.js";
export { ServerConnectorDiscovery } from "./discovery.js";
export { ServerConnectorRegistry } from "./registry.js";
export type { ConnectorQuestionBridgeHandler };

export interface ConnectorEndpointDriverOptions {
  readonly credentials?: ConnectorEndpointCredentialMap;
  readonly questionBridge?: ConnectorQuestionBridgeHandler;
}

export function createConnectorEndpointDriver(options: ConnectorEndpointDriverOptions = {}) {
  return createConnectorEndpointProcessDriver({
    credentials: options.credentials ?? {},
    questionBridge: options.questionBridge,
  });
}
