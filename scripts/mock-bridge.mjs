/**
 * 本地 mock 云端桥接服务（仅用于无云端依赖的端到端自测）
 *
 * 启动：node scripts/mock-bridge.mjs
 * 客户端侧把 BRIDGE_URL 设为 ws://localhost:8787 即可对接。
 * 它会校验客户端握手签名，然后自动下发一组演示请求（写文件→读文件→通知→shell），
 * 用来验证本地能力执行、审批弹窗与审计落盘是否正常工作。
 */
import { WebSocketServer } from "ws";
import { createHmac } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const SECRET = process.env.CLIENT_SECRET ?? "change-me-in-production";

function sign(subject, ts) {
  return createHmac("sha256", SECRET).update(`${subject}:${ts}`).digest("hex");
}

const wss = new WebSocketServer({ port: PORT });
let seq = 0;
const nextId = () => `mock-${Date.now()}-${seq++}`;

function sendRequest(ws, tool, params, risk) {
  if (ws.readyState !== ws.OPEN) return;
  const id = nextId();
  ws.send(
    JSON.stringify({ kind: "tool_request", v: 2, id, tool, params, risk, issuedAt: Date.now() }),
  );
  console.log(`[mock] 下发 ${tool} (${id})`);
}

wss.on("connection", (ws) => {
  console.log("[mock] 客户端已连接");
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.kind === "hello") {
      // v2：签名覆盖 clientId:userId:ts，userId 声明本机归属用户
      const expect = sign(`${msg.clientId}:${msg.userId}`, msg.ts);
      if (msg.signature !== expect) {
        console.log("[mock] 握手签名校验失败，断开");
        ws.close();
        return;
      }
      const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
      const ts = Date.now();
      ws.send(
        JSON.stringify({
          kind: "welcome",
          v: 2,
          sessionId,
          userId: msg.userId,
          ts,
          signature: sign(sessionId, ts),
        }),
      );
      console.log(`[mock] 握手成功，session=${sessionId} userId=${msg.userId}`);

      // 演示序列：写文件 → 读回 → 通知 → shell（默认会被本地策略拦截）
      setTimeout(() => sendRequest(ws, "fs.write", { path: "demo.txt", content: `hello from cloud @ ${new Date().toISOString()}` }, "medium"), 800);
      setTimeout(() => sendRequest(ws, "fs.read", { path: "demo.txt" }, "low"), 1800);
      setTimeout(() => sendRequest(ws, "notify", { title: "zmzai 客户端", body: "云端任务已完成 ✅" }, "low"), 2800);
      setTimeout(() => sendRequest(ws, "shell.exec", { command: "echo zmzai-bridge" }, "high"), 3800);
    } else if (msg.kind === "tool_result") {
      console.log(`[mock] 结果 ${msg.id} ok=${msg.ok}`, msg.ok ? "" : `err=${msg.error}`);
    } else if (msg.kind === "ping") {
      ws.send(JSON.stringify({ kind: "pong", v: 2, ts: Date.now() }));
    }
  });
  ws.on("close", () => console.log("[mock] 客户端断开"));
});

console.log(`[mock] 桥接服务已启动：ws://localhost:${PORT}（secret=${SECRET}）`);
