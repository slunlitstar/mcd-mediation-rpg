# 麦门饭局调解所 · mcd-mediation-rpg

一个结合轻 RPG 游戏化交互、多人点餐协商和麦当劳 MCP 的 AI Web 应用。

**当前阶段：服务端已打通真实麦当劳 MCP，前端待开发。**

已完成：MCP 接入层（握手 / 错误映射 / 缓存）、35 个工具盘点、数据形状基线、写链路空跑验证、
统一格式转换层、HTTP 接口（门店 / 菜单 / 方案生成）、前端样例 fixtures。

未完成：前端页面（仍是占位）、下单链路（`create-order` + 支付）、多人房间与 RPG 玩法。
方案生成目前是**确定性规则版**（`rule-based-v1`），未接入大模型 —— `.env` 里的 `AI_*` 仍为空。

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

前端地址为 `http://127.0.0.1:5173`，当前仍是占位页面。
服务端默认监听 `http://127.0.0.1:3001`，已提供真实业务接口（见下方「接口」）。
Vite 已预留 `/api` 开发代理，目标随根目录 `.env` 中的服务端地址和端口调整。

也可以分别运行：

```sh
npm run dev:web
npm run dev:server
```

## 接口

所有接口统一返回 `{ ok: true, data }` 或 `{ ok: false, error: { kind, message } }`，
前端只判 `ok`。字段含义见 [`apps/server/fixtures/README.md`](apps/server/fixtures/README.md)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回 MCP 是否已配置、当前规划器版本 |
| GET | `/api/stores?city=北京&keyword=麦当劳` | 门店列表（真实 MCP `query-nearby-stores`） |
| GET | `/api/menu?storeCode=1950059` | 门店菜单，96 个商品已归一化（真实 `query-meals`，5 分钟缓存） |
| POST | `/api/plan` | 生成多人点餐方案（真实 `calculate-price` 校准金额） |

`POST /api/plan` 请求示例：

```json
{
  "storeCode": "1950059",
  "members": [
    { "name": "小王", "budget": 35, "spicy": false },
    { "name": "小李", "budget": 30, "spicy": true, "wantChicken": true },
    { "name": "小张", "budget": 40, "lightEater": true, "wantVegetable": true }
  ]
}
```

实测返回（2026-10-25 03:24，真实 MCP）：3 人、原价 ¥89.8、**优惠 ¥8.1**、应付 ¥81.7、人均 ¥27.23。

重新抓取前端样例数据：

```sh
npm run mcp:fixtures --workspace=@mcd/server
```

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
当前尚无自动化测试套件，接口正确性靠实跑验证（`npm run mcp:fixtures --workspace=@mcd/server`）。

## 环境变量与凭据

前端和服务端使用仓库根目录的 `.env`。Vite 仅向浏览器公开 `VITE_` 前缀变量，
任何密钥都不得使用该前缀。服务端会读取 `MCD_MCP_URL` / `MCD_MCP_TOKEN` 并**真实调用**麦当劳 MCP；
`AI_*` 三项目前为空，代码尚未使用。
`.gitignore` 忽略真实 `.env`、日志、依赖和构建产物，仅允许环境变量示例入库。
提交前仍应检查暂存区，禁止提交 API Key、Token、密码或其他真实凭据。

## 双人协作

主分支为 `main`。两人分别使用短期工作分支，通过 Pull Request 由另一人评审后合并。
建议 A 负责前端，B 负责服务端 MCP / AI，双方共同维护接口契约和工程配置。
详细流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

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
