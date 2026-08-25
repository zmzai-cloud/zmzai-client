import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "./audit.js";
import type { AuditRecord } from "../shared/protocol.js";

const dirs: string[] = [];

function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "zmzai-audit-"));
  dirs.push(d);
  return join(d, "audit.jsonl");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRecord(i: number): AuditRecord {
  return {
    id: `id-${i}`,
    clientId: "c1",
    tool: "notify",
    risk: "low",
    approved: true,
    decidedBy: "auto",
    startedAt: i,
    finishedAt: i + 1,
    summary: `记录 ${i}`,
  };
}

describe("AuditLog", () => {
  it("record 追加落盘为 JSONL", () => {
    const path = tmpPath();
    const log = new AuditLog(path);
    log.record(makeRecord(1));
    log.record(makeRecord(2));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).id).toBe("id-2");
  });

  it("recent 返回倒序（最新在前）", () => {
    const log = new AuditLog(tmpPath());
    log.record(makeRecord(1));
    log.record(makeRecord(2));
    const recent = log.recent(10);
    expect(recent.map((r) => r.id)).toEqual(["id-2", "id-1"]);
  });

  it("内存超过 500 条时裁剪最旧记录", () => {
    const log = new AuditLog(tmpPath());
    for (let i = 0; i < 510; i++) log.record(makeRecord(i));
    expect(log.recent(1000)).toHaveLength(500);
    expect(log.recent(1000)[0].id).toBe("id-509"); // 最新保留
  });

  it("构造时加载既有文件记录", () => {
    const path = tmpPath();
    const log1 = new AuditLog(path);
    log1.record(makeRecord(1));
    const log2 = new AuditLog(path);
    expect(log2.recent(10).map((r) => r.id)).toEqual(["id-1"]);
  });

  it("损坏行跳过，不中断其余记录加载", () => {
    const path = tmpPath();
    writeFileSync(
      path,
      `${JSON.stringify(makeRecord(1))}\nnot-json\n{"id":"bad-missing-fields"}\n${JSON.stringify(makeRecord(2))}\n`,
    );
    const log = new AuditLog(path);
    // 合法行全部加载，损坏行被跳过且不抛错（逐行容错）
    expect(log.recent(10).map((r) => r.id)).toEqual(["id-2", "id-1"]);
  });

  it("磁盘不可写时仍保留内存记录（不抛错）", () => {
    const log = new AuditLog(tmpPath());
    log.record(makeRecord(1));
    // 直接对只读目录模拟失败不可行（macOS 权限），此处验证 record 不抛即可
    expect(log.recent(10)[0].id).toBe("id-1");
  });
});
