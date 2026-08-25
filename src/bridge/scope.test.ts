import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRoots, withinRoots } from "./scope.js";

// 注意：macOS 的 os.tmpdir() 是 /var/folders/...（符号链接到 /private/var/folders），
// withinRoots 会对真实存在的目标做 realpath，导致相对未 realpath 的 root 误判越界，
// 因此测试目录一律先 realpath（与生产 APPROVED_ROOTS=~/... 非符号链接路径的行为一致）。
const base = realpathSync(mkdtempSync(join(tmpdir(), "zmzai-scope-")));
const root = join(base, "root");
const outside = join(base, "outside");

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveRoots", () => {
  it("展开 ~ 为 home 目录", () => {
    expect(resolveRoots(["~/x"])).toEqual([resolve(join(homedir(), "x"))]);
  });

  it("相对路径基于 cwd 解析，绝对路径原样", () => {
    const [rel, abs] = resolveRoots(["sub/dir", "/abs/path"]);
    expect(rel).toBe(resolve("sub/dir"));
    expect(abs).toBe("/abs/path");
  });
});

describe("withinRoots", () => {
  it("根目录内的绝对路径放行", () => {
    const target = join(root, "a/b.txt");
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(target, "x");
    expect(withinRoots([root], target)).toBe(realpathSync(target));
  });

  it("相对目标基于根目录解析", () => {
    const abs = withinRoots([root], "a/b.txt");
    expect(abs).toBe(join(root, "a/b.txt"));
  });

  it("正好落在根目录上放行", () => {
    expect(withinRoots([root], root)).toBe(root);
  });

  it("根目录外（../）拒绝", () => {
    expect(() => withinRoots([root], "../outside")).toThrow(/越界/);
  });

  it("绝对路径在根外拒绝", () => {
    expect(() => withinRoots([root], outside)).toThrow(/越界/);
    expect(() => withinRoots([root], "/etc/passwd")).toThrow(/越界/);
  });

  it("多个根中任一命中即放行", () => {
    expect(withinRoots([root, outside], join(outside, "x"))).toBe(join(outside, "x"));
  });

  it("符号链接逃逸到根外被拦截", () => {
    const link = join(root, "escape-link");
    const victim = join(outside, "secret.txt");
    writeFileSync(victim, "top secret");
    symlinkSync(victim, link);
    expect(() => withinRoots([root], link)).toThrow(/越界/);
  });
});
