# 接口契约

服务端 `apps/server` 对前端暴露的全部接口。字段的完整含义与类型见
[`apps/server/fixtures/README.md`](../apps/server/fixtures/README.md)，
那里的样例 JSON 就是本契约的权威示例。

## 通用约定

所有响应都是二选一：

```jsonc
{ "ok": true,  "data": { /* ... */ } }
{ "ok": false, "error": { "kind": "bad_request", "message": "storeCode 必填" } }
```

- 前端**只需要判 `ok`**，不要解 `error.kind` 做分支（`kind` 是给日志和排查用的）。
- `Cache-Control: no-store`；金额字段已经在服务端转成元 + 分双写，前端不碰单位换算。
- 开发期 Vite 已配置 `/api` 代理到 `http://127.0.0.1:3001`，前端直接请求相对路径即可。

### 错误类型

| HTTP | `kind` | 含义 | 前端处理 |
|---|---|---|---|
| 400 | `bad_request` | 入参缺失/非法 | 提示用户改输入 |
| 502 | `mcp_auth_failed` | MCP 鉴权失败，token 失效 | 提示「服务配置异常」 |
| 502 | `menu_failed` / `price_failed` / `stores_failed` | 麦当劳侧调用失败 | 提示重试 |
| 502 | `mcp_timeout` / `mcp_network` | MCP 超时或网络不可达 | 提示重试 |
| 404 | `not_found` | 路径不存在 | — |

## GET `/api/health`

```json
{ "ok": true, "data": {
  "service": "mcd-mediation-rpg-server",
  "time": "2026-10-25T03:23:29.261Z",
  "mcpConfigured": true,
  "planner": "rule-based-v1"
} }
```

## GET `/api/stores`

查询参数：`city`（默认「北京」）、`keyword`（默认「麦当劳」）。

```json
{ "ok": true, "data": [
  { "id": "1950059", "name": "麦当劳北京新王府井餐厅",
    "address": "王府井大街200号…", "businessStatus": false,
    "businessHours": "06:00-22:00", "distance": 2 }
] }
```

> `businessStatus: false` 时服务端会自动切预约链路，前端不必拦截，但建议提示「当前非营业时段，价格为预约价」。

## GET `/api/menu`

查询参数：`storeCode`（**必填**）、`orderType`（1 到店 / 2 外送）、`beType`（1 到店自取 / 5 得来速 / 2 麦乐送 / 6 团餐）。

返回 `UnifiedMenu`：`store`、`categories[]`、`items[]`（96 条）、`meta`。
`items[]` 关键字段：`id`、`name`、`price`（元）、`priceFen`（分）、`category`、`isCombo`、`isComboSource`、`image`。

缓存 5 分钟；同一 `storeCode` 短时间内重复请求不会重复打 MCP。

## POST `/api/plan`

请求体：

```json
{
  "storeCode": "1950059",
  "orderType": 1,
  "beType": 1,
  "members": [
    { "name": "小王", "budget": 35, "spicy": false },
    { "name": "小李", "budget": 30, "spicy": true, "wantChicken": true },
    { "name": "小张", "budget": 40, "lightEater": true, "wantVegetable": true }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `storeCode` | ✅ | 来自 `/api/stores` |
| `members[].name` | ✅ | 显示用 |
| `members[].budget` | ✅ | 预算上限（元），> 0 |
| `members[].spicy` | | `false`/省略 = 忌辣，会**整体排除**辣味商品 |
| `members[].lightEater` | | 减脂，降低油炸类权重 |
| `members[].wantChicken` / `wantVegetable` | | 偏好加权 |
| `members[]` 上限 | | 10 人 |

返回 `PlanOutcome`，两种形态二选一：

```jsonc
{ "status": "ok",          "plan": { /* MealPlan */ } }
{ "status": "no_solution", "issues": [ /* 阻塞原因 */ ], "diagnostics": { /* 诊断数字 */ } }
```

**无解也是 200 的合法业务结论**，不是 HTTP 错误。前端必须判 `status`，
`no_solution` 时展示无解态，不要拿空方案凑页面。

### 预算与分摊（v2 修正）

- 预算按**硬约束**处理：预算内买不到主食的成员会让整体直接 `no_solution`，
  不会给出超预算方案；
- `plan.members[].costFen` 是按 `calculate-price` 真实应付分摊的金额，
  **`Σ costFen === plan.totals.payableFen`**，且每人 `costFen ≤ budgetFen`；
- 分摊方式见 `plan.allocation`（比例 + 最大余数，整数分）；
- 金额同时给元与分：`cost` / `costFen`、`payable` / `payableFen`，计算请用分。

`no_solution` 的 `issues[].code`：

| code | 含义 |
|---|---|
| `no_menu_item_matching_constraints` | 忌口条件下门店没有任何可选商品 |
| `no_main_within_budget` | 预算低于最便宜的主食 |
| `total_budget_exceeded` | 合计应付超过预算合计 |
| `allocation_exceeds_budget` | 分摊后某人超预算（如外送费这类加价导致） |

### `MealPlan` 主要区块

| 区块 | 前端用途 |
|---|---|
| `strategy` | 方案策略：`name` / `summary` / `rationale[]` / `rejectedAlternatives[]` |
| `members[]` | 每人分到的 `items[]`、`cost` / `costFen`、`rawSubtotal`、`budgetCheck`、`preferenceMatch` |
| `totals` | `payable` / `payableFen`（**展示这个**）、`discount`、`perPersonAvg`、`budgetRemaining` |
| `allocation` | 分摊审计：`payableFen`、`allocatedFenSum`、`roundingAdjustmentFen`、`budgetCheck` |
| `preferenceMatch` | 总 `score` + 4 个 `dimensions[]` |
| `tradeoffs[]` | 取舍说明：`issue` / `chosen` / `alternative` / `reason` / `costDeltaFen` |
| `unsatisfiable[]` | 无法满足的原因，`severity` 为 `partial` 或 `blocked` |
| `coupons` | `availableCount`；为 0 且 `discount > 0` 时说明优惠来自组合价 |
| `planner` | `engine: 'rule-based-v2'`，用于在 UI 上标注「规则版，未接 AI」 |

实测（2026-10-25，真实 MCP）：3 人应付 8400 分，分摊合计 8400 分，无人超预算。

## 验证

```powershell
# 离线隔离测试（不连 MCP，验证预算无解与整数分摊）
npm run test --workspace=@mcd/server

# 真实接口冒烟（需先启动 dev:server）
npm run smoke --workspace=@mcd/server
```

前端形状的适配层契约（`/api/mediate`，尚未实现）见 [`mediate-contract.md`](./mediate-contract.md)。
