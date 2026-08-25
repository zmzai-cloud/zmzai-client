import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { sign, verifyWelcome } from "./sign.js";
import {
  AuditRecord,
  Envelope,
  FsReadParams,
  FsWriteParams,
  NotifyParams,
  PROTOCOL_VERSION,
  RiskLevel,
  ShellExecParams,
  ToolName,
} from "../shared/protocol.js";
import {
  CapabilityContext,
  execFsRead,
  execFsWrite,
  execNotify,
  execShell,
} from "./capabilities.js";
import { AuditLog } from "./audit.js";

export type BridgeState = "connecting" | "connected" | "disconnected" | "error";

export interface ApprovalRequest {
  id: string;
  tool: ToolName;
  risk: RiskLevel;
  summary: string;
  paramsSummary: string;
}

export type BridgeEvent =
  | { type: "status"; state: BridgeState; detail?: string }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | { type: "audit"; record: AuditRecord };

export interface BridgeDeps {
  bridgeUrl: string;
  clientId: string;
  clientSecret: string;
  /** 本机归属的用户标识（hello 携带、被签名覆盖），云端据此路由 */
  userId: string;
  /** 云端桥接端点公钥 PEM：配置后强制验签 welcome（防伪造云端端点）；null 跳过（本机联调） */
  bridgePublicKeyPem: string | null;
  /** 是否允许非 wss 连接（仅本机联调；生产必须 wss + 严格证书校验） */
  allowInsecureWs: boolean;
  approvedRoots: string[];
  shellEnabled: boolean;
  execTimeoutMs: number;
  notify: (title: string, body: string, urgency?: "low" | "normal" | "critical") => void;
  /** 需要用户审批时由主进程实现：弹出 UI 并等待用户决定，返回是否允许 */
  askApproval: (req: ApprovalRequest) => Promise<boolean>;
  onEvent: (e: BridgeEvent) => void;
}

const HEARTBEAT_MS = 25_000;
const RECONNECT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 桥接客户端核心：主动向云端建立【出站】WebSocket，完成握手、心跳、重连，
 * 并把云端下发的工具请求路由到本地能力处理器，按风险策略决定是否需要用户审批。
 */
export class BridgeClient {
  private ws: WebSocket | null = null;
  private audit: AuditLog;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  /** 本次握手使用的一次性 nonce（welcome 验签时比对，防重放） */
  private pendingNonce: string | null = null;
  /** welcome 验签失败视为不可恢复错误（端点不可信），不再自动重连 */
  private fatal = false;

  constructor(private deps: BridgeDeps, auditPath: string) {
    this.audit = new AuditLog(auditPath);
  }

  getAuditLog(): AuditLog {
    return this.audit;
  }

  connect(): void {
    this.closedByUser = false;
    this.fatal = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.setState("disconnected", "用户已断开");
  }

  private setState(s: BridgeState, detail?: string): void {
    this.deps.onEvent({ type: "status", state: s, detail });
  }

  private open(): void {
    this.setState("connecting");
    // wss 强制：非 wss 端点视为配置错误（本机联调可显式 ALLOW_INSECURE_WS=true），
    // 证书校验保持 ws 默认严格（不传 rejectUnauthorized）。端点不可信则不连、不重连。
    let url: URL;
    try {
      url = new URL(this.deps.bridgeUrl);
    } catch {
      this.deps.onEvent({ type: "log", level: "error", msg: `BRIDGE_URL 非法: ${this.deps.bridgeUrl}` });
      this.setState("error", "BRIDGE_URL 非法");
      this.fatal = true;
      return;
    }
    if (url.protocol !== "wss:" && !this.deps.allowInsecureWs) {
      this.deps.onEvent({
        type: "log",
        level: "error",
        msg: "BRIDGE_URL 必须为 wss://（仅本机联调可设 ALLOW_INSECURE_WS=true），已停止连接",
      });
      this.setState("error", "BRIDGE_URL 必须为 wss://（生产环境）");
      this.fatal = true;
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.deps.bridgeUrl, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    } catch (e) {
      this.deps.onEvent({ type: "log", level: "error", msg: `无法建立连接: ${String(e)}` });
      this.setState("error", String(e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      const ts = Date.now();
      const nonce = randomBytes(16).toString("hex");
      this.pendingNonce = nonce;
      const signature = sign(
        this.deps.clientId,
        this.deps.userId,
        nonce,
        ts,
        this.deps.clientSecret,
      );
      ws.send(
        JSON.stringify({
          kind: "hello",
          v: 3,
          clientId: this.deps.clientId,
          userId: this.deps.userId,
          nonce,
          ts,
          signature,
        }),
      );
      this.startHeartbeat();
      this.deps.onEvent({ type: "log", level: "info", msg: "WebSocket 已打开，正在握手…" });
    });

    ws.on("message", (raw) => {
      void this.onMessage(raw.toString());
    });

    ws.on("close", (code, reason) => {
      this.stopHeartbeat();
      this.setState("disconnected", `code=${code} ${reason.toString()}`);
      if (!this.closedByUser) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.deps.onEvent({ type: "log", level: "error", msg: `ws error: ${err.message}` });
      this.setState("error", err.message);
    });
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = Envelope.safeParse(msg);
    if (!parsed.success) {
      this.deps.onEvent({ type: "log", level: "warn", msg: `丢弃非法信封: ${parsed.error.message}` });
      return;
    }
    const env = parsed.data;
    switch (env.kind) {
      case "welcome": {
        // 防重放：welcome 必须回显本次握手 nonce
        if (this.pendingNonce !== env.nonce) {
          this.deps.onEvent({ type: "log", level: "error", msg: "welcome nonce 不匹配，疑似重放，断开连接" });
          this.fatal = true;
          this.ws?.close();
          return;
        }
        // 防伪造端点：配置了云端公钥时强制验签 welcome
        if (this.deps.bridgePublicKeyPem) {
          const verified = verifyWelcome(
            env.sessionId,
            env.userId,
            env.nonce,
            env.ts,
            env.signature,
            this.deps.bridgePublicKeyPem,
          );
          if (!verified) {
            this.deps.onEvent({
              type: "log",
              level: "error",
              msg: "welcome 签名校验失败：连接端点不可信（可能被伪造），已断开且不再自动重连",
            });
            this.setState("error", "welcome 签名校验失败（端点不可信）");
            this.fatal = true;
            this.ws?.close();
            return;
          }
        }
        this.pendingNonce = null;
        this.setState("connected", `session=${env.sessionId}`);
        this.deps.onEvent({
          type: "log",
          level: "info",
          msg: `已连接云端桥接，会话 ${env.sessionId}（userId=${env.userId}${this.deps.bridgePublicKeyPem ? "，welcome 验签通过" : "，未配置公钥未验签"}）`,
        });
        break;
      }
      case "tool_request":
        await this.handleToolRequest(env);
        break;
      case "ping":
        this.send({ kind: "pong", v: PROTOCOL_VERSION, ts: Date.now() });
        break;
      case "pong":
        break;
      default:
        break;
    }
  }

  private async handleToolRequest(env: Extract<Envelope, { kind: "tool_request" }>): Promise<void> {
    const startedAt = Date.now();
    const paramsSummary = summarize(env.tool, env.params);
    const record: AuditRecord = {
      id: env.id,
      clientId: this.deps.clientId,
      tool: env.tool,
      risk: env.risk,
      approved: false,
      decidedBy: "auto",
      startedAt,
      finishedAt: startedAt,
      summary: paramsSummary,
    };

    try {
      if (this.needsApproval(env.tool, env.risk)) {
        const allowed = await this.deps.askApproval({
          id: env.id,
          tool: env.tool,
          risk: env.risk,
          summary: paramsSummary,
          paramsSummary,
        });
        record.approved = allowed;
        record.decidedBy = "user";
        if (!allowed) throw new Error("用户拒绝执行");
      } else {
        record.approved = true;
        record.decidedBy = "auto";
      }

      const ctx: CapabilityContext = {
        approvedRoots: this.deps.approvedRoots,
        shellEnabled: this.deps.shellEnabled,
        execTimeoutMs: this.deps.execTimeoutMs,
        notify: this.deps.notify,
      };
      const data = await this.runCapability(env.tool, env.params, ctx);
      record.finishedAt = Date.now();
      this.audit.record(record);
      this.deps.onEvent({ type: "audit", record });
      this.send({ kind: "tool_result", v: PROTOCOL_VERSION, id: env.id, ok: true, data, audit: record });
    } catch (err) {
      record.finishedAt = Date.now();
      this.audit.record(record);
      this.deps.onEvent({ type: "audit", record });
      const message = err instanceof Error ? err.message : String(err);
      this.send({ kind: "tool_result", v: PROTOCOL_VERSION, id: env.id, ok: false, error: message, audit: record });
    }
    this.uploadAudit(record);
  }

  /** 审计上送：每次执行落盘后，经 WS 把审计记录异步发给云端（供跨端复盘）。尽力而为。 */
  private uploadAudit(record: AuditRecord): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({
      kind: "audit_report",
      v: PROTOCOL_VERSION,
      clientId: this.deps.clientId,
      userId: this.deps.userId,
      audit: record,
      ts: Date.now(),
    });
  }

  /** 风险策略：决定是否需要本地用户审批 */
  private needsApproval(tool: ToolName, risk: RiskLevel): boolean {
    if (tool === "shell.exec") return true; // 即便已启用也逐条审批
    if (tool === "fs.write") return true;
    if (tool === "fs.read") return risk === "high";
    if (tool === "notify") return false;
    return true;
  }

  private async runCapability(tool: ToolName, params: unknown, ctx: CapabilityContext) {
    switch (tool) {
      case "fs.read":
        return execFsRead(ctx, FsReadParams.parse(params));
      case "fs.write":
        return execFsWrite(ctx, FsWriteParams.parse(params));
      case "shell.exec":
        return execShell(ctx, ShellExecParams.parse(params));
      case "notify":
        return execNotify(ctx, NotifyParams.parse(params));
    }
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send({ kind: "ping", v: PROTOCOL_VERSION, ts: Date.now() });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.fatal) return;
    this.deps.onEvent({ type: "log", level: "warn", msg: `${RECONNECT_MS}ms 后重连…` });
    this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_MS);
  }
}

function summarize(tool: ToolName, params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "fs.read":
      return `读取 ${p.path}`;
    case "fs.write":
      return `写入 ${p.path}（${String(p.content ?? "").length} 字符）`;
    case "shell.exec":
      return `执行命令: ${p.command}`;
    case "notify":
      return `通知: ${p.title}`;
  }
}
