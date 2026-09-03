import { contextBridge } from "electron";
import type { DesktopApi } from "./api";

const api: DesktopApi = {
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
};

contextBridge.exposeInMainWorld("desktop", api);
