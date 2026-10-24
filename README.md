# 麦门饭局调解所 · mcd-mediation-rpg

一个结合轻 RPG 游戏化交互、多人点餐协商和麦当劳 MCP 的 AI Web 应用。

**当前阶段：前端 Demo 与 UI、动效已完成本轮实现，待接入后端。** 已包含五页面流程、定稿角色与选中姿态、个人属性设置、示例方案和弹窗复议。
全部数据与调解均在浏览器本地演示；尚未接入真实麦当劳 MCP、AI、优惠或下单接口。
同一设备配置 2—4 位成员，无需线上房间。交互规则与后端交接见 [第一轮 Demo](docs/demo-round-one.md)。

## 技术结构

采用 npm workspaces 管理前后端：前端为 React + Vite + TypeScript，服务端为
Node.js 原生 HTTP + TypeScript，暂不引入业务框架、数据库或 MCP / AI SDK。

```text
mcd-mediation-rpg/
├── apps/
│   ├── web/
│   │   ├── public/
│   │   └── src/
│   │       ├── pages/          # 页面预留
│   │       ├── components/     # 通用组件预留
│   │       ├── hooks/          # React hooks 预留
│   │       ├── services/       # 前端 API 调用预留
│   │       ├── assets/         # 静态资源预留
│   │       └── styles/         # 基础样式
│   └── server/
│       └── src/
│           ├── routes/         # HTTP 路由预留
│           ├── mcp/            # 麦当劳 MCP 接入预留
│           ├── ai/             # AI 推荐逻辑预留
│           ├── services/       # 后端服务预留
│           └── config/         # 配置预留
├── packages/shared/src/        # 共享类型与接口契约预留，尚未建包
├── docs/                       # 需求与架构文档预留
├── .github/                    # CI 和 PR 模板
├── .env.example                # 无凭据的环境变量示例
└── CONTRIBUTING.md             # 双人分工及分支协作约定
```

空目录通过 `.gitkeep` 纳入版本管理。

## 环境要求

- Node.js 24.12.0（见 `.nvmrc`；支持 24.12.0 及以上的 Node.js 24 版本）
- npm 11（初始化环境为 11.6.2）
- Git；GitHub CLI 用于 GitHub 登录和仓库管理

## 本地启动

在仓库根目录执行：

```sh
npm ci
```

可选：复制示例配置为根目录 `.env`。不复制也能使用默认端口启动。

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```sh
# macOS / Linux
cp .env.example .env
```

```sh
# 同时启动前后端
npm run dev
```

前端地址为 `http://127.0.0.1:5173`，可独立运行五页面 Demo；首页可载入三人示例。
服务端默认监听 `http://127.0.0.1:3001`，所有路径返回 404，尚无业务接口。
Vite 已预留 `/api` 开发代理，目标随根目录 `.env` 中的服务端地址和端口调整。

也可以分别运行：

```sh
npm run dev:web
npm run dev:server
```

手机预览：电脑与手机连接同一可信 Wi-Fi，在根目录运行：

```sh
npm run dev:mobile
```

在手机浏览器打开终端打印的 `Network` 地址。`127.0.0.1` 只适用于当前设备，不能把电脑上的该地址直接发给手机。
该命令仅用于本地联调，会让开发服务监听网络接口；默认 `dev:web` 仍只监听本机。
如有多个 Network 地址，选择当前 Wi-Fi 对应的局域网地址；访客网络隔离或系统防火墙可能阻止连接。

页面默认按手机宽度组织，960px 起扩展为电脑布局。手机优先使用紧凑角色卡、单列属性、大尺寸选择按钮、底部操作栏与弹窗复议。

## 检查与构建

```sh
npm run typecheck
npm run build
# 或一次执行全部检查
npm run check
```

前端构建结果位于 `apps/web/dist/`，服务端构建结果位于 `apps/server/dist/`。
构建后可运行服务端：

```sh
npm run start --workspace=@mcd/server
```

CI 在 `main` 的推送和面向 `main` 的 PR 上运行 `npm ci` 与 `npm run check`。
前端示例方案的约束检查可单独运行：`node --import tsx --test apps/web/src/services/demo-service.test.ts`。

## 环境变量与凭据

前端和服务端使用仓库根目录的 `.env`。Vite 仅向浏览器公开 `VITE_` 前缀变量，
任何密钥都不得使用该前缀。服务端的 MCP / AI 配置当前仅预留名称，不读取或调用。
`.gitignore` 忽略真实 `.env`、日志、依赖和构建产物，仅允许环境变量示例入库。
提交前仍应检查暂存区，禁止提交 API Key、Token、密码或其他真实凭据。

## 双人协作

主分支为 `main`。两人分别使用短期工作分支，通过 Pull Request 由另一人评审后合并。
建议 A 负责前端，B 负责服务端 MCP / AI，双方共同维护接口契约和工程配置。
详细流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
本轮分支提交与前后端联调交接见 [联调交接](docs/integration-handoff.md)。

## GitHub 首次发布（需要本机授权）

如果本机尚未安装 CLI，可安装官方 GitHub CLI，然后重新打开终端：

```powershell
winget install --id GitHub.cli --exact --source winget
```

使用官方浏览器流程登录；不要将 Token 发到聊天或写入项目文件：

```sh
gh auth login --hostname github.com --git-protocol https --web
gh auth status --hostname github.com
```

首次提交完成、确认仓库归属且同名仓库不存在后，在仓库根目录创建私有仓库并推送：

```sh
gh repo create mcd-mediation-rpg --private --source=. --remote=origin --push
```

仓库地址以命令实际返回结果为准。若同名仓库已存在，应先核对归属和内容，不覆盖现有仓库。
