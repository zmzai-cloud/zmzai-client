import { app, BrowserWindow, Notification, Tray, Menu, ipcMain, nativeImage } from "electron";
import { join } from "node:path";
import { BridgeClient, type ApprovalRequest, type BridgeEvent, type BridgeState } from "../bridge/bridge-client.js";
import { loadConfig, type ClientConfig } from "../bridge/config.js";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridge: BridgeClient | null = null;
let isQuiting = false;
let lastStatus: BridgeState = "disconnected";
let lastStatusDetail: string | undefined;

const pendingApprovals = new Map<string, (allowed: boolean) => void>();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: "zmzai 客户端",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("close", (e) => {
    // 关闭窗口仅隐藏到托盘，真正退出走托盘菜单
    if (!isQuiting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

function notify(title: string, body: string, urgency?: "low" | "normal" | "critical"): void {
  if (Notification.isSupported()) {
    new Notification({ title, body, urgency }).show();
  }
  // 即便不支持系统通知，也把信息推到 UI 日志
  mainWindow?.webContents.send("bridge:event", {
    type: "log",
    level: urgency === "critical" ? "error" : "info",
    msg: `[通知] ${title}: ${body}`,
  });
}

function forwardEvent(e: BridgeEvent): void {
  if (e.type === "status") {
    lastStatus = e.state;
    lastStatusDetail = e.detail;
  }
  mainWindow?.webContents.send("bridge:event", e);
}

function askApproval(req: ApprovalRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(req.id, resolve);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bridge:approval-request", req);
      notify(`需要授权：${req.tool}`, req.summary, req.risk === "high" ? "critical" : "normal");
    } else {
      // 没有可用 UI 时默认拒绝，避免静默执行
      resolve(false);
    }
  });
}

function buildBridge(config: ClientConfig): BridgeClient {
  const auditPath = join(app.getPath("userData"), "audit.jsonl");
  return new BridgeClient(
    {
      bridgeUrl: config.bridgeUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      approvedRoots: config.approvedRoots,
      shellEnabled: config.shellEnabled,
      execTimeoutMs: config.execTimeoutMs,
      notify,
      askApproval,
      onEvent: forwardEvent,
    },
    auditPath,
  );
}

function createTray(): void {
  // 不依赖外部图标资源：用空图像 + 标题占位，仍可点击交互
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("ZM");
  tray.setToolTip("zmzai 客户端桥接");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示窗口", click: () => mainWindow?.show() },
      {
        label: "重连云端",
        click: () => {
          bridge?.disconnect();
          bridge?.connect();
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuiting = true;
          bridge?.disconnect();
          app.quit();
        },
      },
    ]),
  );
}

function registerIpc(config: ClientConfig): void {
  ipcMain.handle("bridge:get-state", () => ({
    status: lastStatus,
    detail: lastStatusDetail,
    config: {
      bridgeUrl: config.bridgeUrl,
      clientId: config.clientId,
      approvedRoots: config.approvedRoots,
      shellEnabled: config.shellEnabled,
    },
    audit: bridge?.getAuditLog().recent(100) ?? [],
  }));

  ipcMain.handle("bridge:resolve-approval", (_e, id: string, allowed: boolean) => {
    const fn = pendingApprovals.get(id);
    if (fn) {
      fn(allowed);
      pendingApprovals.delete(id);
    }
    return true;
  });

  ipcMain.handle("bridge:update-config", (_e, patch: Partial<ClientConfig>) => {
    if (typeof patch.shellEnabled === "boolean") config.shellEnabled = patch.shellEnabled;
    if (Array.isArray(patch.approvedRoots)) config.approvedRoots = patch.approvedRoots;
    if (typeof patch.bridgeUrl === "string") config.bridgeUrl = patch.bridgeUrl;
    bridge?.disconnect();
    bridge = buildBridge(config);
    bridge.connect();
    return true;
  });
}

app.whenReady().then(() => {
  const config = loadConfig();
  createWindow();
  createTray();
  registerIpc(config);
  bridge = buildBridge(config);
  bridge.connect();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on("window-all-closed", () => {
  // 保留托盘驻留，不退出
});

// 确保退出时清理
app.on("before-quit", () => {
  bridge?.disconnect();
});
