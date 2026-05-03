import { describe, expect, test } from "bun:test";
import { Extension } from "@openomni/protocol";
import { getManifest } from "./src/index";

describe("protocol-only fixture", () => {
  test("exports a manifest parseable by protocol contracts", () => {
    const manifest = Extension.Manifest.parse(getManifest());

    expect(manifest.id).toBe("protocol-only-fixture");
    expect(manifest.contributes?.agents).toHaveLength(1);
    expect(manifest.contributes?.tools).toHaveLength(1);
    expect(manifest.contributes?.skills).toHaveLength(1);
    expect(manifest.contributes?.mcpServers).toHaveLength(1);
  });
});
