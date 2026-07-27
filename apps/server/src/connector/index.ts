import {
  createConnectorEndpointProcessDriver,
  type ConnectorEndpointProcessDriverOptions,
  type ConnectorQuestionBridgeHandler,
} from "./process-driver.js";

export type { ConnectorQuestionBridgeHandler };

export type ConnectorEndpointDriverOptions = ConnectorEndpointProcessDriverOptions;

export function createConnectorEndpointDriver(options: ConnectorEndpointDriverOptions) {
  return createConnectorEndpointProcessDriver(options);
}
