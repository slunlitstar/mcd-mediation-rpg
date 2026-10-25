# Vercel 部署

仓库根目录的 `vercel.json` 使用 Vercel Services（Beta），将 Vite 网页和原生 Node.js 后端作为同一个部署发布。不要只把 `apps/web/dist` 当作静态网站发布，否则真实门店、菜单与调解接口不可用。

## 项目设置

- 仓库根目录作为项目 Root Directory，不设置为 `apps/web`。
- Node.js 24.x；构建命令和产物目录由各 service 配置管理。
- `web`：Vite，产物 `apps/web/dist`；支持 SPA 刷新与深链接。
- `server`：`apps/server/src/index.ts`，Node.js 24，香港 `hkg1`，单次请求最长 120 秒。
- `/api` 和 `/api/*` 保留原始路径并转到后端，其余路径转到网页。
- 前端使用同源 `/api`；不配置本机 `127.0.0.1:3001` 为线上 API 地址。
- 服务端构建会写入 `apps/server/dist/package.json`（`type: module`）。Vercel 将 `dist/` 作为函数根目录打包，必须保留这份声明，否则启动时会将 ESM 产物当作 CommonJS 加载并返回 500。

## 服务端环境变量

在 Vercel 项目 Production / Preview 环境分别配置：

| 变量 | 用途 |
| --- | --- |
| `MCD_MCP_URL` | 麦当劳 MCP 服务地址 |
| `MCD_MCP_TOKEN` | MCP Token，使用 Secret / Sensitive 类型 |
| `AI_BASE_URL` | 已验证的模型兼容 API 地址 |
| `AI_API_KEY` | 模型 Key，使用 Secret / Sensitive 类型 |
| `AI_MODEL` | 模型名称 |
| `AI_TIMEOUT_MS` | 可选，单次模型超时毫秒数 |

不要上传 `.env`，也不要给上述密钥加 `VITE_` 前缀。不要把本地的 `SERVER_HOST`、`SERVER_PORT` 上传到线上；部署平台注入 `PORT`。

模型限流、超时或方案校验失败时仍会回退规则方案。部署不会解除模型供应商限流。MCP 不可用时真实查询会提示失败，不能用示例数据冒充成功。

## 发布后验收

1. 首页 HTML、JS、CSS、角色图均能访问；刷新页面可正常打开。
2. `GET /api/health` 返回 JSON，MCP 和模型配置状态正确。
3. `GET /api/stores` 可查询真实门店；`GET /api/menu` 返回真实菜单。
4. `POST /api/mediate` 返回可被现有前端解析的方案；各成员分摊合计等于实际应付，个人不超预算。
5. 检查共享套餐、复议与无解响应；网络错误不能返回 SPA 的 HTML。

网页的“接受方案”仍只表示接受推荐，不创建订单、不支付。访客无需自行填写 Key。
