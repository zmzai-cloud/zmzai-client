import { app, BrowserWindow, Notification, Tray, Menu, nativeImage } from "electron";
import { join } from "node:path";
import { loadConfig, type ClientConfig } from "../bridge/config.js";
import { BridgeRuntime } from "./bridge-runtime.js";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuiting = false;
let runtime: BridgeRuntime | null = null;

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
          runtime?.bridge?.disconnect();
          runtime?.bridge?.connect();
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuiting = true;
          runtime?.bridge?.disconnect();
          app.quit();
        },
      },
    ]),
  );
}

app.whenReady().then(() => {
  const config: ClientConfig = loadConfig();
  runtime = new BridgeRuntime(
    () => mainWindow,
    notify,
    () => config,
  );
  runtime.setApprovalTimeoutMs(config.approvalTimeoutMs);

  createWindow();
  createTray();
  runtime.registerIpc();

  runtime.bridge = runtime.buildBridge();
  runtime.bridge.connect();

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
  isQuiting = true;
  runtime?.bridge?.disconnect();
});
