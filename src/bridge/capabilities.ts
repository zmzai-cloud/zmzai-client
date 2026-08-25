import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  FsReadParams,
  FsWriteParams,
  NotifyParams,
  ShellExecParams,
} from "../shared/protocol.js";
import { withinRoots } from "./scope.js";

const execP = promisify(exec);

export interface CapabilityContext {
  approvedRoots: string[];
  shellEnabled: boolean;
  execTimeoutMs: number;
  notify: (title: string, body: string, urgency?: "low" | "normal" | "critical") => void;
}

const MAX_OUTPUT = 50_000;

export async function execFsRead(ctx: CapabilityContext, p: FsReadParams) {
  const abs = withinRoots(ctx.approvedRoots, p.path);
  const buf = readFileSync(abs);
  if (p.encoding === "base64") {
    const slice = buf.subarray(0, p.maxBytes);
    return { encoding: "base64", bytes: slice.length, content: slice.toString("base64") };
  }
  const text = buf.toString("utf8");
  const truncated = text.length > p.maxBytes;
  return {
    encoding: "utf8",
    bytes: buf.length,
    truncated,
    content: truncated ? text.slice(0, p.maxBytes) : text,
  };
}

export async function execFsWrite(ctx: CapabilityContext, p: FsWriteParams) {
  const abs = withinRoots(ctx.approvedRoots, p.path);
  mkdirSync(dirname(abs), { recursive: true });
  const content = p.encoding === "base64" ? Buffer.from(p.content, "base64") : p.content;
  writeFileSync(abs, content);
  return { path: abs, bytes: Buffer.byteLength(p.content, p.encoding === "base64" ? "base64" : "utf8") };
}

export async function execShell(ctx: CapabilityContext, p: ShellExecParams) {
  if (!ctx.shellEnabled) {
    throw new Error("shell.exec 未启用（SHELL_ENABLED=false）");
  }
  const cwd = p.cwd ? withinRoots(ctx.approvedRoots, p.cwd) : undefined;
  const timeout = p.timeoutMs ?? ctx.execTimeoutMs;
  try {
    const { stdout, stderr } = await execP(p.command, { cwd, timeout, maxBuffer: 5_000_000 });
    const out = String(stdout ?? "");
    const errOut = String(stderr ?? "");
    return {
      stdout: out.slice(0, MAX_OUTPUT),
      stderr: errOut.slice(0, MAX_OUTPUT),
      truncated: out.length + errOut.length > MAX_OUTPUT,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    // exec 超时：Node 抛的错 code 为 null，标志是 killed=true + signal（不是 ETIMEDOUT）
    if (e.killed || e.signal === "SIGTERM" || e.signal === "SIGKILL") {
      throw new Error(`命令超时（>${timeout}ms）`);
    }
    // 命令非零退出视为已执行，带 stderr 返回；真正异常（无 stdout/stderr）才抛出
    if (e.stdout === undefined && e.stderr === undefined) throw e;
    const out = String(e.stdout ?? "");
    const errOut = String(e.stderr ?? "");
    return {
      stdout: out.slice(0, MAX_OUTPUT),
      stderr: errOut.slice(0, MAX_OUTPUT),
      truncated: out.length + errOut.length > MAX_OUTPUT,
    };
  }
}

export async function execNotify(ctx: CapabilityContext, p: NotifyParams) {
  ctx.notify(p.title, p.body, p.urgency);
  return { delivered: true };
}
