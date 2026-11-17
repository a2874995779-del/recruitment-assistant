import { contextBridge, ipcRenderer } from "electron";
// This CommonJS preload deliberately exposes only named operations, never raw ipcRenderer.
contextBridge.exposeInMainWorld(
  "recruitment",
  Object.freeze({
    bossBrowser: Object.freeze({
      request: (operation: string, payload: unknown = {}) =>
        ipcRenderer.invoke("recruitment:boss-browser", { operation, payload }),
    }),
    command: (operation: string, payload: unknown = {}) =>
      ipcRenderer.invoke("recruitment:command", { operation, payload }),
    openSource: (url: string) =>
      ipcRenderer.invoke("recruitment:open-source", { url }),
  }),
);
