import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { nonEmptyString, positiveInteger } from "./definition.js";
import { VerificationFailureReason } from "./installation.js";

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
  { visibility: "llm_reason" },
);

export const Events = {
  VerificationFailed,
} as const;
