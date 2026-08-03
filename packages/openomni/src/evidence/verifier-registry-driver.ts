import { runVerifierRegistryDriver } from "./verifier-registry-driver-api.js";

export { runVerifierRegistryDriver };

if (import.meta.main) {
  const result = runVerifierRegistryDriver(Bun.argv.slice(2));
  await Bun.stdout.write(`${result.stdout}\n`);
  process.exitCode = result.exitCode;
}
