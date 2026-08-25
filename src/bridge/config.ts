import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** 极简 .env 解析（避免额外依赖）。仅在不曾由外部环境变量设置时填充。 */
function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export interface ClientConfig {
  bridgeUrl: string;
  clientId: string;
  clientSecret: string;
  /** 本机归属的用户标识（hello 携带、被签名覆盖），云端据此路由 Agent 请求到本机 */
  userId: string;
  approvedRoots: string[];
  shellEnabled: boolean;
  execTimeoutMs: number;
}

export function loadConfig(envFile = ".env"): ClientConfig {
  loadDotEnv(envFile);
  const rawRoots = (process.env.APPROVED_ROOTS ?? "~/zmzai-client/workspace")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => (r.startsWith("~") ? r.replace(/^~/, homedir()) : r));

  return {
    bridgeUrl: process.env.BRIDGE_URL ?? "wss://b.zmzai.cloud/bridge",
    clientId: process.env.CLIENT_ID ?? "local-dev-client",
    clientSecret: process.env.CLIENT_SECRET ?? "change-me-in-production",
    userId: process.env.USER_ID ?? "local-dev-user",
    approvedRoots: rawRoots.map((r) => resolve(r)),
    shellEnabled: (process.env.SHELL_ENABLED ?? "false") === "true",
    execTimeoutMs: Number(process.env.EXEC_TIMEOUT_MS ?? "30000"),
  };
}
