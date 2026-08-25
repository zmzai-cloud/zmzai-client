import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import {
  BridgeClient,
  type ApprovalDecision,
  type ApprovalRequest,
  type BridgeEvent,
  type BridgeState,
} from "../bridge/bridge-client.js";
import type { ClientConfig } from "../bridge/config.js";

/**
 * 桥接运行时：承载真实的审批与桥接生命周期，供主进程（main/index.ts）与 E2E harness 复用，
 * 避免在测试里重新实现 askApproval —— 这样 E2E 跑的就是生产同款「超时→policy / 用户→user」链路。
 */
export class BridgeRuntime {
  private pendingApprovals = new Map<string, (allowed: boolean) => void>();
  private approvalTimeoutMs = 120_000;
  private lastStatus: BridgeState = "disconnected";
  private lastStatusDetail: string | undefined;
  bridge: BridgeClient | null = null;

  constructor(
    private getMainWindow: () => BrowserWindow | null,
    private notify: (title: string, body: string, urgency?: "low" | "normal" | "critical") => void,
    private getConfig: () => ClientConfig,
  ) {}

  setApprovalTimeoutMs(ms: number): void {
    this.approvalTimeoutMs = ms;
  }

  isPending(id: string): boolean {
    return this.pendingApprovals.has(id);
  }

  /**
   * 真实审批逻辑：
   * - 超时（策略兜底）/ 无窗口可弹 → decidedBy="policy"
   * - 用户通过弹窗回调决定 → decidedBy="user"
   */
  askApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(req.id)) {
          this.pendingApprovals.delete(req.id);
          // 超时由策略兜底，决定来源记为 policy（非用户主动）
          resolve({ allowed: false, decidedBy: "policy" });
          this.getMainWindow()?.webContents.send("bridge:event", {
            type: "log",
            level: "warn",
            msg: `审批超时（${this.approvalTimeoutMs}ms），已默认拒绝: ${req.tool} ${req.summary}`,
          });
        }
      }, this.approvalTimeoutMs);
      this.pendingApprovals.set(req.id, (allowed) => {
        clearTimeout(timer);
        // 用户主动在弹窗中做出的决定，来源记为 user
        resolve({ allowed, decidedBy: "user" });
      });
      const win = this.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("bridge:approval-request", req);
        this.notify(`需要授权：${req.tool}`, req.summary, req.risk === "high" ? "critical" : "normal");
      } else {
        clearTimeout(timer);
        this.pendingApprovals.delete(req.id);
        // 无窗口可弹，兜底拒绝，来源记为 policy
        resolve({ allowed: false, decidedBy: "policy" });
      }
    });
  }

  /** 由渲染进程弹窗（或 E2E 经 IPC）调用，触发用户决定分支 */
  resolveApproval(id: string, allowed: boolean): boolean {
    const fn = this.pendingApprovals.get(id);
    if (fn) {
      fn(allowed);
      this.pendingApprovals.delete(id);
      return true;
    }
    return false;
  }

  buildBridge(): BridgeClient {
    const config = this.getConfig();
    const auditPath = join(app.getPath("userData"), "audit.jsonl");
    return new BridgeClient(
      {
        bridgeUrl: config.bridgeUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        userId: config.userId,
        bridgePublicKeyPem: config.bridgePublicKeyPem,
        allowInsecureWs: config.allowInsecureWs,
        approvedRoots: config.approvedRoots,
        shellEnabled: config.shellEnabled,
        execTimeoutMs: config.execTimeoutMs,
        notify: this.notify,
        askApproval: (req) => this.askApproval(req),
        onEvent: (e: BridgeEvent) => {
          if (e.type === "status") {
            this.lastStatus = e.state;
            this.lastStatusDetail = e.detail;
          }
          this.getMainWindow()?.webContents.send("bridge:event", e);
        },
      },
      auditPath,
    );
  }

  registerIpc(): void {
    ipcMain.handle("bridge:get-state", () => {
      const c = this.getConfig();
      return {
        status: this.lastStatus,
        detail: this.lastStatusDetail,
        config: {
          bridgeUrl: c.bridgeUrl,
          clientId: c.clientId,
          userId: c.userId,
          approvedRoots: c.approvedRoots,
          shellEnabled: c.shellEnabled,
        },
        audit: this.bridge?.getAuditLog().recent(100) ?? [],
      };
    });

    ipcMain.handle("bridge:resolve-approval", (_e, id: string, allowed: boolean) =>
      this.resolveApproval(id, allowed),
    );

    ipcMain.handle("bridge:update-config", (_e, patch: Partial<ClientConfig>) => {
      const c = this.getConfig();
      if (typeof patch.shellEnabled === "boolean") c.shellEnabled = patch.shellEnabled;
      if (Array.isArray(patch.approvedRoots)) c.approvedRoots = patch.approvedRoots;
      if (typeof patch.bridgeUrl === "string") c.bridgeUrl = patch.bridgeUrl;
      this.bridge?.disconnect();
      this.bridge = this.buildBridge();
      this.bridge.connect();
      return true;
    });
  }
}
