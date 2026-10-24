# 项目文档

当前已完成：工程骨架 + 麦当劳 MCP 接入层（client / 错误映射 / 工具探针 / 数据形状基线 / 写链路空跑验证）。

| 文档 | 内容 |
|---|---|
| [`mcp-tools.md`](./mcp-tools.md) | 35 个 MCP 工具清单、业务线矩阵、风险分级、MVP 最小工具集 |
| [`mcp-tools.snapshot.json`](./mcp-tools.snapshot.json) | `tools/list` 原始快照（`npm run mcp:probe -w @mcd/server` 生成） |
| [`mcp-data-shapes.md`](./mcp-data-shapes.md) | 8 个 MVP 只读工具的真实 `data` 形状与 `outputSchema` 差异 |
| [`mcp-data-shapes.json`](./mcp-data-shapes.json) | 取样原始快照，已脱敏（`npm run mcp:shapes -w @mcd/server` 生成） |
| [`mcp-order-shapes.md`](./mcp-order-shapes.md) | 写链路实测：`create-order` / `query-order` / `cancel-order` 的真实载荷与状态码 |
| [`mcp-order-shapes.json`](./mcp-order-shapes.json) | 写链路快照（`npm run mcp:order -w @mcd/server -- --confirm`，建单不付款并立即取消） |

后续在本目录协作维护需求、页面流程、接口契约和 MCP / AI 接入设计。
涉及前后端边界的变更，应先由两位开发者确认契约，再分别实现。
