import { app, BrowserWindow } from "electron";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientConfig } from "../src/bridge/config.js";
import { BridgeRuntime } from "../src/main/bridge-runtime.js";
import { TestBridge } from "./test-bridge.js";

const BRIDGE_PORT = 8799;
const SECRET = "e2e-secret";
const APPROVAL_TIMEOUT_MS = 400;

interface Scenario {
  name: string;
  pass: boolean;
  detail: string;
}

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
  app.disableHardwareAcceleration();
  await app.whenReady();

  const root = realpathSync(mkdtempSync(join(tmpdir(), "zmzai-e2e-")));
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
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
    approvedRoots: [root],
    shellEnabled: false,
    execTimeoutMs: 5000,
  };

  const bridge = new TestBridge(BRIDGE_PORT, SECRET);

  let mainWindow: BrowserWindow | null = null;
  const runtime = new BridgeRuntime(
    () => mainWindow,
    (t, b) => console.log(`[notify] ${t}: ${b}`),
    () => config,
  );
  runtime.setApprovalTimeoutMs(APPROVAL_TIMEOUT_MS);

  // 隐藏窗口 + 真实 preload，使 window.zmzai.resolveApproval 可用（走真实 IPC 审批通道）
  mainWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: join(__dirname, "../out/preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await mainWindow.loadURL("about:blank");
  await mainWindow.webContents.executeJavaScript(
    "new Promise((res) => { const c = () => (window.zmzai ? res(true) : setTimeout(c, 20)); c(); })",
  );

  runtime.registerIpc();
  runtime.bridge = runtime.buildBridge();
  runtime.bridge.connect();

  const scenarios: Scenario[] = [];

  try {
    await waitFor(() => (bridge.connected ? true : undefined), "客户端连上测试桥", 8000);

    // 场景 A：fs.read 低风险 → 自动执行（auto）
    {
      const id = bridge.sendTool("fs.read", { path: readSrc }, "low");
      const res = await waitFor(() => bridge.getResult(id), `tool_result ${id}`, 8000);
      const data = res.data as { content?: string } | undefined;
      const pass =
        res.ok === true &&
        res.audit?.decidedBy === "auto" &&
        typeof data?.content === "string" &&
        data.content.includes("e2e-read-content");
      scenarios.push({ name: "auto：fs.read 低风险自动执行", pass, detail: `decidedBy=${res.audit?.decidedBy} ok=${res.ok}` });
    }

    // 场景 B：fs.write 高风险 → 用户批准（user），文件真实落盘
    {
      const id = bridge.sendTool("fs.write", { path: targetApprove, content: "approved-by-user" }, "high");
      await waitFor(() => (runtime.isPending(id) ? true : undefined), `pending ${id}`, 4000);
      await mainWindow!.webContents.executeJavaScript(
        `window.zmzai.resolveApproval(${JSON.stringify(id)}, true)`,
      );
      const res = await waitFor(() => bridge.getResult(id), `tool_result ${id}`, 8000);
      const fileOk = existsSync(targetApprove) && readFileSync(targetApprove, "utf8") === "approved-by-user";
      const pass = res.ok === true && res.audit?.decidedBy === "user" && fileOk;
      scenarios.push({ name: "user：fs.write 批准执行", pass, detail: `decidedBy=${res.audit?.decidedBy} ok=${res.ok} file=${fileOk}` });
    }

    // 场景 C：fs.write 高风险 → 用户拒绝（user），文件不应落盘
    {
      const id = bridge.sendTool("fs.write", { path: targetReject, content: "rejected-by-user" }, "high");
      await waitFor(() => (runtime.isPending(id) ? true : undefined), `pending ${id}`, 4000);
      await mainWindow!.webContents.executeJavaScript(
        `window.zmzai.resolveApproval(${JSON.stringify(id)}, false)`,
      );
      const res = await waitFor(() => bridge.getResult(id), `tool_result ${id}`, 8000);
      const fileAbsent = !existsSync(targetReject);
      const pass = res.ok === false && res.audit?.decidedBy === "user" && fileAbsent;
      scenarios.push({ name: "user：fs.write 拒绝不执行", pass, detail: `decidedBy=${res.audit?.decidedBy} ok=${res.ok} absent=${fileAbsent}` });
    }

    // 场景 D：fs.write 高风险 → 不处理，超时策略兜底（policy），文件不应落盘
    {
      const id = bridge.sendTool("fs.write", { path: targetPolicy, content: "policy-timeout" }, "high");
      // 故意不审批；等待超过 APPROVAL_TIMEOUT_MS 后客户端按策略默认拒绝
      const res = await waitFor(() => bridge.getResult(id), `tool_result(policy) ${id}`, 8000);
      const fileAbsent = !existsSync(targetPolicy);
      const pass = res.ok === false && res.audit?.decidedBy === "policy" && fileAbsent;
      scenarios.push({ name: "policy：超时默认拒绝", pass, detail: `decidedBy=${res.audit?.decidedBy} ok=${res.ok} absent=${fileAbsent}` });
    }
  } catch (err) {
    scenarios.push({ name: "运行异常", pass: false, detail: err instanceof Error ? err.message : String(err) });
  } finally {
    mainWindow?.destroy();
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  }

  let allPass = true;
  for (const s of scenarios) {
    if (!s.pass) allPass = false;
    console.log(`${s.pass ? "[PASS]" : "[FAIL]"} ${s.name} — ${s.detail}`);
  }
  console.log(allPass ? "\nE2E 全部通过 ✅" : "\nE2E 存在失败 ❌");
  return allPass ? 0 : 1;
}

main()
  .then((code) => app.exit(code))
  .catch((err) => {
    console.error("E2E 运行失败：", err);
    app.exit(1);
  });
