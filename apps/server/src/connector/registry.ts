import { AppConnector, Policy } from "@openomni/protocol";
import { AppConnectorInstallationStore, Bus } from "@openomni/session";
import { z } from "zod";
import { ServerConnectorDiscovery } from "./discovery.js";
import type { DetectCommandRunner, DiscoveryCandidate } from "./discovery.js";

const MAX_VERIFICATION_DIAGNOSTIC_LENGTH = 512;
const sensitiveDiagnosticPattern =
  /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=([^\s]+)/gi;

export interface ServerConnectorRegistrationOptions {
  readonly registeredBy: string;
}

export const ServerConnectorConsentOptions = z
  .object({
    grantedBy: z.string().min(1),
    credentials: z.array(z.string().min(1)).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    permissions: z.array(Policy.Permission).optional(),
  })
  .strict();
export type ServerConnectorConsentOptions = z.infer<typeof ServerConnectorConsentOptions>;

export interface ServerConnectorSmokeVerifyOptions {
  readonly detectTimeoutMs?: number;
  readonly runDetectCommand?: DetectCommandRunner;
}

export namespace ServerConnectorRegistry {
  export function register(
    candidate: DiscoveryCandidate,
    options: ServerConnectorRegistrationOptions,
  ): AppConnector.Installation {
    if (candidate.status !== "available") {
      throw new Error(`Cannot register unavailable connector ${candidate.id}`);
    }

    return AppConnectorInstallationStore.set({
      id: installationId(candidate.id),
      connectorId: candidate.connector.id,
      connectorVersion: candidate.connector.version,
      endpointId: endpointId(candidate.id),
      definition: candidate.connector,
      ...(candidate.version !== undefined ? { detectedVersion: candidate.version } : {}),
      testedVersions: candidate.testedVersions,
      status: "registered",
      registeredBy: options.registeredBy,
    });
  }

  export function get(id: string): AppConnector.Installation | undefined {
    return AppConnectorInstallationStore.get(id);
  }

  export function list(): AppConnector.Installation[] {
    return AppConnectorInstallationStore.list();
  }

  export function disable(id: string): AppConnector.Installation {
    return AppConnectorInstallationStore.disable(id);
  }

  export function uninstall(id: string): boolean {
    return AppConnectorInstallationStore.uninstall(id);
  }

  export function requestConsent(id: string): AppConnector.Installation {
    return AppConnectorInstallationStore.requestConsent(id);
  }

  export function grantConsent(
    id: string,
    options: ServerConnectorConsentOptions,
  ): AppConnector.Installation {
    return AppConnectorInstallationStore.grantConsent(
      id,
      ServerConnectorConsentOptions.parse(options),
    );
  }

  export async function smokeVerify(
    id: string,
    options: ServerConnectorSmokeVerifyOptions = {},
  ): Promise<AppConnector.Installation> {
    const installation = AppConnectorInstallationStore.get(id);
    if (installation === undefined) {
      throw new Error(`AppConnector installation not found: ${id}`);
    }
    if (installation.status !== "consented") {
      throw new Error(`Cannot smoke verify ${installation.status} installation: ${id}`);
    }

    const candidates = await ServerConnectorDiscovery.discover({
      connectors: [installation.definition],
      detectTimeoutMs: options.detectTimeoutMs,
      runDetectCommand: options.runDetectCommand,
    });
    const candidate = candidates[0];
    if (candidate === undefined) {
      return markSmokeVerificationFailed(installation, "detect_failed", {
        diagnostic: "discovery returned no candidate",
      });
    }
    if (candidate.status !== "available" || candidate.version === undefined) {
      return markSmokeVerificationFailed(installation, verificationFailureReason(candidate), {
        ...(candidate.version !== undefined ? { detectedVersion: candidate.version } : {}),
        ...(candidate.diagnostic !== undefined ? { diagnostic: candidate.diagnostic } : {}),
      });
    }

    return AppConnectorInstallationStore.markSmokeVerified(id, {
      detectedVersion: candidate.version,
    });
  }
}

function installationId(connectorId: string): string {
  return `install:${connectorId}`;
}

function endpointId(connectorId: string): string {
  return `endpoint:${installationId(connectorId)}`;
}

function verificationFailureReason(
  candidate: DiscoveryCandidate,
): AppConnector.VerificationFailureReason {
  if (candidate.status === "missing") return "missing_candidate";
  return candidate.status === "available" ? "detect_failed" : candidate.status;
}

function markSmokeVerificationFailed(
  installation: AppConnector.Installation,
  reason: AppConnector.VerificationFailureReason,
  details: { readonly detectedVersion?: string; readonly diagnostic?: string } = {},
): AppConnector.Installation {
  const failed = AppConnectorInstallationStore.markSmokeVerificationFailed(installation.id, {
    ...(details.detectedVersion !== undefined ? { detectedVersion: details.detectedVersion } : {}),
  });
  Bus.publish(AppConnector.Events.VerificationFailed, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    installationId: installation.id,
    connectorId: installation.connectorId,
    connectorVersion: installation.connectorVersion,
    reason,
    testedVersions: installation.testedVersions,
    ...(details.detectedVersion !== undefined ? { detectedVersion: details.detectedVersion } : {}),
    ...(details.diagnostic !== undefined
      ? { diagnostic: sanitizeVerificationDiagnostic(details.diagnostic) }
      : {}),
  });
  return failed;
}

function sanitizeVerificationDiagnostic(diagnostic: string): string {
  const sanitized = diagnostic
    .replace(sensitiveDiagnosticPattern, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length === 0) return "detect command failed";
  if (sanitized.length <= MAX_VERIFICATION_DIAGNOSTIC_LENGTH) return sanitized;
  return sanitized.slice(0, MAX_VERIFICATION_DIAGNOSTIC_LENGTH - 1).trimEnd();
}
