import type { DesktopApi } from "../src/preload/api";

declare global {
  interface Window {
    readonly desktop: DesktopApi;
  }
}
