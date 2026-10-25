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
  "planner": "rule-based-v2",
  "llm": "not_configured"
} }
```

`llm` 是模型可用性口径：`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` 三项齐全才会显示模型标识，
否则为 `not_configured`（只填 Key 不算接入）。它和 `/api/mediate` 响应里的 `meta.llm` 一致。

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
| `members[]` | ✅ | **2–4 人**（与 `/api/mediate` 一致） |
| `members[].name` | ✅ | 显示用 |
| `members[].budget` | ✅ | 预算上限（元），> 0 |
| `members[].spicy` | | `false`/省略 = 忌辣，会**整体排除**辣味商品 |
| `members[].lightEater` | | 减脂，降低油炸类权重 |
| `members[].wantChicken` / `wantVegetable` | | 偏好加权 |
| `members[]` 上限 | | 2–4 人 |

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

## POST `/api/mediate`

给前端 Demo 形状用的适配层，返回 `plans[]`（最多 3 个策略）+ `issues[]`。
完整字段语义见 [`mediate-contract.md`](./mediate-contract.md)，这里只列要点。

```json
{
  "storeId": "1950212",
  "members": [
    { "id": 1, "budget": 35, "hunger": "hungry", "likes": ["burger"], "dislikes": [], "requirement": "no-spicy" },
    { "id": 2, "budget": 30, "hunger": "faint", "likes": ["fries"], "dislikes": ["drink"], "requirement": "none" }
  ]
}
```

| 规则 | 说明 |
|---|---|
| 人数 | **2–4 人**，越界返回 400 |
| `budget` | **1–200 元整数**；`null` = 未填写（**不是不限预算**），只回非阻塞提示、不出方案 |
| `dislikes` | **硬排除**；`likes` 只影响排序 |
| 金额 | 响应全部是整数分（`*Cents`） |
| `plans[]` | 只含可行方案；`Σ allocations[].totalCents === payableCents`，每人 ≤ 预算 |
| `issues[]` | `blocking: true` 才会「整页无解」；`input` 类人工核对一律 `blocking: false` |
| 复议 | 需同时传 `revision` 与**完整的** `excludePlan`，缺任一项 400 |

策略：`saving`（最低实际应付）/ `peace`（均衡）/ `happy`（偏好匹配），
结果相同则去重并记录在 `meta.strategiesDeduplicated`。

### `meta` 里的模型信息

| 字段 | 含义 |
|---|---|
| `planner` | `rule-based-v2`（规则版）或 `llm-validated-v1`（模型提方案 + 程序校验通过） |
| `reasoning` | `rules` / `llm` / `rules-fallback`（模型被调用了，但方案被拦或调用失败） |
| `degraded` | `true` 表示这一次模型没顶上、已回退规则版；**不要据此报错**，方案仍然有效 |
| `llm` | 模型标识，未配置时为 `not_configured` |
| `llmDetail[]` | 逐策略记录 `{ strategy, status: accepted\|rejected\|skipped, model, code, message, latencyMs }` |

> 模型被拦只会体现在 `hints[]`（非阻塞）与 `meta`，**不会**变成 `blocking: true` 的 issue，
> 更不会让整页无解。

实测（2026-10-25，真实 MCP，3 人）：

- 规则版：返回 2 个方案，`strategiesDeduplicated: ["happy"]`，分摊合计与应付一致；
- 模型版（`npm run ai:probe`）：`planner: llm-validated-v1`、`reasoning: llm`、`degraded: false`，
  模型选品经校验后走 `calculate-price` 重算，应付 3200 分、分摊 1400+850+950=3200 分。

## 验证

```powershell
# 离线隔离测试（不连 MCP，验证预算无解与整数分摊）
npm run test --workspace=@mcd/server

# 真实接口冒烟（需先启动 dev:server）
npm run smoke --workspace=@mcd/server

# 真实模型探测（需要 AI_BASE_URL / AI_API_KEY / AI_MODEL）
npm run ai:probe --workspace=@mcd/server
```

前端形状的适配层契约（`/api/mediate`，尚未实现）见 [`mediate-contract.md`](./mediate-contract.md)。
