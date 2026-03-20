import { app, contextBridge } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  version: app.getVersion(),
  openExternal: (url: string) => window.open(url, "_blank")
});
