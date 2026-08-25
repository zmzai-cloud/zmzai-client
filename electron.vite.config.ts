import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Electron 33 内置 Node 20.18.3 在「ESM 主进程 import CJS 依赖」时会崩于
// cjsPreparseModuleExports。根 package.json 是 type:module，electron-vite 默认把
// main/preload 编译成 ESM，加载时走 ESM→CJS preparse 即触发该 regression。
// 解决：主进程/预加载产物改为 CommonJS，并在 out/ 放一个 {"type":"commonjs"} 的
// package.json，让 Electron 按 CJS 加载，彻底绕开 ESM 加载器。
const cjsPackageJson = {
  name: "zmzai-client-out",
  version: "0.0.0",
  private: true,
  type: "commonjs",
};

/** 打包后写入 out/package.json，覆盖根 type:module，使产物按 CommonJS 加载 */
function emitCjsPackageJson() {
  return {
    name: "emit-cjs-package-json",
    writeBundle() {
      const outPkg = resolve(process.cwd(), "out", "package.json");
      if (!existsSync(resolve(process.cwd(), "out"))) {
        mkdirSync(resolve(process.cwd(), "out"), { recursive: true });
      }
      writeFileSync(outPkg, JSON.stringify(cjsPackageJson, null, 2) + "\n");
    },
    closeBundle() {
      const outPkg = resolve(process.cwd(), "out", "package.json");
      if (!existsSync(resolve(process.cwd(), "out"))) {
        mkdirSync(resolve(process.cwd(), "out"), { recursive: true });
      }
      writeFileSync(outPkg, JSON.stringify(cjsPackageJson, null, 2) + "\n");
    },
  };
}

export default defineConfig({
  main: {
    plugins: [emitCjsPackageJson()],
    build: {
      rollupOptions: {
        external: ["electron", "ws"],
        output: {
          format: "cjs",
          entryFileNames: "index.js",
          chunkFileNames: "chunks/[name].js",
        },
      },
    },
  },
  preload: {
    plugins: [emitCjsPackageJson()],
    build: {
      rollupOptions: {
        external: ["electron"],
        output: {
          format: "cjs",
          entryFileNames: "index.js",
          chunkFileNames: "chunks/[name].js",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      rollupOptions: {
        input: "src/renderer/index.html",
      },
    },
    plugins: [react()],
  },
});
