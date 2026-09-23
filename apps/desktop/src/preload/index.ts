import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  CLOSE_WINDOW_CHANNEL,
  GATEWAY_CHANNEL,
  SHELL_COMMAND_CHANNEL,
  type DesktopApi,
} from "./api";
import { gatewayEndpointSchema, shellCommandSchema } from "./validation";

const api: DesktopApi = {
  onShellCommand: (listener) => {
    const wrapper = (_event: IpcRendererEvent, command: unknown) => {
      const result = shellCommandSchema.safeParse(command);
      if (result.success) listener(result.data);
    };
    ipcRenderer.on(SHELL_COMMAND_CHANNEL, wrapper);
    return () => {
      ipcRenderer.removeListener(SHELL_COMMAND_CHANNEL, wrapper);
    };
  },
  closeWindow: () => {
    ipcRenderer.send(CLOSE_WINDOW_CHANNEL);
  },
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  gateway: async () => gatewayEndpointSchema.parse(await ipcRenderer.invoke(GATEWAY_CHANNEL)),
};

contextBridge.exposeInMainWorld("desktop", api);
