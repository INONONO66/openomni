// Fixture input for verify-tsconfig-inheritance — intentionally trivial. The
// project config mutates emit policy (declaration dropped, noEmit introduced);
// the verifier must fail its emit-policy comparison.
const entryMarker = "declaration-mutation fixture";
void entryMarker;
