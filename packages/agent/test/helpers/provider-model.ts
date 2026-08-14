import type { Provider } from "@openomni/llm";

/**
 * The smallest thing that is actually a `Provider.Model`.
 *
 * Tests used to pass `{ provider, id }` here — the protocol's model *reference*
 * shape, not the resolved model. It left `providerID` and `name` unset while
 * carrying a key nothing reads, and with the test tree outside `tsconfig`
 * nothing said so.
 */
export const testProviderModel: Provider.Model = Object.freeze({
  id: "test-model",
  name: "test-model",
  providerID: "test",
});
