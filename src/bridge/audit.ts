import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { AuditRecord } from "../shared/protocol.js";

/**
 * 追加式审计日志：每次工具执行都落盘为 JSONL，并在内存保留最近 500 条供 UI 展示。
 */
export class AuditLog {
  private mem: AuditRecord[] = [];
  private path: string;

  constructor(path: string) {
    this.path = path;
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* 忽略目录创建失败，后续落盘会报错但不影响运行 */
    }
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.mem.push(AuditRecord.parse(JSON.parse(line)));
        } catch {
          /* 损坏行跳过，不中断其余记录加载 */
        }
      }
    }
  }

  record(r: AuditRecord): void {
    this.mem.push(r);
    if (this.mem.length > 500) this.mem.shift();
    try {
      appendFileSync(this.path, JSON.stringify(r) + "\n");
    } catch {
      /* 磁盘不可写时仅保留内存记录 */
    }
  }

  recent(n = 100): AuditRecord[] {
    return this.mem.slice(-n).reverse();
  }
}
