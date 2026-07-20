import type { DispatchPolicyRegistration } from "../../src/index";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type PointIdsAreDispatchOnly = Expect<
  Equal<DispatchPolicyRegistration["pointIds"], readonly ["dispatch.action.pre"]>
>;
type CapabilityKeyIsDispatchOnly = Expect<
  Equal<keyof DispatchPolicyRegistration["effectCapabilities"], "dispatch.action.pre">
>;
export type DispatchPolicyRegistrationContract =
  | PointIdsAreDispatchOnly
  | CapabilityKeyIsDispatchOnly;
