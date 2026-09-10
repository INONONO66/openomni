import type { DoctorReport } from "../../src/cli/doctor";

export function doctorStatuses(report: DoctorReport) {
  return new Map(report.checks.map((check) => [check.name, check.status]));
}
