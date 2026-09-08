import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  GATEWAY_CHANNEL,
  SHELL_COMMAND_CHANNEL,
  type DesktopApi,
  type GatewayEndpoint,
  type ShellCommand,
} from "./api";

const api: DesktopApi = {
  onShellCommand: (listener) => {
    const wrapper = (_event: IpcRendererEvent, command: ShellCommand) => listener(command);
    ipcRenderer.on(SHELL_COMMAND_CHANNEL, wrapper);
    return () => {
      ipcRenderer.removeListener(SHELL_COMMAND_CHANNEL, wrapper);
    };
  },
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  /**
   * One `invoke`, no cache. The main process answers from an environment that
   * was read at boot, so this is cheap, and caching it here would put a second
   * copy of the answer in the one process that is not allowed to have opinions
   * about it.
   */
  gateway: () => ipcRenderer.invoke(GATEWAY_CHANNEL) as Promise<GatewayEndpoint | undefined>,
};

contextBridge.exposeInMainWorld("desktop", api);
