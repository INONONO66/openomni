import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/renderer/app";
import { StateProvider } from "../src/renderer/state/provider";
import { queryKeys } from "../src/renderer/state/queries";

/** Install `replacements` as browser globals; the returned function restores the originals. */
export function installGlobals(replacements: Record<string, object | boolean>): () => void {
  const descriptors = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

/** The shell's static markup with the endpoint query already answered, or still in flight. */
export function renderShell(endpoint: "pending" | null = null): string {
  const client = new QueryClient();
  if (endpoint !== "pending") client.setQueryData(queryKeys.gatewayEndpoint, endpoint);
  return renderToStaticMarkup(
    <StateProvider client={client}>
      <App platform="darwin" storage={null} />
    </StateProvider>,
  );
}

/** The element carrying a `data-ui` name, as its opening tag. */
export function tag(html: string, name: string): string {
  const escaped = name.replace(".", "\\.");
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-ui="${escaped}"[^>]*>`));
  if (match === null) throw new Error(`no element named ${name}`);
  return match[0];
}
