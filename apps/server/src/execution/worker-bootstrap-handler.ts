import { createHmac, timingSafeEqual } from "node:crypto";
import { Ipc } from "@openomni/protocol";

type BootstrapParams = ReturnType<(typeof Ipc.Methods)["coordinator.bootstrap"]["params"]["parse"]>;

export namespace WorkerBootstrapHandler {
  interface ServerPort {
    useConnection(id: string): void;
    notify(method: string, params?: Record<string, unknown>): void;
    closeConnection(id: string): void;
  }

  export interface State {
    readonly ready: Promise<void>;
    getBootstrap(): BootstrapParams | null;
  }

  interface CreateStateOptions {
    readonly onBootstrap?: (bootstrap: BootstrapParams) => void;
  }

  interface HandleOptions {
    readonly params: Record<string, unknown> | undefined;
    readonly ipcAuthToken: string;
    readonly workerId: string;
    readonly server: ServerPort;
    readonly connectionId: string;
    readonly respond: (result: unknown) => void;
    readonly state: MutableState;
  }

  interface MutableState extends State {
    setBootstrap(bootstrap: BootstrapParams): void;
    markReady(): void;
    rejectReady(error: Error): void;
  }

  function bootstrapProof(
    authToken: string,
    challenge: string,
    phase: "request" | "ready",
    bootstrap: Pick<BootstrapParams, "runtimeId" | "workerId" | "generation">,
  ): string {
    return createHmac("sha256", authToken)
      .update("openomni.worker-bootstrap-proof.v1\0")
      .update(phase)
      .update("\0")
      .update(challenge)
      .update("\0")
      .update(bootstrap.runtimeId)
      .update("\0")
      .update(bootstrap.workerId)
      .update("\0")
      .update(String(bootstrap.generation))
      .digest("base64url");
  }

  function matchesProof(value: string, expected: string): boolean {
    const actualBytes = Buffer.from(value);
    const expectedBytes = Buffer.from(expected);
    return (
      actualBytes.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(actualBytes, expectedBytes)
    );
  }

  function rejectBootstrap(options: HandleOptions, error: string): void {
    options.respond({ ok: false, error });
    queueMicrotask(() => options.server.closeConnection(options.connectionId));
  }

  function parseBootstrapCredential(
    value: string,
  ): { challenge: string; proof: string } | undefined {
    const separator = value.indexOf(".");
    if (
      separator <= 0 ||
      separator === value.length - 1 ||
      value.indexOf(".", separator + 1) >= 0
    ) {
      return undefined;
    }
    return { challenge: value.slice(0, separator), proof: value.slice(separator + 1) };
  }

  export function createState(options: CreateStateOptions = {}): MutableState {
    let bootstrap: BootstrapParams | null = null;
    let resolveReady: () => void = () => undefined;
    let rejectReady: (_error: Error) => void = () => undefined;

    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    return {
      ready,
      getBootstrap: () => bootstrap,
      setBootstrap(nextBootstrap) {
        bootstrap = nextBootstrap;
        options.onBootstrap?.(nextBootstrap);
      },
      markReady() {
        resolveReady();
      },
      rejectReady,
    } satisfies MutableState;
  }

  export function handleBootstrap(options: HandleOptions): void {
    let bootstrap: BootstrapParams;
    try {
      bootstrap = Ipc.Methods["coordinator.bootstrap"].params.parse(options.params);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      options.state.rejectReady(failure);
      rejectBootstrap(options, failure.message);
      return;
    }
    const credential = parseBootstrapCredential(bootstrap.authToken);
    const alreadyBootstrapped = options.state.getBootstrap() !== null;
    if (
      credential === undefined ||
      bootstrap.workerId !== options.workerId ||
      alreadyBootstrapped ||
      !matchesProof(
        credential.proof,
        bootstrapProof(options.ipcAuthToken, credential.challenge, "request", bootstrap),
      )
    ) {
      rejectBootstrap(options, "unauthorized coordinator bootstrap");
      return;
    }
    try {
      options.server.useConnection(options.connectionId);
      options.state.setBootstrap(bootstrap);
      options.server.notify("worker.bootstrap_ready", {
        authToken: bootstrapProof(options.ipcAuthToken, credential.challenge, "ready", bootstrap),
        runtimeId: bootstrap.runtimeId,
        workerId: bootstrap.workerId,
        generation: bootstrap.generation,
      });
      options.state.markReady();
      options.respond({ ok: true });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      options.state.rejectReady(failure);
      options.respond({ ok: false, error: failure.message });
      queueMicrotask(() => options.server.closeConnection(options.connectionId));
    }
  }
}
