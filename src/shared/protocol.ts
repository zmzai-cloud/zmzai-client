/**
 * zmzai 客户端 ↔ 云端桥接协议
 *
 * 设计要点：
 * - 客户端（本机）主动建立【出站】WebSocket 到云端桥接端点，云端 Agent 经此下发工具请求。
 *   这样客户端处于 NAT/防火墙后也能被触达（反向隧道模式）。
 * - 所有交互包裹在统一 Envelope 里，带协议版本 v 与消息 id。
 * - 握手用 HMAC-SHA256 签名（覆盖 clientId + userId + nonce + ts）；welcome 由云端用
 *   ECDSA 私钥签名（客户端预置云端公钥验签，防伪造端点；未配置公钥时跳过验签）。
 * - 高风险操作在本地触发审批，审批通过后才执行。
 * - 本文件保持「纯」依赖（仅 zod），可在主进程与渲染进程同时 import。
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 3 as const;

/** 本地可向云端暴露的能力 */
export const ToolName = z.enum(["fs.read", "fs.write", "shell.exec", "notify"]);
export type ToolName = z.infer<typeof ToolName>;

/** 风险分级：决定是否需要本地用户审批 */
export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

// ---- 各工具入参 ----
export const FsReadParams = z.object({
  path: z.string().min(1),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  maxBytes: z.number().int().positive().max(5_000_000).default(200_000),
});
export type FsReadParams = z.infer<typeof FsReadParams>;

export const FsWriteParams = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});
export type FsWriteParams = z.infer<typeof FsWriteParams>;

export const ShellExecParams = z.object({
  command: z.string().min(1).max(2000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});
export type ShellExecParams = z.infer<typeof ShellExecParams>;

export const NotifyParams = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(500),
  urgency: z.enum(["low", "normal", "critical"]).default("normal"),
});
export type NotifyParams = z.infer<typeof NotifyParams>;

/** 审计记录：每一次工具执行都落盘，可事后复盘 */
export const AuditRecord = z.object({
  id: z.string(),
  clientId: z.string(),
  tool: ToolName,
  risk: RiskLevel,
  approved: z.boolean(),
  decidedBy: z.enum(["auto", "user", "policy"]),
  startedAt: z.number(),
  finishedAt: z.number(),
  summary: z.string(),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

/** 统一信封：用 kind 区分消息类型 */
export const Envelope = z.discriminatedUnion("kind", [
  // 客户端 → 云端：握手，携带 HMAC 签名；userId 声明本机归属用户（云端据此路由），nonce 防重放
  z.object({
    kind: z.literal("hello"),
    v: z.literal(PROTOCOL_VERSION),
    clientId: z.string().min(1),
    /** 本机归属的用户标识（被签名覆盖，防篡改） */
    userId: z.string().min(1),
    /** 一次性随机值（hex，≥16 字符）：被签名覆盖，防篡改；welcome 签名覆盖它防重放 */
    nonce: z.string().min(16).max(128),
    ts: z.number().int().positive(),
    signature: z.string().min(1),
  }),
  // 云端 → 客户端：接受握手，分配会话并回显归属用户与 nonce；signature 为 ECDSA/HMAC
  z.object({
    kind: z.literal("welcome"),
    v: z.literal(PROTOCOL_VERSION),
    sessionId: z.string().min(1),
    userId: z.string().min(1),
    nonce: z.string().min(16).max(128),
    ts: z.number().int().positive(),
    signature: z.string().min(1),
  }),
  // 云端 → 客户端：工具调用请求
  z.object({
    kind: z.literal("tool_request"),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1),
    tool: ToolName,
    params: z.unknown(),
    risk: RiskLevel.default("medium"),
    issuedAt: z.number().int().positive(),
  }),
  // 客户端 → 云端：工具执行结果（含审计）
  z.object({
    kind: z.literal("tool_result"),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
    audit: AuditRecord,
  }),
  z.object({ kind: z.literal("ping"), v: z.literal(PROTOCOL_VERSION), ts: z.number().int().positive() }),
  z.object({ kind: z.literal("pong"), v: z.literal(PROTOCOL_VERSION), ts: z.number().int().positive() }),
]);
export type Envelope = z.infer<typeof Envelope>;

/** 按工具名解析对应入参（执行前调用） */
export function parseParams(tool: ToolName, params: unknown) {
  switch (tool) {
    case "fs.read":
      return FsReadParams.parse(params);
    case "fs.write":
      return FsWriteParams.parse(params);
    case "shell.exec":
      return ShellExecParams.parse(params);
    case "notify":
      return NotifyParams.parse(params);
  }
}
