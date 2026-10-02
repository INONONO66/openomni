import { spyOn } from "bun:test";
import { ModelsDev } from "../../../src/model/model";
import { createCatalogLoader } from "../../../src/model/model/loader";

export function resetCatalog(loadSnapshot?: Parameters<typeof createCatalogLoader>[0]): void {
  spyOn(ModelsDev, "get").mockImplementation(createCatalogLoader(loadSnapshot));
}
