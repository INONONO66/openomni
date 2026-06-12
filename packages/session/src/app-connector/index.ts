import { AppConnector } from "@openomni/protocol";
import { Storage } from "../storage/storage";

type InstallationInput = Omit<AppConnector.Installation, "createdAt" | "updatedAt"> &
  Partial<Pick<AppConnector.Installation, "createdAt">>;

function requireAdapter(): NonNullable<Storage.Adapter["appConnectorInstallation"]> {
  const adapter = Storage.get().appConnectorInstallation;
  if (!adapter) {
    throw new Error("Storage adapter does not implement app connector installations");
  }
  return adapter;
}

function withTimestamps(
  installation: InstallationInput,
  existing?: AppConnector.Installation,
): AppConnector.Installation {
  const now = Date.now();
  return AppConnector.Installation.parse({
    ...installation,
    createdAt: existing?.createdAt ?? installation.createdAt ?? now,
    updatedAt: now,
  });
}

export namespace AppConnectorInstallationStore {
  export function set(input: InstallationInput): AppConnector.Installation {
    const adapter = requireAdapter();
    const installation = withTimestamps(input, adapter.get(input.id));
    adapter.set(installation);
    return installation;
  }

  export function get(id: string): AppConnector.Installation | undefined {
    return requireAdapter().get(id);
  }

  export function list(): AppConnector.Installation[] {
    return requireAdapter().list();
  }

  export function remove(id: string): boolean {
    return requireAdapter().remove(id);
  }
}
