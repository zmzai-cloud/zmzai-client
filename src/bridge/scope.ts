import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/** 把 `~` 与相对路径解析为绝对路径 */
export function resolveRoots(raw: string[]): string[] {
  return raw.map((r) => {
    const expanded = r.startsWith("~") ? r.replace(/^~/, homedir()) : r;
    return resolve(expanded);
  });
}

/**
 * 把目标路径限制在某一个已批准根目录内。
 * 即便目标经符号链接逃逸也会被拦下（存在则 realpath 后再校验）。
 * 越界一律抛错 —— 这是本地伴侣的安全底线。
 */
export function withinRoots(roots: string[], target: string): string {
  for (const root of roots) {
    let abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
    if (existsSync(abs)) {
      try {
        abs = realpathSync(abs);
      } catch {
        /* 竞态：文件刚被删，按解析路径继续校验 */
      }
    }
    const rel = relative(root, abs);
    // rel === "" 表示正好落在根目录（允许）；否则必须在根之内
    if (!rel.startsWith("..")) return abs;
  }
  throw new Error("路径不在任何已批准目录内（已拦截越界访问）");
}
