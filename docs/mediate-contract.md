# `/api/mediate` 契约（提议稿）

> 状态：**契约提案，尚未实现**。本文只定义边界，代码里还没有这个路由。
> 目的：让前端可以在后端动手前先核对字段，避免两边各写一套。
>
> 对标前端现有类型：`apps/web/src/types/demo.ts`（分支 `codex/demo-round-one`）。
> 现有可用接口见 [`api.md`](./api.md)；本文是它的前端形状适配层。

## 0. 与现状的关系

| | 现状 | 本契约 |
|---|---|---|
| 路由 | `POST /api/plan` | `POST /api/mediate`（新增，保留 `/api/plan`） |
| 金额 | 元 + 分双写 | **只用整数分**（`*Cents`），元字段不出现 |
| 方案数量 | 单个 | **`plans[]`，最多 3 个** |
| 成员模型 | `name/budget/spicy/...` | 兼容前端的 `roleId/hunger/likes/dislikes/requirement` |
| 无解表达 | `status: 'no_solution'` + `issues` | `plans: []` + `issues[]`（不再有 `status` 字段） |
| 复议 | 无 | `revision` + `excludePlan`（基础版，单轮） |
| 商品目录 | 只有中文分类 | 附带 `category` 英文枚举映射与 `spicy/beef` 推导结果 |

`/api/plan` 不会被删除，它继续返回后端自有的完整结构（含 `tradeoffs`、`preferenceMatch` 等）；`/api/mediate` 是给现有 UI 用的精简适配层。

---

## 1. 请求

```http
POST /api/mediate
Content-Type: application/json
```

```json
{
  "storeId": "1950212",
  "orderType": 1,
  "beType": 1,
  "members": [
    {
      "id": 1,
      "roleId": "saver",
      "budget": 35,
      "hunger": "hungry",
      "likes": ["burger"],
      "dislikes": ["drink"],
      "requirement": "no-spicy",
      "customRequirement": "",
      "configured": true
    }
  ],
  "revision": { "memberId": 2, "action": "cheaper" },
  "excludePlan": { "strategy": "saving" },
  "options": { "maxPlans": 3, "includeProducts": true }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `storeId` | ✅ | 来自 `GET /api/stores` 的 `id` |
| `orderType` / `beType` | | 默认 `1` / `1`。到店自取 |
| `members[]` | ✅ | 1–10 人 |
| `members[].id` | ✅ | 前端自增 id，回包原样带回 |
| `members[].budget` | ✅ | **元**（与前端一致），服务端转整数分。`null` 视为不限但要显式给 `null`，不能省略 |
| `members[].requirement` | | 硬约束枚举，见 §4。`none` / 省略 = 无特殊要求 |
| `members[].customRequirement` | | 自由文本，**当前不参与求解**，原样回显到 `issues` 供人工核对 |
| `members[].likes` / `dislikes` | | 只影响排序权重，不是硬约束 |
| `members[].hunger` | | `little` / `hungry` / `faint`，影响是否追加配餐 |
| `revision` | | 基础复议，见 §5 |
| `excludePlan` | | 只要 `strategy` 即可，表示「换一个策略」；不要求前端回传完整 plan |
| `options.maxPlans` | | 1–3，默认 3 |
| `options.includeProducts` | | 是否回传商品目录，默认 `true`（前端要展示真实商品与图片） |

### 金额约定（硬性）

- **请求里 `budget` 是元**（沿用前端现有语义）。
- **响应里所有金额一律是整数分**，字段名统一以 `Cents` 结尾。
- 前端不要自己做元/分换算，也不要把 `priceCents` 再乘 100。

---

## 2. 响应

```json
{
  "source": "live",
  "traceId": "med_1730000000000_1",
  "store": { "id": "1950212", "name": "麦当劳北京前门西街餐厅", "businessStatus": true },
  "products": [
    {
      "id": "1100",
      "name": "巨无霸",
      "category": "burger",
      "priceCents": 2600,
      "spicy": false,
      "beef": true,
      "fullness": null,
      "fullnessSource": "unknown",
      "emoji": null,
      "image": "https://menu-img.mcd.cn/pcm/prod/menu/20260309/product/MS_1100_320.png"
    }
  ],
  "plans": [
    {
      "planId": "plan_1730000000000_1_saving",
      "strategy": "saving",
      "allocations": [
        {
          "memberId": 1,
          "items": [{ "productId": "1100", "quantity": 1, "unitPriceCents": 2600, "subtotalCents": 2600 }],
          "subtotalCents": 2600,
          "totalCents": 2450,
          "budgetCents": 3500,
          "budgetOverCents": 0,
          "matchedLikes": ["burger"],
          "missingLikes": [],
          "reason": "主食「巨无霸」¥26，预算内且满足堡类偏好",
          "requiresManualReview": false
        }
      ],
      "productSubtotalCents": 8400,
      "discountCents": 350,
      "payableCents": 8050,
      "totalCents": 8050,
      "explanations": [
        "3 人预算合计 ¥105，实付 ¥80.50，剩余 ¥24.50",
        "优惠 ¥3.50 按各成员原值比例分摊"
      ],
      "allocationAudit": {
        "method": "proportional-largest-remainder",
        "payableCents": 8050,
        "allocatedCentsSum": 8050,
        "roundingAdjustmentCents": 2,
        "budgetCheck": "passed"
      },
      "tradeoffs": [
        {
          "memberId": 3,
          "issue": "想要蔬菜但门店无沙拉",
          "chosen": "玉米杯",
          "reason": "菜单无叶类蔬菜，玉米杯是最接近的选项",
          "costDeltaCents": 0
        }
      ]
    }
  ],
  "issues": [
    {
      "memberId": 2,
      "code": "custom_requirement_unverified",
      "kind": "input",
      "message": "自填要求「不要洋葱」需要人工核对，系统未自动处理",
      "detail": { "customRequirement": "不要洋葱" }
    }
  ],
  "meta": {
    "planner": "rule-based-v2",
    "pricingVerified": true,
    "menuCapturedAt": "2026-10-25T01:59:00.000Z",
    "couponCount": 0,
    "degraded": false,
    "reasoning": "rules"
  }
}
```

### 三条必须成立的不变量

前端可以据此写断言，后端每次都要满足：

1. **`Σ plans[].allocations[].totalCents === plans[].payableCents`**（逐方案，分文不差）
2. **`allocations[].totalCents ≤ allocations[].budgetCents`**（没人超预算）；违反的方案**不得出现在 `plans[]` 里**
3. **`plans[].payableCents` 必须来自 `calculate-price`**，不是菜单价相加；`meta.pricingVerified` 为 `true` 才可信

### `plans` 与 `issues` 的取舍规则

- 只返回**可行**方案。买不起、超预算、硬约束冲突的，一律进 `issues`，不进 `plans`。
- 全部不可行时：`plans: []` + `issues` 里至少一条 `kind: "constraint"`。**此时前端必须展示无解态，不能拿空方案凑页面。**
- `issues[].kind` 取值固定三种：`input`（用户填错/待核对）、`constraint`（硬性限制导致无解）、`unavailable`（上游数据/接口不可用）。

### `strategy` 语义（与前端 `peace / saving / happy` 对齐）

| 值 | 含义 | 后端行为 |
|---|---|---|
| `saving` | 省钱优先 | 同类取最低价，尽量贴近但不超预算 |
| `peace` | 稳一点（默认） | 均衡：每人都要有主食，冲突最小 |
| `happy` | 吃爽优先 | 在预算内优先套餐/大份，允许接近上限 |

`maxPlans: 3` 时按 `saving → peace → happy` 返回；若某种策略下无解，则该策略不出现，`issues` 里注明它被跳过。

---

## 3. 商品字段从哪来（前端最关心）

| 前端字段 | 后端来源 | 可靠性 |
|---|---|---|
| `id` | `query-meals` 的真实商品编码 | ✅ 真实 |
| `name` | 同上（已清洗换行） | ✅ 真实 |
| `priceCents` | `currentPrice` 元字符串 → 整数分；实际计价以 `calculate-price` 为准 | ✅ 真实 |
| `image` | 公开 CDN 地址，无签名，可直接 `<img>` | ✅ 可用 |
| `category` | **推导**：由 MCP 中文分类 + 标签映射到五类枚举，见 §4 | ⚠️ 规则映射 |
| `spicy` | **推导**：名称/标签含「辣」 | ⚠️ 规则推导 |
| `beef` | **推导**：标签「100%纯牛肉」或名称含「牛」 | ⚠️ 规则推导 |
| `fullness` | **MCP 不提供**，当前恒为 `null` + `fullnessSource: "unknown"` | ❌ 无数据 |
| `emoji` | 后端不回，前端按 `category` 自行映射 | — |

> `fullness` 不要在后端编造。真实的营养数据在 `list-nutrition-foods`（160 行表格），
> 但与商品编码没有可靠对应关系，暂不用于单商品「饱腹感」。前端现有 `fullness` 权重只能继续用自己的常量。

---

## 4. 枚举映射

### `category`（中文分类 → 五类枚举）

| 后端原始分类（示例） | `category` |
|---|---|
| 巨无霸·牛鱼肉堡 / 安格斯MAX·厚牛堡 / 鸡肉汉堡/卷 / 大堡口福·单人餐 | `burger` |
| 炸鸡 / 蘸酱炸鸡 | `snack` |
| 小食甜品/其他 / 小食拼盘/多人餐 | `snack`（含薯条类则 `fries`） |
| 饮品 / 麦咖啡™ | `drink` |
| 开心乐园 / 冰品甜点类 | `dessert` |

薯条单独判定：名称含「薯条 / 薯饼」→ `fries`，优先级高于分类映射。
**映射表放在服务端常量里**，前端不要再维护一份。

### `requirement`（硬约束）

| 值 | 后端含义 | 是否硬约束 |
|---|---|---|
| `none` | 无要求 | — |
| `no-spicy` | 排除名称/标签含「辣」的商品 | ✅ 硬 |
| `no-beef` | 排除 `beef` 推导为真的商品 | ✅ 硬（依赖推导） |
| `burger` / `fries` / `drink` | 必须有该类商品 | ✅ 硬 |
| `other` | 见 `customRequirement` | ❌ 走 `issues` 人工核对 |

`likes` / `dislikes` **只影响排序**，不产生 `issues`。

---

## 5. 基础复议（`revision`）

单轮、不复用上一轮上下文，语义如下：

| `action` | 行为 |
|---|---|
| `cheaper` | 该成员改用更低价的同类商品；仍不超预算 |
| `hungrier` | 该成员追加一份配餐/主食，若预算不够则进 `issues` |
| `fries` / `burger` / `drink` | 该成员追加上对应类别商品，预算不够则 `issues` |

约束：

- 复议只影响指定的 `memberId`，其他人方案尽量保持不变；
- 复议后仍必须满足 §2 的三条不变量；
- 复议失败（预算不够/无商品可选）时返回 `plans: []` + `issues[].kind: "constraint"`，**不要返回旧方案充数**；
- 不支持多轮连续复议（第二轮请带上新的 `revision` 重新发起）。

`excludePlan` 只用于「这个策略我不喜欢」，按 `strategy` 排除即可。

---

## 6. 模型接入步骤（填 Key 不算完成）

当前 `meta.reasoning = "rules"`，`planner = "rule-based-v2"`。接入真实模型要按下面四步走，**缺任何一步都不算接入完成**：

### 第 1 步：配置与探测

- 读取 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`；
- 启动时做一次最小连通性探测（一条 `ping` 请求），失败则 `planner` 保持 `rule-based-v2` 并在 `meta` 标注 `llm: "unavailable"`；
- **只把 Key 填进 `.env` 不算接入**，没有实际请求与响应日志就不算。

### 第 2 步：喂真实上下文

传给模型的输入必须是**真实菜单**，不是虚构目录：

```json
{
  "store": { "id": "1950212", "name": "..." },
  "members": [{ "id": 1, "budget": 35, "requirement": "no-spicy", "likes": ["burger"], "hunger": "hungry" }],
  "candidates": [
    { "id": "1100", "name": "巨无霸", "priceCents": 2600, "category": "burger", "spicy": false, "beef": true }
  ]
}
```

要求模型只输出**结构化 JSON**：每个成员选了哪些 `productId`、数量、一句话理由。**不允许模型输出金额**。

### 第 3 步：程序侧强制核对（这一步不可省）

模型返回后，服务端必须逐条校验，任何一条不过就整单降级：

| 校验项 | 不通过时 |
|---|---|
| `productId` 必须存在于本次菜单 | 丢弃该条，记 `issues` |
| 数量必须是正整数且 ≤ 5 | 丢弃该条 |
| 忌辣/`no-beef`/必须含某类 等硬约束 | 丢弃该条 |
| 每人分摊 ≤ 预算 | 超预算则该方案不可行 |
| **金额一律用 `calculate-price` 重算**，模型给的价格全部忽略 | 以试算为准 |
| 分摊后 `Σ === payable` | 不成立则拒绝该方案 |

### 第 4 步：降级与可观测

- 模型超时 / 非 JSON / 校验失败率过高 → 自动回退 `rule-based-v2`，`meta.degraded = true`；
- 记录：请求摘要、响应摘要、token 用量、校验失败条数；
- 验收标准：**至少一次真实模型调用**，并有「模型给出非法 `productId` 被拦下」的测试用例通过。

### 边界

- 模型只产出**推荐方案**，不触发 `create-order`；
- 「确认方案」只表示接受推荐，**不自动下单**，下单仍需用户二次确认；
- Token/Key 只在服务端，响应体里永不出现。

---

## 7. 前端对接顺序建议

1. 先用 `GET /api/menu` 把真实商品与图片渲染出来（字段见 §3）；
2. 再接 `/api/mediate` 的 `plans[]` 渲染方案；
3. 再处理 `issues[]` 三态（`input` 提示改输入 / `constraint` 无解页 / `unavailable` 重试）；
4. 最后接复议 `revision`；
5. 全程不要用元做计算，只显示 `Cents / 100` 之后的两位小数。

## 8. 未决问题（需要双方确认）

1. `fullness` 是否彻底放弃，前端继续用自己的常量？
2. `strategy` 三档的具体差异阈值（预算占比多少算 `saving`）？
3. 复议是「只改动该成员」还是「可以重排其他人以腾预算」？
4. `customRequirement` 走人工核对，还是后续交给模型解析？
