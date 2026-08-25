import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染进程 ↔ 主进程的安全桥。所有能力都通过这里暴露，渲染进程无法直接访问 Node/Electron。
 */
const api = {
  getState: () => ipcRenderer.invoke("bridge:get-state"),
  resolveApproval: (id: string, allowed: boolean) =>
    ipcRenderer.invoke("bridge:resolve-approval", id, allowed),
  updateConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("bridge:update-config", patch),
  onEvent: (cb: (e: unknown) => void) => {
    const handler = (_e: unknown, e: unknown) => cb(e);
    ipcRenderer.on("bridge:event", handler);
  },
  onApproval: (cb: (r: unknown) => void) => {
    const handler = (_e: unknown, r: unknown) => cb(r);
    ipcRenderer.on("bridge:approval-request", handler);
  },
};

contextBridge.exposeInMainWorld("zmzai", api);

export type ZmzaiApi = typeof api;
