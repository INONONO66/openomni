import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { VerificationFailureReason } from "./installation.js";
import { nonEmptyString, positiveInteger } from "./schema-primitives.js";

const VerificationEventBase = z.object({
  traceId: nonEmptyString,
  time: positiveInteger,
  installationId: nonEmptyString,
  connectorId: nonEmptyString,
  connectorVersion: nonEmptyString,
  reason: VerificationFailureReason,
  testedVersions: nonEmptyString,
  detectedVersion: nonEmptyString.optional(),
  diagnostic: nonEmptyString.max(512).optional(),
});

const VerificationFailed = BusEvent.define(
  "app_connector.verification.failed",
  VerificationEventBase,
);

export const Events = {
  VerificationFailed,
} as const;
