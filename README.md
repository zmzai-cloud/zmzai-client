# zmzai 客户端 · 云端 Agent 的本地伴侣 / 桥接器

Electron 桌面客户端。它是 **云端 Agent 在用户本机上的执行端点**：云端 Agent 经安全桥接下发
`文件读写 / 命令执行 / 系统通知` 等请求，本机客户端在**本地审批与审计**后执行，再把结果回传云端。

一句话定位：**云端 Agent 在本机的受限执行端点**。云端沙箱（`zmzai-sandbox`）在云端容器内执行、不经本桥；
只有当 Agent 需要操作**用户自己的机器**（本机文件 / 本机命令 / 通知）时才走这条桥——且每次执行都由用户说了算。

---

## 架构

```
┌──────────────┐  出站 WebSocket(反向隧道)  ┌──────────────────┐
│  zmzai 客户端 │ ──── hello(签名) ───────▶ │  云端桥接端点      │
│  (Electron)  │ ◀── welcome + tool_request─│  b.zmzai.cloud    │
│              │ ──── tool_result(审计) ───▶ │  (→ zmzai-agent)  │
│  本地能力:    │                            └──────────────────┘
│  fs.read/write│
│  shell.exec   │  ← 审批弹窗 + 越界拦截 + 审计落盘
│  notify       │
└──────────────┘
```

- 客户端主动建立**出站**连接，天然穿透 NAT/防火墙（云端无需知道客户端 IP）。
- 所有交互包裹在 `src/shared/protocol.ts` 定义的统一信封里，带版本号与 HMAC 握手签名。
- 文件操作被限制在用户**批准的目录根**内；`shell.exec` 默认关闭，开启后仍需逐条审批。
- 每一次执行都写入本地审计日志（`userData/audit.jsonl`），可事后复盘。

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/shared/protocol.ts` | 桥接协议（信封 / 工具入参 / 审计记录，纯 zod） |
| `src/bridge/sign.ts` | HMAC 握手签名 |
| `src/bridge/scope.ts` | 路径越界拦截（限制在批准根目录内） |
| `src/bridge/capabilities.ts` | 本地能力执行：fs / shell / notify |
| `src/bridge/audit.ts` | 追加式审计日志 |
| `src/bridge/bridge-client.ts` | 桥接核心：连接、握手、心跳、重连、审批路由 |
| `src/main/index.ts` | Electron 主进程：窗口、托盘、IPC、装配桥接 |
| `src/preload/index.ts` | 安全 IPC 桥（contextIsolation） |
| `src/renderer/` | React 控制面板：连接状态 / 审批弹窗 / 审计 / 设置 |
| `scripts/mock-bridge.mjs` | 本地 mock 云端桥接，用于无云端 E2E 自测 |

## 本地运行（无需云端）

```bash
cd zmzai-client
cp .env.example .env          # 默认对接本地 mock（ws://localhost:8787）

# 终端 1：启动 mock 云端
pnpm install
pnpm mock

# 终端 2：启动客户端（会自动连接 mock 并跑演示序列）
pnpm dev
```

> 想一键起 mock + 客户端：`pnpm dev:mock`
> 沙箱内无法下载 Electron 二进制时，可加 `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` 仅做类型检查/构建验证。

### 演示序列会自动验证
1. `fs.write` 在批准目录写 `demo.txt`（需审批 → 允许）
2. `fs.read` 读回（低风险自动放行）
3. `notify` 弹系统通知
4. `shell.exec`（默认被本地策略拦截，返回未启用；设置里开启 shell 后会弹审批）

## 配置（.env）

| 变量 | 说明 |
| --- | --- |
| `BRIDGE_URL` | 云端桥接端点（生产用 `wss://b.zmzai.cloud/bridge`） |
| `CLIENT_ID` / `CLIENT_SECRET` | 云端签发的客户端身份与签名密钥 |
| `USER_ID` | 本机归属的用户标识，hello 中携带（签名覆盖）——云端据此把 Agent 请求路由到本机 |
| `APPROVED_ROOTS` | 允许云端读写的目录根（逗号分隔，支持 `~`） |
| `SHELL_ENABLED` | 是否允许 shell.exec（默认 false） |
| `EXEC_TIMEOUT_MS` | 单次命令/文件操作超时 |

## 安全模型（要点）

- **出站优先**：客户端连云端，云端不连客户端，规避防火墙/暴露面。
- **越界即拒**：文件操作经 `withinRoots` 校验，符号链接逃逸也会被拦。
- **审批分级**：`fs.write`/`shell.exec` 必须用户授权；`fs.read` 低风险自动放行；`notify` 自动。
- **审计不可删**：每次执行落盘 JSONL，含决策人（auto/user）、风险、耗时。
- **密钥不下发**：`CLIENT_SECRET` 仅存客户端，用于给请求签名；云端用对称/非对称密钥验签。

## 生产化待办（落地前）

- [ ] `BRIDGE_URL` 强制 `wss`，并校验证书。
- [ ] 握手升级为**非对称**：云端用私钥签 `welcome`，客户端用预置公钥验签（防伪造端点）。
- [ ] 云端侧实现**会话路由**：一个 Client 对应一条出站隧道，云端 Agent 的请求按 `userId` 路由（bridge 侧已完成，待 relay 侧打通 `userId ↔ agent 会话`）。
- [ ] 审批增加**超时默认拒绝**与「本次会话记住选择」。
- [ ] 审计日志加密存储 / 可选上链存证（对齐 Arena 的「决策存证」思路）。

Apache-2.0 · 知末智云
