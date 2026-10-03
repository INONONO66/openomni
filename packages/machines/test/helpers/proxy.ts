import net from "node:net";
import { once } from "node:events";

/**
 * A severable socket pipe standing in for the network between daemon and
 * host (#1270 tests): `sever` drops every live pair while the listener stays
 * up, `stop` takes the endpoint away entirely.
 */
export async function startProxy(listen: string | { readonly port: number }, connect: () => net.Socket) {
  const pairs: Array<readonly [net.Socket, net.Socket]> = [];
  const server = net.createServer((inbound) => {
    const outbound = connect();
    pairs.push([inbound, outbound] as const);
    inbound.pipe(outbound);
    outbound.pipe(inbound);
    inbound.on("error", () => outbound.destroy());
    outbound.on("error", () => inbound.destroy());
  });
  if (typeof listen === "string") server.listen(listen);
  else server.listen(listen.port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    sever() {
      for (const [inbound, outbound] of pairs.splice(0)) {
        inbound.destroy();
        outbound.destroy();
      }
    },
    async stop() {
      this.sever();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
