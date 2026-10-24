# 双人协作约定

## 分工边界

| 开发者 | 建议主责 | 主要目录 |
| --- | --- | --- |
| A | 前端页面、交互、通用组件 | `apps/web/src/` |
| B | Node.js 服务端、MCP 接入、AI 推荐逻辑 | `apps/server/src/` |
| 共同维护 | 接口契约、依赖、工程配置和文档 | `packages/shared/`、根配置、`docs/` |

分工仅为初始化建议，尚未绑定 GitHub 用户。跨目录工作前先在 Issue 或 PR 中沟通。

## 分支与评审

`main` 保存可通过检查的代码。每项工作从最新的 `main` 创建短期分支：

```sh
git switch main
git pull --ff-only origin main
git switch -c feat/web-page-shell
```

分支建议采用 `feat/web-*`、`feat/server-*`、`fix/*`、`chore/*` 或 `docs/*`。
完成后运行 `npm run check`，提交并推送自己的分支，再向 `main` 发起 PR：

```sh
git add <明确需要提交的文件>
git commit -m "chore: describe the change"
git push -u origin <当前分支>
```

另一位开发者评审后合并。优先采用 Squash merge；合并后各自更新本地 `main`。
不要强推 `main`，不要将共享开发直接放在 `main` 上进行。
首次初始化提交是建立基线的例外。

## 配置与依赖

- 使用 `.nvmrc` 指定的 Node.js 版本、npm 11 和根目录的 npm workspaces。
- 新克隆使用 `npm ci`；修改依赖使用 `npm install`，同时提交 `package-lock.json`。
- 新增前后端接口时，先更新 `docs/` 中的契约；共享类型预留在 `packages/shared/src/`。
- 新增环境变量时更新 `.env.example`，仅填写空值或公开的示例值。
- 提交前检查暂存区，禁止提交 `.env`、API Key、Token、密码和真实凭据。
- GitHub 私有仓库创建后，由仓库所有者在 Settings → Collaborators 邀请另一位开发者。
- 本阶段没有发送协作者邀请，也没有自动配置分支保护；若账户计划支持，可后续启用 PR / CI 保护规则。
