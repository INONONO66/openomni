import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type { ReactNode } from "react";

/**
 * One `QueryClient` per window, mounted once at the root.
 *
 * The devtools ride along in development only. `import.meta.env.DEV` is a
 * build-time constant, so the production bundle carries neither the panel nor
 * the import. In a dev window the panel is mounted closed behind its corner
 * toggle — developer chrome, present exactly where a developer is looking.
 */
const queryClient = new QueryClient();

export function StateProvider({
  children,
  client = queryClient,
}: {
  readonly children: ReactNode;
  /** A test's own client, so a query can be seeded before the first paint. */
  readonly client?: QueryClient;
}) {
  return (
    <QueryClientProvider client={client}>
      {children}
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
