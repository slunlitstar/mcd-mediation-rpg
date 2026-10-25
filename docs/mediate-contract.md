# `/api/mediate` 契约（已实现）

> 状态：**契约定稿，服务端已实现**（`apps/server/src/services/mediate.ts` + `POST /api/mediate`）。
> 实现不得自行放宽本文规则；需要变更先改本文，再改代码。
> 对标前端现有类型：`apps/web/src/types/demo.ts`（分支 `codex/demo-round-one`）。
> 现有可用接口见 [`api.md`](./api.md)；本文是它的前端形状适配层。

## 0. 本轮确认的决定（2026-10-25）

| 议题 | 决定 |
|---|---|
| 饱腹数据 | 真实数据保留 `fullness: null`。页面保留「饥饿程度」，但只作**份量偏好**处理；示例权重仅留在 Demo，不套到真实商品，不宣称保证吃饱 |
| 三种策略 | **不设「花到预算多少算省钱」的阈值**。所有策略先满足硬约束与份量规则；省钱 = 最低实际应付，和平 = 均衡照顾成员，快乐 = 偏好匹配最高。无额外收益时**不为花满预算加购**。结果可以相同，如实说明 |
| 复议范围 | 只调整**指定成员**的餐品，其他成员餐品保持不变；整单重新试算；优惠变化可能影响分摊金额，但每人仍必须在预算内；**不自动挪用别人的预算** |
| 自填要求 | 当前**保留人工核对**；接入模型后解析为结构化要求；无法可靠验证的内容继续标记待核对，**不能默认已满足** |

契约层面的六处纠正（已写入下文）：人数与预算范围、`dislikes` 为排除条件、
`excludePlan` 需带完整方案并由服务端校验、人工核对提示不入阻塞 issues、
食材推导需保留来源与不确定性、请求示例自洽。

---

## 1. 与现状的关系

| | 现状 | 本契约 |
|---|---|---|
| 路由 | `POST /api/plan` | `POST /api/mediate`（已实现，保留 `/api/plan`） |
| 金额 | 元 + 分双写 | **只用整数分**（`*Cents`），元字段不出现 |
| 方案数量 | 单个 | `plans[]`，最多 3 个（每种策略 1 个） |
| 成员模型 | `name/budget/spicy/...` | 兼容前端的 `roleId/hunger/likes/dislikes/requirement` |
| 无解表达 | `status: 'no_solution'` + `issues` | `plans: []` + 带 `blocking` 标记的 `issues[]` |
| 人员规模 | `/api/plan` 原允许 1–10 | **两个接口统一 2–4 人**（见 §2.1） |
| 复议 | 无 | `revision` + `excludePlan`（基础版，单轮） |

`/api/plan` 不删除，继续返回后端自有完整结构；`/api/mediate` 是给现有 UI 用的精简适配层。
两个接口的人数和预算范围已统一为 **2–4 人 / 1–200 元整数**，不再存在规则漂移。

---

## 2. 请求

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
      "dislikes": [],
      "requirement": "no-spicy",
      "customRequirement": "",
      "configured": true
    },
    {
      "id": 2,
      "roleId": "hungry",
      "budget": 30,
      "hunger": "faint",
      "likes": ["fries"],
      "dislikes": ["drink"],
      "requirement": "none",
      "customRequirement": "",
      "configured": true
    },
    {
      "id": 3,
      "roleId": "cheese",
      "budget": 40,
      "hunger": "little",
      "likes": ["drink"],
      "dislikes": [],
      "requirement": "none",
      "customRequirement": "不要洋葱",
      "configured": true
    }
  ],
  "revision": { "memberId": 2, "action": "cheaper" },
  "excludePlan": {
    "planId": "plan_1730000000000_1_saving",
    "strategy": "saving",
    "allocations": [
      { "memberId": 1, "items": [{ "productId": "1100", "quantity": 1 }], "totalCents": 2450 },
      { "memberId": 2, "items": [{ "productId": "1401", "quantity": 1 }], "totalCents": 1400 },
      { "memberId": 3, "items": [{ "productId": "521750", "quantity": 1 }], "totalCents": 1650 }
    ],
    "productSubtotalCents": 5500,
    "discountCents": 0,
    "payableCents": 5500
  },
  "options": { "maxPlans": 3, "includeProducts": true }
}
```

> 上例是自洽的：`revision.memberId = 2` 存在，`excludePlan` 覆盖 1/2/3 三人，
> 且 `Σ allocations.totalCents = 5500 = payableCents`。

### 2.1 人数与预算（硬规则）

| 项 | 规则 | 违反时 |
|---|---|---|
| 人数 | **2–4 人**，`members.length` 必须在这个区间 | HTTP 400 `bad_request` |
| `budget` | **1–200 元的整数**（不含小数、不含 0、不含负数） | HTTP 400 `bad_request` |
| `budget: null` | **表示「未填写」，不是「不限预算」** | 200 + `issues[].kind = "input"`（非阻塞），该次不产出方案 |

`budget: null` 的处理必须严格遵守：

- **不得**把 `null` 当成不限预算、也不得套用任何默认值；
- 有人未填写时，`plans: []`，`issues` 里给该成员一条 `kind: "input"`、`blocking: false` 的提示；
- 前端据此显示「请先填写预算」，而不是无解页。

### 2.2 `dislikes` 是排除条件

| 字段 | 语义 | 后果 |
|---|---|---|
| `dislikes: Category[]` | **硬约束：排除该类商品** | 若排除后无法组出方案 → `blocking: true` 的 `constraint` |
| `likes: Category[]` | **仅排序偏好**，不影响可行性 | 永不产生 `issues` |

这一点与现有产品规则一致：**喜欢是加分，不喜欢是排除**，两者不对称。
`dislikes` 与 `requirement` 同级，都先于策略生效。

### 2.3 `excludePlan` 必须带上一份完整方案

只传 `strategy` 不够 —— 服务端需要知道其他成员原来吃什么、目标成员原来花多少，
才能保证复议「只动该成员、不挪用别人预算」。

必填字段：

| 字段 | 用途 | 校验 |
|---|---|---|
| `planId` | 对应上一份方案 | 非空字符串 |
| `strategy` | 上一份方案用的策略 | 枚举内 |
| `allocations[]` | **每人选了什么**（`memberId` + `items[].productId/quantity` + `totalCents`） | `memberId` 必须覆盖当前 `members` 全集 |
| `productSubtotalCents` | 上一份商品合计 | ≥ 0 |
| `discountCents` | 上一份优惠 | ≥ 0 |
| `payableCents` | 上一份应付 | 必须 `=== Σ allocations[].totalCents` |

服务端会**逐项校验**；任一不通过返回 HTTP 400 `bad_request`，并在 `message` 指明缺哪一项。
不静默忽略，否则复议结果会凭空变化，前端无法解释。

### 2.4 其余字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `storeId` | ✅ | 来自 `GET /api/stores` 的 `id` |
| `orderType` / `beType` | | 默认 `1` / `1`（到店自取） |
| `members[].id` | ✅ | 前端自增 id，回包原样带回 |
| `members[].requirement` | | 硬约束枚举，见 §5 |
| `members[].customRequirement` | | 自由文本，**当前只做人工核对**，见 §5.2 |
| `members[].hunger` | | 只影响**份量偏好**，不承诺吃饱 |
| `revision` | | 基础复议，见 §6 |
| `options.maxPlans` | | 1–3，默认 3 |
| `options.includeProducts` | | 是否回传商品目录，默认 `true` |

### 金额约定（硬性）

- 请求里 `budget` 是**元整数**（沿用前端语义）；
- 响应里所有金额一律**整数分**，字段名以 `Cents` 结尾；
- 前端不要自己做元/分换算，也不要再乘 100。

---

## 3. 响应

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
      "image": "https://menu-img.mcd.cn/pcm/prod/menu/20260309/product/MS_1100_320.png",
      "fullness": null,
      "fullnessSource": "unknown",
      "dietary": {
        "spicy": { "inferred": false, "source": "name", "confidence": "low" },
        "beef": { "inferred": true, "source": "tag", "confidence": "medium" },
        "note": "由名称/标签推导，不代表官方成分确认；未出现关键词 ≠ 确认不含"
      }
    }
  ],
  "plans": [
    {
      "planId": "plan_1730000000000_2_saving",
      "strategy": "saving",
      "allocations": [
        {
          "memberId": 1,
          "items": [{ "productId": "1100", "quantity": 1, "unitPriceCents": 2600, "subtotalCents": 2600 }],
          "subtotalCents": 2600,
          "totalCents": 2485,
          "budgetCents": 3500,
          "budgetOverCents": 0,
          "matchedLikes": ["burger"],
          "missingLikes": [],
          "reason": "主食「巨无霸」¥26，满足堡类偏好且在预算内",
          "requiresManualReview": false
        },
        {
          "memberId": 2,
          "items": [{ "productId": "1401", "quantity": 1, "unitPriceCents": 1400, "subtotalCents": 1400 }],
          "subtotalCents": 1400,
          "totalCents": 1338,
          "budgetCents": 3000,
          "budgetOverCents": 0,
          "matchedLikes": [],
          "missingLikes": ["fries"],
          "reason": "预算内取最低应付，未额外加购薯条",
          "requiresManualReview": false
        },
        {
          "memberId": 3,
          "items": [{ "productId": "521750", "quantity": 1, "unitPriceCents": 1650, "subtotalCents": 1650 }],
          "subtotalCents": 1650,
          "totalCents": 1577,
          "budgetCents": 4000,
          "budgetOverCents": 0,
          "matchedLikes": [],
          "missingLikes": ["drink"],
          "reason": "预算内优先主食，未额外加购饮料",
          "requiresManualReview": true
        }
      ],
      "productSubtotalCents": 5650,
      "discountCents": 250,
      "payableCents": 5400,
      "totalCents": 5400,
      "explanations": [
        "3 人预算合计 ¥105，实付 ¥54.00，未为了花满预算加购",
        "优惠 ¥2.50 按各成员原值比例分摊；2485+1338+1577 = 5400，与应付一致"
      ],
      "allocationAudit": {
        "method": "proportional-largest-remainder",
        "payableCents": 5400,
        "allocatedCentsSum": 5400,
        "roundingAdjustmentCents": 2,
        "budgetCheck": "passed"
      },
      "tradeoffs": [
        { "memberId": 3, "issue": "自填要求「不要洋葱」", "chosen": "保留原方案", "reason": "需要人工核对", "costDeltaCents": 0 }
      ],
      "requiresManualReview": true
    }
  ],
  "issues": [
    {
      "memberId": 3,
      "code": "custom_requirement_unverified",
      "kind": "input",
      "blocking": false,
      "message": "自填要求「不要洋葱」需要人工核对，系统未自动处理",
      "detail": { "customRequirement": "不要洋葱" }
    }
  ],
  "hints": [
    { "memberId": 3, "level": "info", "message": "该成员有自填要求，下单前请自行确认配料" }
  ],
  "meta": {
    "planner": "rule-based-v2",
    "pricingVerified": true,
    "menuCapturedAt": "2026-10-25T02:30:00.000Z",
    "couponCount": 0,
    "degraded": false,
    "reasoning": "rules",
    "strategiesReturned": ["saving"],
    "strategiesDeduplicated": ["peace", "happy"]
  }
}
```

### 3.1 三条必须成立的不变量

前端可据此写断言，后端每次都要满足：

1. **`Σ plans[].allocations[].totalCents === plans[].payableCents`**（逐方案，分文不差）
2. **`allocations[].totalCents ≤ allocations[].budgetCents`**（没人超预算）；违反的方案**不得出现**在 `plans[]`
3. **`plans[].payableCents` 必须来自 `calculate-price`**；`meta.pricingVerified === true` 才可信

### 3.2 `issues` 与「整页无解」严格分离

`issues[].blocking` 决定前端表现，这是本轮纠正的重点：

| `blocking` | 典型 `kind` | 前端表现 |
|---|---|---|
| `true` | `constraint` | 无解页：确实没有可行方案 |
| `false` | `input` / `unavailable` | 页面顶部提示条，**不影响继续浏览已有方案** |

- **人工核对（`requiresManualReview`、`custom_requirement_unverified`）永远不得 `blocking: true`**，
  否则会把整页打成无解。
- 全部不可行时：`plans: []` + 至少一条 `blocking: true` 的 `constraint`。
- `kind` 固定三种：`input` / `constraint` / `unavailable`。

### 3.3 `requiresManualReview` 与 `hints`

| 位置 | 含义 |
|---|---|
| `allocations[].requiresManualReview` | 该成员的餐品需要人工核对（例如自填要求无法自动验证） |
| `plans[].requiresManualReview` | 本方案内**任一**成员需要核对即聚合为 `true`，方便前端整体标记 |
| `hints[]` | 非阻塞补充说明，`level: "info" \| "warn"`，不参与可行性判断 |

---

## 4. 策略（无阈值）

三种策略**都不设「花到预算多少算省钱」的阈值**，也都不为了花满预算加购。

执行顺序（所有策略一致）：

1. 硬约束过滤：`requirement` + `dislikes` + 预算上限
2. 份量规则：按 `hunger` 决定是否需要主食/配餐（**只作份量偏好，不承诺吃饱**）
3. 策略排序：

| 策略 | 排序目标 | 说明 |
|---|---|---|
| `saving` | **最低实际应付** | 先满足硬约束与份量，再在可行解里取 payable 最低者 |
| `peace` | **均衡照顾成员** | 各成员主食都成立，偏好差距最小；不因某人多花钱而恶化他人 |
| `happy` | **偏好匹配最高** | `likes` 命中最多、`missingLikes` 最少 |

**结果可以相同**：若 `peace` 与 `happy` 得出同一组商品，不重复返回两份相同方案，
而是在 `meta.strategiesDeduplicated` 里如实列出，前端可显示「该策略下结果与 X 相同」。

---

## 5. 枚举映射

### 5.1 `category`（中文分类 → 五类枚举）

| 后端原始分类（示例） | `category` |
|---|---|
| 巨无霸·牛鱼肉堡 / 安格斯MAX·厚牛堡 / 鸡肉汉堡/卷 / 大堡口福·单人餐 | `burger` |
| 炸鸡 / 蘸酱炸鸡 | `snack` |
| 小食甜品/其他 / 小食拼盘/多人餐 | `snack`（名称含「薯条/薯饼」则为 `fries`） |
| 饮品 / 麦咖啡™ | `drink` |
| 开心乐园 / 冰品甜点 | `dessert` |

薯条优先判定：名称含「薯条 / 薯饼」→ `fries`，优先级高于分类映射。
**映射表只在服务端维护一份**，前端不要另建。

### 5.2 `requirement` 与 `customRequirement`

| 值 | 语义 | 是否硬约束 |
|---|---|---|
| `none` | 无要求 | — |
| `no-spicy` | 排除 `dietary.spicy.inferred === true` 的商品 | ✅ 硬（依赖推导） |
| `no-beef` | 排除 `dietary.beef.inferred === true` 的商品 | ✅ 硬（依赖推导） |
| `burger` / `fries` / `drink` | 必须含该类商品 | ✅ 硬 |
| `other` | 见 `customRequirement` | ❌ 人工核对 |

`customRequirement` 当前处理方式（**不得默认已满足**）：

- 不做自动解析，只产生 `requiresManualReview: true` 与 `kind: "input"`、`blocking: false` 的提示；
- 接入模型后再尝试解析为结构化要求（如「不要洋葱」→ `exclude: ["onion"]`）；
- 解析成功但**无法可靠验证**的，仍标 `requiresManualReview: true`。

### 5.3 食材推导：保留来源与不确定性

`dietary` 不是官方成分表，必须携带三项元信息：

| 字段 | 取值 | 含义 |
|---|---|---|
| `inferred` | `true` / `false` / `null` | 推导结论；`null` 表示无从判断 |
| `source` | `name` / `tag` / `official` / `unknown` | 依据来自商品名、标签、官方字段，或没有依据 |
| `confidence` | `high` / `medium` / `low` | `tag` 为 high/medium，纯名称匹配为 low |

**关键约定：**

- 名称与标签里**没有出现「牛」或「辣」，不等于官方确认不含**。这种情况 `inferred` 为 `false`，
  但 `confidence: "low"`，且 `dietary.note` 必须带上免责说明；
- 前端若要展示「不含辣」，必须同时展示来源，不能只说结论；
- 若将来 MCP 提供官方成分字段，`source` 改为 `official`、`confidence: "high"`，此时才算确认。

### 5.4 `fullness`

**真实数据恒为 `null`，`fullnessSource: "unknown"`。**

- 不把 Demo 里的 `fullness` 权重套到真实商品上；
- 页面的「饥饿程度」只作为**份量偏好**（要不要加主食/配餐），不换算成克数、不宣称吃饱；
- `list-nutrition-foods` 有营养表格，但与商品编码无可靠对应，暂不用于单商品饱腹感。

---

## 6. 基础复议（`revision`）

单轮、不复用上一轮上下文。

| `action` | 行为 |
|---|---|
| `cheaper` | 该成员改用更低价同类商品 |
| `hungrier` | 该成员追加配餐/主食 |
| `fries` / `burger` / `drink` | 该成员追加上对应类别商品 |

### 范围约束（本轮确认）

1. **只调整 `revision.memberId` 指向的那一位成员**，其余成员的 `productId` 与 `quantity` **保持不变**；
2. 整单重新走一次 `calculate-price`，**优惠可能变化，因此分摊金额也可能变化**；
3. 分摊后**每个人仍然必须满足 `totalCents ≤ budgetCents`**；
4. **不自动挪用别人的预算**：目标成员加购导致自己超预算时，判其不可行，
   不得从其他成员剩余预算里调剂；
5. 复议后仍需满足 §3.1 三条不变量；
6. 复议失败：`plans: []` + `blocking: true` 的 `constraint`，**不要返回旧方案充数**。

---

## 7. 模型接入步骤（填 Key 不算完成）

当前 `meta.reasoning = "rules"`、`planner = "rule-based-v2"`。接入真实模型须完成四步，缺一步都不算：

### 第 1 步：配置与探测

- 读取 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`；
- 启动时做一次最小连通性探测，失败则 `meta.llm = "unavailable"`，planner 保持规则版；
- **只填 Key 不算接入**，必须有真实请求与响应日志。

### 第 2 步：喂真实上下文

```json
{
  "store": { "id": "1950212", "name": "..." },
  "members": [
    { "id": 1, "budget": 35, "requirement": "no-spicy", "likes": ["burger"], "dislikes": [], "hunger": "hungry" },
    { "id": 2, "budget": 30, "requirement": "none", "likes": ["fries"], "dislikes": ["drink"], "hunger": "faint" }
  ],
  "candidates": [
    { "id": "1100", "name": "巨无霸", "priceCents": 2600, "category": "burger",
      "dietary": { "spicy": false, "beef": true } }
  ]
}
```

模型只输出**结构化 JSON**：每位成员选了哪些 `productId`、数量、一句话理由。
**不允许模型输出金额。**

### 第 3 步：程序侧强制核对（不可省）

| 校验项 | 不通过时 |
|---|---|
| `productId` 必须在本次菜单内 | 丢弃该条并记 `issues` |
| 数量为正整数且 ≤ 5 | 丢弃该条 |
| `requirement` / `dislikes` 硬约束 | 丢弃该条 |
| 每人分摊 ≤ 预算 | 该方案不可行 |
| **金额一律用 `calculate-price` 重算**，模型给的价格全部忽略 | 以试算为准 |
| 分摊后 `Σ === payable` | 不成立则拒绝该方案 |
| `customRequirement` 是否可验证 | 不可验证 → `requiresManualReview: true`，**不得默认满足** |

### 第 4 步：降级与可观测

- 超时 / 非 JSON / 校验失败率过高 → 回退 `rule-based-v2`，`meta.degraded = true`；
- 记录请求摘要、响应摘要、token 用量、校验失败条数；
- 验收：**至少一次真实模型调用**，且有「模型给出非法 `productId` 被拦下」的测试通过。

### 边界

- 模型只产出推荐方案，**不触发 `create-order`**；
- 「确认方案」只表示接受推荐，**不自动下单**；
- Token/Key 只在服务端，响应体里永不出现。

---

## 8. 前端对接顺序

1. `GET /api/menu` 渲染真实商品与图片（字段见 §3、§5.3）；
2. 接 `/api/mediate` 的 `plans[]`；
3. 处理 `issues[].blocking` 二分：`true` → 无解页；`false` → 顶部提示条；
4. 展示 `requiresManualReview` 与 `hints[]`（非阻塞）；
5. 最后接复议 `revision`；
6. 全程不做元/分换算，显示时 `Cents / 100` 保留两位。

## 9. 仍未决（下一轮确认）

1. `saving` 与 `peace` 冲突时的取舍顺序（例如省 ¥2 但让某成员少吃一份配餐）；
2. 复议是否允许连续多轮（当前明确只支持单轮）；
3. `customRequirement` 接入模型后的结构化词表范围。
