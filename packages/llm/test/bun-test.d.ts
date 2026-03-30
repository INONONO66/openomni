declare module "bun:test" {
  export const describe: (...args: unknown[]) => unknown;
  export const expect: (value: unknown) => any;
  export const test: (...args: unknown[]) => unknown;
  export const beforeEach: (...args: unknown[]) => unknown;
}
