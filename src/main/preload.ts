import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  version: process.versions.electron,
  openExternal: (url: string) => window.open(url, "_blank")
});
