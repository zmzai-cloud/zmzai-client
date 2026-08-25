import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, ApprovalRequest } from "../src/bridge/bridge-client.js";
import type { ClientConfig } from "../src/bridge/config.js";
import { BridgeClient } from "../src/bridge/bridge-client.js";
import { TestBridge } from "./test-bridge.js";

const BRIDGE_PORT = 8801;
const SECRET = "e2e-secret";
const POLICY_DELAY_MS = 300;
type Decision = "approve" | "reject" | "policy";

async function waitFor<T>(get: () => T | undefined, label: string, timeout = 6000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor 超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function main(): Promise<number> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zmzai-e2e-node-")));
  const readSrc = join(root, "read-src.txt");
  writeFileSync(readSrc, "e2e-read-content");
  const targetApprove = join(root, "written-approved.txt");
  const targetReject = join(root, "written-rejected.txt");
  const targetPolicy = join(root, "written-policy.txt");

  const config: ClientConfig = {
    bridgeUrl: `ws://127.0.0.1:${BRIDGE_PORT}`,
    clientId: "e2e-client",
    clientSecret: SECRET,
    userId: "e2e-user",
    bridgePublicKeyPem: null,
    allowInsecureWs: true,
    approvalTimeoutMs: 120_000,
    approvedRoots: [root],
    shellEnabled: false,
    execTimeoutMs: 5000,
  };

  const bridge = new TestBridge(BRIDGE_PORT, SECRET);
  const decisions = new Map<string, Decision>();

  // 此处 askApproval 忠实复刻 BridgeRuntime 的决策映射（无 Electron 窗口）：
  // approve/reject → user；policy → 模拟超时兜底。真实窗口/IPC 分支由 pnpm e2e 在真机覆盖。
  const askApproval = (req: ApprovalRequest): Promise<ApprovalDecision> =>
    new Promise<ApprovalDecision>((resolve) => {
      const d = decisions.get(req.id);
      if (d === "approve") return resolve({ allowed: true, decidedBy: "user" });
      if (d === "reject") return resolve({ allowed: false, decidedBy: "user" });
      // policy：模拟审批超时，策略默认拒绝（与真实 askApproval 超时分支同结果）
      return setTimeout(() => resolve({ allowed: false, decidedBy: "policy" }), POLICY_DELAY_MS);
    });

  const client = new BridgeClient(
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
      notify: () => {},
      askApproval,
      onEvent: () => {},
    },
    join(root, "audit.jsonl"),
  );
  client.connect();

  const scenarios: Array<{ name: string; pass: boolean; detail: string }> = [];

  try {
    await waitFor(() => (bridge.connected ? true : undefined), "客户端连上测试桥", 8000);

    // A：fs.read 低风险自动执行
    {
      const id = bridge.sendTool("fs.read", { path: readSrc }, "low");
      const res = await waitFor(() => bridge.getResult(id), `tool_result ${id}`, 8000);
      const data = res.data as { content?: string } | undefined;
      const pass =
        res.ok === true && res.audit?.decidedBy === "auto" && Boolean(data?.content?.includes("e2e-read-content"));
      scenarios.push({ name: "auto：fs.read 低风险自动执行", pass, detail: `decidedBy=${res.audit?.decidedBy} ok=${res.ok}` });
    }

    // B：fs.write 批准 → 文件落盘
    {
      const id = bridge.sendTool("fs.write", { path: targetApprove, content: "approved-by-user" }, "high");
      decisions.set(id, "approve");
      const res = await waitFor(() => bridge.getResult(id), `tool_result ${id}`, 8000);
      const fileOk = existsSync(targetApprove) && readFileSync(targetApprove, "utf8") === "approved-by-user";
      const pass = res.ok === true && res.audit?.decidedBy === "user" && fileOk;
      scenarios.push({ name: "user：fs.write 批准执行", pass, detail: `decidedBy=${res.audit?.decidedBy} ok=${res.ok} file=${fileOk}` });
    }

    // C：fs.write 拒绝 → 不落盘
    {
      const id = bridge.sendTool("fs.write", { path: targetReject, content: "rejected-by-user" }, "high");
      decisions.set(id, "reject");
      const res = await waitFor(() => bridge.getResult(id), `tool_result ${id}`, 8000);
      const absent = !existsSync(targetReject);
      const pass = res.ok === false && res.audit?.decidedBy === "user" && absent;
      scenarios.push({ name: "user：fs.write 拒绝不执行", pass, detail: `decidedBy=${res.audit?.decidedBy} ok=${res.ok} absent=${absent}` });
    }

    // D：fs.write 超时策略兜底 → 不落盘
    {
      const id = bridge.sendTool("fs.write", { path: targetPolicy, content: "policy-timeout" }, "high");
      decisions.set(id, "policy");
      const res = await waitFor(() => bridge.getResult(id), `tool_result(policy) ${id}`, 8000);
      const absent = !existsSync(targetPolicy);
      const pass = res.ok === false && res.audit?.decidedBy === "policy" && absent;
      scenarios.push({ name: "policy：超时默认拒绝", pass, detail: `decidedBy=${res.audit?.decidedBy} ok=${res.ok} absent=${absent}` });
    }
  } catch (err) {
    scenarios.push({ name: "运行异常", pass: false, detail: err instanceof Error ? err.message : String(err) });
  } finally {
    client.disconnect();
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  }

  let allPass = true;
  for (const s of scenarios) {
    if (!s.pass) allPass = false;
    console.log(`${s.pass ? "[PASS]" : "[FAIL]"} ${s.name} — ${s.detail}`);
  }
  console.log(allPass ? "\n无头协议 E2E 全部通过 ✅" : "\n无头协议 E2E 存在失败 ❌");
  return allPass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("E2E(node) 运行失败：", err);
    process.exit(1);
  });
