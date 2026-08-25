import { createHmac } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

export interface ToolResult {
  id: string;
  ok: boolean;
  error?: string;
  data?: unknown;
  audit?: { decidedBy: string; approved: boolean; tool: string; risk: string };
}

/**
 * E2E 用的「可控云端桥」：跑在 harness 同进程内，
 * - 校验客户端握手签名（与生产同款 HMAC）
 * - 按指令向已连接客户端下发指定 tool_request
 * - 收集客户端回传的 tool_result（含 audit）与 audit_report，供断言
 */
export class TestBridge {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private seq = 0;
  results: ToolResult[] = [];
  auditReports: Array<unknown> = [];
  connected = false;

  constructor(
    port: number,
    private readonly secret = "e2e-secret",
  ) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  private sign(subject: string, ts: number): string {
    return createHmac("sha256", this.secret).update(`${subject}:${ts}`).digest("hex");
  }

  private onConnection(ws: WebSocket): void {
    this.client = ws;
    this.connected = true;
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.kind === "hello") {
        const expect = this.sign(`${msg.clientId}:${msg.userId}:${msg.nonce}`, msg.ts as number);
        if (msg.signature !== expect) {
          ws.close();
          return;
        }
        const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
        const ts = Date.now();
        ws.send(
          JSON.stringify({
            kind: "welcome",
            v: 3,
            sessionId,
            userId: msg.userId,
            nonce: msg.nonce,
            ts,
            signature: this.sign(sessionId, ts),
          }),
        );
      } else if (msg.kind === "tool_result") {
        this.results.push({
          id: msg.id as string,
          ok: msg.ok as boolean,
          error: msg.error as string | undefined,
          data: msg.data,
          audit: msg.audit as ToolResult["audit"],
        });
      } else if (msg.kind === "audit_report") {
        this.auditReports.push(msg.audit);
      }
    });
    ws.on("close", () => {
      this.connected = false;
      this.client = null;
    });
  }

  /** 向客户端下发工具请求，返回其 id（供后续断言/审批定位） */
  sendTool(tool: string, params: Record<string, unknown>, risk: string, id?: string): string {
    const tid = id ?? `e2e-${Date.now()}-${this.seq++}`;
    this.client?.send(
      JSON.stringify({ kind: "tool_request", v: 3, id: tid, tool, params, risk, issuedAt: Date.now() }),
    );
    return tid;
  }

  getResult(id: string): ToolResult | undefined {
    return this.results.find((r) => r.id === id);
  }

  async close(): Promise<void> {
    await new Promise<void>((res) => this.wss.close(() => res()));
  }
}
