import { expect, test } from "bun:test";
import { RendererInvariantError } from "../src/renderer/errors";
import { rendererRoot } from "../src/renderer/root";

const documentWith = (root: HTMLElement | null) => ({
  getElementById: (id: string) => (id === "root" ? root : null),
});

test("the renderer entry refuses to boot without its root element", () => {
  expect(() => rendererRoot(documentWith(null))).toThrow(RendererInvariantError);
});

test("the renderer entry mounts into the root element the document provides", () => {
  const root = { id: "root" } as HTMLElement;
  expect(rendererRoot(documentWith(root))).toBe(root);
});
