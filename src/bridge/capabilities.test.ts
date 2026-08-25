import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "./capabilities.js";
import { execFsRead, execFsWrite, execNotify, execShell } from "./capabilities.js";

// 同 scope 测试：目录先 realpath，规避 macOS /var -> /private/var 符号链接导致 withinRoots 误判
const base = realpathSync(mkdtempSync(join(tmpdir(), "zmzai-cap-")));
const root = join(base, "root");
const outside = join(base, "outside");

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

function ctx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    approvedRoots: [root],
    shellEnabled: true,
    execTimeoutMs: 5000,
    notify: vi.fn(),
    ...overrides,
  };
}

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("execFsRead", () => {
  it("读取文件内容（utf8）", async () => {
    const f = join(root, "a.txt");
    writeFileSync(f, "hello 世界");
    const r = await execFsRead(ctx(), { path: f, encoding: "utf8", maxBytes: 1_000_000 });
    expect(r.encoding).toBe("utf8");
    expect(r.content).toBe("hello 世界");
    expect(r.bytes).toBe(Buffer.byteLength("hello 世界"));
    expect(r.truncated).toBe(false);
  });

  it("超过 maxBytes 截断并标记 truncated", async () => {
    const f = join(root, "big.txt");
    writeFileSync(f, "abcdefghij");
    const r = await execFsRead(ctx(), { path: f, encoding: "utf8", maxBytes: 4 });
    expect(r.content).toBe("abcd");
    expect(r.truncated).toBe(true);
  });

  it("base64 编码读取", async () => {
    const f = join(root, "b.bin");
    writeFileSync(f, Buffer.from([0, 1, 2, 255]));
    const r = await execFsRead(ctx(), { path: f, encoding: "base64", maxBytes: 100 });
    expect(r.encoding).toBe("base64");
    expect(Buffer.from(r.content, "base64")).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("根外路径抛错（越界拦截）", async () => {
    const f = join(outside, "x.txt");
    writeFileSync(f, "x");
    await expect(execFsRead(ctx(), { path: f, encoding: "utf8", maxBytes: 100 })).rejects.toThrow(/越界/);
  });

  it("文件不存在抛错", async () => {
    await expect(execFsRead(ctx(), { path: join(root, "nope.txt"), encoding: "utf8", maxBytes: 100 })).rejects.toThrow();
  });
});

describe("execFsWrite", () => {
  it("写入文件（自动创建父目录）并返回字节数", async () => {
    const f = join(root, "sub/nested/w.txt");
    const r = await execFsWrite(ctx(), { path: f, encoding: "utf8", content: "hello" });
    expect(r.path).toBe(f);
    expect(r.bytes).toBe(5);
    expect(readFileSync(f, "utf8")).toBe("hello");
  });

  it("base64 内容写入", async () => {
    const f = join(root, "bin.dat");
    await execFsWrite(ctx(), { path: f, content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" });
    expect(readFileSync(f)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("根外路径抛错", async () => {
    await expect(execFsWrite(ctx(), { path: join(outside, "e.txt"), encoding: "utf8", content: "x" })).rejects.toThrow(/越界/);
  });
});

describe("execShell", () => {
  it("SHELL_ENABLED=false 时拒绝执行", async () => {
    await expect(execShell(ctx({ shellEnabled: false }), { command: "echo hi" })).rejects.toThrow(/未启用/);
  });

  it("执行成功返回 stdout", async () => {
    const r = await execShell(ctx(), { command: "echo hello" });
    expect(r.stdout.trim()).toBe("hello");
    expect(r.truncated).toBe(false);
  });

  it("非零退出返回 stderr（视为已执行）", async () => {
    const r = await execShell(ctx(), { command: "sh -c 'echo boom >&2; exit 3'" });
    expect(r.stderr).toContain("boom");
    expect(r.stdout).toBe("");
  });

  it("超过 timeoutMs 抛超时错误", async () => {
    await expect(execShell(ctx({ execTimeoutMs: 300 }), { command: "sleep 2" })).rejects.toThrow(/超时/);
  });

  it("cwd 越界抛错", async () => {
    await expect(execShell(ctx(), { command: "pwd", cwd: join(outside, "x") })).rejects.toThrow(/越界/);
  });
});

describe("execNotify", () => {
  it("调用 notify 并返回 delivered", async () => {
    const notify = vi.fn();
    const r = await execNotify(ctx({ notify }), { title: "T", body: "B", urgency: "critical" });
    expect(notify).toHaveBeenCalledWith("T", "B", "critical");
    expect(r.delivered).toBe(true);
  });
});
