import { generateKeyPairSync, sign as ecdsaSign } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "../shared/protocol.js";
import type { ApprovalRequest, BridgeDeps, BridgeEvent } from "./bridge-client.js";
import { BridgeClient } from "./bridge-client.js";
import { sign as hmacSign } from "./sign.js";

// --- 基础设施：临时目录 + mock 云端桥服务器 ---

const base = realpathSync(mkdtempSync(join(tmpdir(), "zmzai-bc-")));
const root = join(base, "root");

function makeAuditPath(): string {
  return join(root, `audit-${Math.random().toString(36).slice(2)}.jsonl`);
}

function makeClient(overrides: Partial<BridgeDeps> = {}) {
  const events: BridgeEvent[] = [];
  // 优先取 overrides 提供的 mock（测试可能替换 askApproval/notify 行为），保证返回值与 deps 一致
  const notify = (overrides.notify ?? vi.fn()) as ReturnType<typeof vi.fn>;
  const askApproval = (overrides.askApproval ?? vi.fn(async () => ({ allowed: true, decidedBy: "user" }))) as ReturnType<typeof vi.fn>;
  const deps: BridgeDeps = {
    bridgeUrl: "ws://127.0.0.1:1", // 各测试覆盖为真实服务器地址
    clientId: "test-client",
    clientSecret: "test-secret",
    userId: "test-user",
    bridgePublicKeyPem: null,
    allowInsecureWs: true,
    approvedRoots: [root],
    shellEnabled: true,
    execTimeoutMs: 5000,
    notify,
    askApproval,
    onEvent: (e) => events.push(e),
    heartbeatMs: 50,
    reconnectMs: 50,
    ...overrides,
  };
  const client = new BridgeClient(deps, makeAuditPath());
  return { client, deps, events, notify, askApproval };
}

interface TestServer {
  wss: WebSocketServer;
  port: number;
  messages: unknown[];
  connections: WebSocket[];
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const wss = new WebSocketServer({ port: 0 });
  const messages: unknown[] = [];
  const connections: WebSocket[] = [];
  wss.on("connection", (ws) => {
    connections.push(ws);
    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()));
      } catch {
        /* 非 JSON 忽略 */
      }
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  return {
    wss,
    port,
    messages,
    connections,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

async function waitFor<T>(get: () => T | undefined, msg: string, timeout = 4000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = get();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时: ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 连接 + 无公钥握手（welcome 不验签）到 connected 状态 */
async function handshake(srv: TestServer, events: BridgeEvent[]): Promise<void> {
  const hello = await waitFor(
    () => srv.messages.find((m) => (m as { kind?: string }).kind === "hello") as { nonce: string },
    "hello",
  );
  srv.connections[0].send(
    JSON.stringify({
      kind: "welcome",
      v: PROTOCOL_VERSION,
      sessionId: "s1",
      userId: "test-user",
      nonce: hello.nonce,
      ts: Date.now(),
      signature: "x",
    }),
  );
  await waitFor(() => events.find((e) => e.type === "status" && e.state === "connected"), "connected");
}

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

// --- wss 强制 ---

describe("wss 强制", () => {
  it("非 wss 端点且未显式放行时不连接（fatal error）", async () => {
    const { client, events } = makeClient({ bridgeUrl: "ws://127.0.0.1:1", allowInsecureWs: false });
    client.connect();
    await waitFor(() => events.find((e) => e.type === "status" && e.state === "error"), "error state");
    expect(events.some((e) => e.type === "log" && e.level === "error" && e.msg.includes("wss"))).toBe(true);
    client.disconnect();
  });
  it("allowInsecureWs=true 时允许 ws 连接（本机联调）", async () => {
    const srv = await startServer();
    const { client } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await waitFor(() => srv.messages.find((m) => (m as { kind?: string }).kind === "hello"), "hello");
    client.disconnect();
    await srv.close();
  });
});

// --- 握手 ---

describe("握手", () => {
  it("hello 携带 v3 字段与正确 HMAC 签名（覆盖 clientId:userId:nonce:ts）", async () => {
    const srv = await startServer();
    const { client } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    const hello = (await waitFor(
      () => srv.messages.find((m) => (m as { kind?: string }).kind === "hello"),
      "hello",
    )) as { v: number; clientId: string; userId: string; nonce: string; ts: number; signature: string };
    expect(hello.v).toBe(PROTOCOL_VERSION);
    expect(hello.clientId).toBe("test-client");
    expect(hello.userId).toBe("test-user");
    expect(hello.nonce.length).toBeGreaterThan(0);
    expect(hello.signature).toBe(hmacSign("test-client", "test-user", hello.nonce, hello.ts, "test-secret"));
    client.disconnect();
    await srv.close();
  });

  it("welcome 后进入 connected（无公钥跳过验签）", async () => {
    const srv = await startServer();
    const { client, events } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await handshake(srv, events);
    client.disconnect();
    await srv.close();
  });

  it("welcome nonce 不匹配 → 断开且不再重连（防重放）", async () => {
    const srv = await startServer();
    const { client, events } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await waitFor(
      () => srv.messages.find((m) => (m as { kind?: string }).kind === "hello"),
      "hello",
    );
    srv.connections[0].send(
      JSON.stringify({
        kind: "welcome",
        v: PROTOCOL_VERSION,
        sessionId: "s1",
        userId: "test-user",
        nonce: "wrong-nonce-000000000000",
        ts: Date.now(),
        signature: "x",
      }),
    );
    await waitFor(
      () => events.find((e) => e.type === "log" && e.level === "error" && e.msg.includes("nonce")),
      "nonce mismatch log",
    );
    await sleep(200); // reconnectMs=50，若 fatal 失效会重连
    expect(srv.connections.length).toBe(1);
    client.disconnect();
    await srv.close();
  });

  it("配置公钥时 welcome 验签失败 → error 且不重连（防伪造端点）", async () => {
    const pubPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    const srv = await startServer();
    const { client, events } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}`, bridgePublicKeyPem: pubPem });
    client.connect();
    const hello = (await waitFor(
      () => srv.messages.find((m) => (m as { kind?: string }).kind === "hello"),
      "hello",
    )) as { nonce: string };
    // 用另一对密钥签名 → 验签必败
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const badSig = ecdsaSign(
      "sha256",
      Buffer.from(`s1:test-user:${hello.nonce}:${Date.now()}`),
      other.privateKey,
    ).toString("base64");
    srv.connections[0].send(
      JSON.stringify({
        kind: "welcome",
        v: PROTOCOL_VERSION,
        sessionId: "s1",
        userId: "test-user",
        nonce: hello.nonce,
        ts: Date.now(),
        signature: badSig,
      }),
    );
    await waitFor(
      () => events.find((e) => e.type === "status" && e.state === "error"),
      "verify failure error",
    );
    await sleep(200);
    expect(srv.connections.length).toBe(1);
    client.disconnect();
    await srv.close();
  });

  it("配置公钥时 welcome 验签成功 → connected", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const srv = await startServer();
    const { client, events } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}`, bridgePublicKeyPem: pubPem });
    client.connect();
    const hello = (await waitFor(
      () => srv.messages.find((m) => (m as { kind?: string }).kind === "hello"),
      "hello",
    )) as { nonce: string };
    const ts = Date.now();
    const sig = ecdsaSign("sha256", Buffer.from(`s1:test-user:${hello.nonce}:${ts}`), privateKey).toString(
      "base64",
    );
    srv.connections[0].send(
      JSON.stringify({ kind: "welcome", v: PROTOCOL_VERSION, sessionId: "s1", userId: "test-user", nonce: hello.nonce, ts, signature: sig }),
    );
    await waitFor(() => events.find((e) => e.type === "status" && e.state === "connected"), "connected");
    client.disconnect();
    await srv.close();
  });
});

// --- 工具请求：审批路由 + 执行 + 审计 ---

describe("工具请求", () => {
  it("fs.read 低风险自动执行：不审批、ok:true、审计落盘 + audit_report 上送", async () => {
    const srv = await startServer();
    const target = join(root, "hello.txt");
    writeFileSync(target, "hi there");
    const { client, events, askApproval } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await handshake(srv, events);
    srv.connections[0].send(
      JSON.stringify({
        kind: "tool_request",
        v: PROTOCOL_VERSION,
        id: "t1",
        tool: "fs.read",
        params: { path: target },
        risk: "low",
        issuedAt: Date.now(),
      }),
    );
    const result = (await waitFor(
      () => srv.messages.find((m) => (m as { id?: string; kind?: string }).kind === "tool_result" && (m as { id?: string }).id === "t1"),
      "tool_result",
    )) as { ok: boolean; data: { content: string }; audit: { decidedBy: string; approved: boolean } };
    expect(result.ok).toBe(true);
    expect(result.data.content).toContain("hi there");
    expect(result.audit.decidedBy).toBe("auto");
    expect(result.audit.approved).toBe(true);
    expect(askApproval).not.toHaveBeenCalled();
    // audit_report 上送
    await waitFor(
      () => srv.messages.find((m) => (m as { kind?: string; audit?: { id?: string } }).kind === "audit_report" && (m as { audit?: { id?: string } }).audit?.id === "t1"),
      "audit_report",
    );
    client.disconnect();
    await srv.close();
  });

  it("fs.write 必审：批准则执行，decidedBy=user", async () => {
    const srv = await startServer();
    const { client, events, askApproval } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await handshake(srv, events);
    srv.connections[0].send(
      JSON.stringify({
        kind: "tool_request",
        v: PROTOCOL_VERSION,
        id: "t2",
        tool: "fs.write",
        params: { path: join(root, "sub/new.txt"), content: "abc" },
        risk: "high",
        issuedAt: Date.now(),
      }),
    );
    await waitFor(() => (askApproval.mock.calls.length > 0 ? true : undefined), "askApproval called");
    const req = askApproval.mock.calls[0][0] as ApprovalRequest;
    expect(req.tool).toBe("fs.write");
    const result = (await waitFor(
      () => srv.messages.find((m) => (m as { id?: string; kind?: string }).kind === "tool_result" && (m as { id?: string }).id === "t2"),
      "tool_result",
    )) as { ok: boolean; audit: { decidedBy: string } };
    expect(result.ok).toBe(true);
    expect(result.audit.decidedBy).toBe("user");
    expect(readFileSync(join(root, "sub/new.txt"), "utf8")).toBe("abc");
    client.disconnect();
    await srv.close();
  });

  it("fs.write 用户拒绝 → ok:false（不执行）", async () => {
    const srv = await startServer();
    const target = join(root, "rejected.txt");
    const { client, events, askApproval } = makeClient({
      bridgeUrl: `ws://127.0.0.1:${srv.port}`,
      askApproval: vi.fn(async () => ({ allowed: false, decidedBy: "user" }) as const),
    });
    client.connect();
    await handshake(srv, events);
    srv.connections[0].send(
      JSON.stringify({
        kind: "tool_request",
        v: PROTOCOL_VERSION,
        id: "t3",
        tool: "fs.write",
        params: { path: target, content: "x" },
        risk: "high",
        issuedAt: Date.now(),
      }),
    );
    const result = (await waitFor(
      () => srv.messages.find((m) => (m as { id?: string; kind?: string }).kind === "tool_result" && (m as { id?: string }).id === "t3"),
      "tool_result",
    )) as { ok: boolean; error: string; audit: { approved: boolean; decidedBy: string } };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("拒绝");
    expect(result.audit.approved).toBe(false);
    expect(result.audit.decidedBy).toBe("user");
    expect(askApproval).toHaveBeenCalledTimes(1);
    client.disconnect();
    await srv.close();
  });

  it("fs.write 策略兜底拒绝（policy：超时/无窗口）→ ok:false、decidedBy=policy、error 含策略默认拒绝", async () => {
    const srv = await startServer();
    const target = join(root, "policy-rejected.txt");
    const { client, events, askApproval } = makeClient({
      bridgeUrl: `ws://127.0.0.1:${srv.port}`,
      // 模拟审批超时 / 无窗口可弹：策略兜底拒绝，决定来源为 policy（非用户主动）
      askApproval: vi.fn(async () => ({ allowed: false, decidedBy: "policy" }) as const),
    });
    client.connect();
    await handshake(srv, events);
    srv.connections[0].send(
      JSON.stringify({
        kind: "tool_request",
        v: PROTOCOL_VERSION,
        id: "t3b",
        tool: "fs.write",
        params: { path: target, content: "x" },
        risk: "high",
        issuedAt: Date.now(),
      }),
    );
    const result = (await waitFor(
      () => srv.messages.find((m) => (m as { id?: string; kind?: string }).kind === "tool_result" && (m as { id?: string }).id === "t3b"),
      "tool_result",
    )) as { ok: boolean; error: string; audit: { approved: boolean; decidedBy: string } };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("策略默认拒绝");
    expect(result.audit.approved).toBe(false);
    // 关键：策略兜底必须记为 policy，不能再误标成 user
    expect(result.audit.decidedBy).toBe("policy");
    expect(askApproval).toHaveBeenCalledTimes(1);
    client.disconnect();
    await srv.close();
  });

  it("notify 自动执行，不审批", async () => {
    const srv = await startServer();
    const { client, events, askApproval, notify } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await handshake(srv, events);
    srv.connections[0].send(
      JSON.stringify({
        kind: "tool_request",
        v: PROTOCOL_VERSION,
        id: "t4",
        tool: "notify",
        params: { title: "T", body: "B" },
        risk: "low",
        issuedAt: Date.now(),
      }),
    );
    const result = (await waitFor(
      () => srv.messages.find((m) => (m as { id?: string; kind?: string }).kind === "tool_result" && (m as { id?: string }).id === "t4"),
      "tool_result",
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    // urgency 有默认值 "normal"，经 schema 解析后传给 notify
    expect(notify).toHaveBeenCalledWith("T", "B", "normal");
    expect(askApproval).not.toHaveBeenCalled();
    client.disconnect();
    await srv.close();
  });

  it("审计记录落盘为 JSONL", async () => {
    const srv = await startServer();
    const { client, events, deps } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await handshake(srv, events);
    srv.connections[0].send(
      JSON.stringify({
        kind: "tool_request",
        v: PROTOCOL_VERSION,
        id: "t5",
        tool: "notify",
        params: { title: "T", body: "B" },
        risk: "low",
        issuedAt: Date.now(),
      }),
    );
    await waitFor(
      () => srv.messages.find((m) => (m as { id?: string; kind?: string }).kind === "tool_result" && (m as { id?: string }).id === "t5"),
      "tool_result",
    );
    // 通过 client.getAuditLog() 读取内存审计
    expect(client.getAuditLog().recent(10)[0].id).toBe("t5");
    void deps;
    client.disconnect();
    await srv.close();
  });
});

// --- 心跳与重连 ---

describe("心跳与重连", () => {
  it("按 heartbeatMs 发送 ping（v=PROTOCOL_VERSION）", async () => {
    const srv = await startServer();
    const { client, events } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await handshake(srv, events);
    const ping = (await waitFor(
      () => srv.messages.find((m) => (m as { kind?: string }).kind === "ping"),
      "heartbeat ping",
    )) as { v: number };
    expect(ping.v).toBe(PROTOCOL_VERSION);
    client.disconnect();
    await srv.close();
  });

  it("收到 ping 回 pong", async () => {
    const srv = await startServer();
    const { client, events } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await handshake(srv, events);
    srv.connections[0].send(JSON.stringify({ kind: "ping", v: PROTOCOL_VERSION, ts: Date.now() }));
    const pong = (await waitFor(
      () => srv.messages.find((m) => (m as { kind?: string }).kind === "pong"),
      "pong",
    )) as { v: number };
    expect(pong.v).toBe(PROTOCOL_VERSION);
    client.disconnect();
    await srv.close();
  });

  it("断线后按 reconnectMs 自动重连", async () => {
    const srv = await startServer();
    const { client } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await waitFor(() => srv.messages.find((m) => (m as { kind?: string }).kind === "hello"), "hello1");
    srv.connections[0].close();
    await waitFor(
      () => (srv.messages.filter((m) => (m as { kind?: string }).kind === "hello").length >= 2 ? true : undefined),
      "hello2",
    );
    client.disconnect();
    await srv.close();
  });

  it("disconnect 后不再重连", async () => {
    const srv = await startServer();
    const { client } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await waitFor(() => srv.messages.find((m) => (m as { kind?: string }).kind === "hello"), "hello");
    client.disconnect();
    await sleep(200); // reconnectMs=50，若 closedByUser 失效会重连
    expect(srv.connections.length).toBe(1);
    await srv.close();
  });
});

// --- 非法信封 ---

describe("非法消息", () => {
  it("非 JSON 与非法信封被丢弃（不崩溃）", async () => {
    const srv = await startServer();
    const { client, events } = makeClient({ bridgeUrl: `ws://127.0.0.1:${srv.port}` });
    client.connect();
    await handshake(srv, events);
    srv.connections[0].send("not-json");
    srv.connections[0].send(JSON.stringify({ kind: "bogus", v: PROTOCOL_VERSION }));
    await sleep(100);
    expect(client.getAuditLog().recent(10)).toHaveLength(0);
    client.disconnect();
    await srv.close();
  });
});
