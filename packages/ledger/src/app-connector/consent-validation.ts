import type { AppConnector } from "@openomni/protocol";

type ConsentInput = Omit<AppConnector.Consent, "grantedAt"> &
  Partial<Pick<AppConnector.Consent, "grantedAt">>;
type ConsentPermission = NonNullable<AppConnector.Consent["permissions"]>[number];
type RequiredPermission = NonNullable<AppConnector.Definition["requires"]["permissions"]>[number];
type ConsentInputRule = NonNullable<ConsentPermission["inputRules"]>[number];
type RequiredInputRule = NonNullable<RequiredPermission["inputRules"]>[number];

export function assertConsentMatchesRequirements(
  input: ConsentInput,
  definition: AppConnector.Definition,
): void {
  assertRequestedValues(input.credentials, definition.requires.credentials, "credentials");
  assertRequestedValues(input.capabilities, definition.requires.capabilities, "capabilities");
  assertRequestedPermissions(input.permissions, definition.requires.permissions);
}

function assertRequestedValues(
  granted: readonly string[] | undefined,
  requested: readonly string[] | undefined,
  field: "credentials" | "capabilities",
): void {
  if (granted === undefined) return;
  const requestedValues = new Set(requested ?? []);
  for (const value of granted) {
    if (!requestedValues.has(value)) {
      throw new Error(`AppConnector consent ${field} not requested by connector: ${value}`);
    }
  }
}

function assertRequestedPermissions(
  granted: ReadonlyArray<ConsentPermission> | undefined,
  requested: ReadonlyArray<RequiredPermission> | undefined,
): void {
  const requiredPermissions = requested ?? [];
  if (requiredPermissions.length > 0 && (granted === undefined || granted.length === 0)) {
    throw new Error("AppConnector consent permissions omit connector requirements");
  }
  if (granted === undefined) return;
  assertUniqueRequiredPermissionActions(requiredPermissions);
  const requestedByAction = new Map(
    requiredPermissions.map((permission) => [permission.action, permission] as const),
  );
  const grantedByAction = new Map(granted.map((permission) => [permission.action, permission]));
  for (const permission of requiredPermissions) {
    if (!grantedByAction.has(permission.action)) {
      throw new Error(
        `AppConnector consent permissions omits connector requirement: ${permission.action}`,
      );
    }
  }
  for (const permission of granted) {
    const requestedPermission = requestedByAction.get(permission.action);
    if (requestedPermission === undefined) {
      throw new Error(
        `AppConnector consent permissions not requested by connector: ${permission.action}`,
      );
    }
    assertPermissionSubset(permission, requestedPermission);
  }
}

function assertUniqueRequiredPermissionActions(
  permissions: ReadonlyArray<RequiredPermission>,
): void {
  const seen = new Set<string>();
  for (const permission of permissions) {
    if (seen.has(permission.action)) {
      throw new Error(
        `AppConnector consent permissions duplicate connector requirement: ${permission.action}`,
      );
    }
    seen.add(permission.action);
  }
}

function assertPermissionSubset(granted: ConsentPermission, requested: RequiredPermission): void {
  assertNoUnrequestedAllowingDimension(granted, requested);
  assertAllowingSubset(granted.allowlist, requested.allowlist, granted.action, "allowlist");
  assertRequiredSuperset(granted.denylist, requested.denylist, granted.action, "denylist");
  assertRequiredSuperset(
    granted.requireApproval,
    requested.requireApproval,
    granted.action,
    "requireApproval",
  );
  assertAllowingSubset(granted.allowLabels, requested.allowLabels, granted.action, "allowLabels");
  assertRequiredSuperset(granted.denyLabels, requested.denyLabels, granted.action, "denyLabels");
  assertRequiredSuperset(
    granted.requireApprovalLabels,
    requested.requireApprovalLabels,
    granted.action,
    "requireApprovalLabels",
  );
  assertInputRuleSubset(granted.inputRules, requested.inputRules, granted.action);
}

function assertNoUnrequestedAllowingDimension(
  granted: ConsentPermission,
  requested: RequiredPermission,
): void {
  const requestedHasAllowingDimension =
    requested.allowlist !== undefined || requested.allowLabels !== undefined;
  if (!requestedHasAllowingDimension) return;
  if (requested.allowlist === undefined && granted.allowlist !== undefined) {
    throw new Error(
      `AppConnector consent permission ${granted.action}.allowlist exceeds connector requirement`,
    );
  }
  if (requested.allowLabels === undefined && granted.allowLabels !== undefined) {
    throw new Error(
      `AppConnector consent permission ${granted.action}.allowLabels exceeds connector requirement`,
    );
  }
}

function assertAllowingSubset(
  granted: readonly string[] | undefined,
  requested: readonly string[] | undefined,
  action: string,
  field: string,
): void {
  if (requested !== undefined && granted === undefined) {
    throw new Error(
      `AppConnector consent permission ${action}.${field} omits connector requirement`,
    );
  }
  if (granted === undefined || requested === undefined) return;
  const requestedValues = new Set(requested);
  for (const value of granted) {
    if (!requestedValues.has(value)) {
      throw new Error(
        `AppConnector consent permission ${action}.${field} exceeds connector requirement: ${value}`,
      );
    }
  }
}

function assertRequiredSuperset(
  granted: readonly string[] | undefined,
  requested: readonly string[] | undefined,
  action: string,
  field: string,
): void {
  if (requested !== undefined && granted === undefined) {
    throw new Error(
      `AppConnector consent permission ${action}.${field} omits connector requirement`,
    );
  }
  if (requested === undefined) return;
  const grantedValues = new Set(granted ?? []);
  for (const value of requested) {
    if (!grantedValues.has(value)) {
      throw new Error(
        `AppConnector consent permission ${action}.${field} omits connector requirement: ${value}`,
      );
    }
  }
}

function assertInputRuleSubset(
  granted: ReadonlyArray<ConsentInputRule> | undefined,
  requested: ReadonlyArray<RequiredInputRule> | undefined,
  action: string,
): void {
  if (requested !== undefined && granted === undefined) {
    throw new Error(
      `AppConnector consent permission ${action}.inputRules omits connector requirement`,
    );
  }
  if (granted === undefined) return;
  if (requested === undefined) {
    throw new Error(
      `AppConnector consent permission ${action}.inputRules exceeds connector requirement`,
    );
  }
  const requestedRules = new Set(requested.map((rule) => JSON.stringify(rule)));
  const grantedRules = new Set(granted.map((rule) => JSON.stringify(rule)));
  for (const rule of granted) {
    const serialized = JSON.stringify(rule);
    if (!requestedRules.has(serialized)) {
      throw new Error(
        `AppConnector consent permission ${action}.inputRules exceeds connector requirement`,
      );
    }
  }
  for (const rule of requested) {
    if (!grantedRules.has(JSON.stringify(rule))) {
      throw new Error(
        `AppConnector consent permission ${action}.inputRules omits connector requirement`,
      );
    }
  }
}
