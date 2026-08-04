export type StakesDriverScenario = "threshold-and-split" | "forged-local-value";

type StakesDriverStatus =
  | Readonly<{
      scenario: "threshold-and-split";
      ok: true;
      resultCode: "threshold_and_split_verified";
    }>
  | Readonly<{
      scenario: "threshold-and-split";
      ok: false;
      resultCode: "threshold_and_split_failed";
    }>
  | Readonly<{
      scenario: "forged-local-value";
      ok: true;
      resultCode: "forged_local_value_denied";
    }>
  | Readonly<{
      scenario: "forged-local-value";
      ok: false;
      resultCode: "forged_local_value_reached_seam";
    }>;

export type StakesDriverReceipt = Readonly<{
  version: "stakes-driver-v1";
  mode: "scenario";
}> &
  StakesDriverStatus &
  Readonly<Record<string, unknown>>;

export function stakesDriverStatus(
  scenario: StakesDriverScenario,
  ok: boolean,
): StakesDriverStatus {
  switch (scenario) {
    case "threshold-and-split":
      return ok
        ? { scenario, ok: true, resultCode: "threshold_and_split_verified" }
        : { scenario, ok: false, resultCode: "threshold_and_split_failed" };
    case "forged-local-value":
      return ok
        ? { scenario, ok: true, resultCode: "forged_local_value_denied" }
        : { scenario, ok: false, resultCode: "forged_local_value_reached_seam" };
  }
}
