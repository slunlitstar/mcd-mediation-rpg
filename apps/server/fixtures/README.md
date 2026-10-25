# fixtures —— 前端可直接使用的样例数据

> 给前端的交付物。**`normalized/` 里的文件就是接口返回长什么样**，照它铺页面即可；
> `raw/` 是 MCP 原始返回，只用于排查「这个字段为什么是空的」。
>
> 全部数据来自 2026-10-25 03:11 对 `https://mcp.mcd.cn` 的真实调用，已脱敏
> （手机号、券码、带签名图片 URL 均掩码，token 不落盘）。

## 目录

```text
fixtures/
├── raw/                     # MCP 原始返回，排查用，前端不要读
│   ├── calls.json           # 所有调用的 structuredContent 汇总
│   ├── stores.json          # query-nearby-stores 原样返回
│   ├── menu.json            # query-meals 原样返回（44KB，96 个商品）
│   ├── meal-detail.json     # query-meal-detail，12 个疑似套餐的详情
│   └── pricing.json         # calculate-price 原样返回（金额单位是「分」）
└── normalized/              # 转换层输出，前端直接吃这层
    ├── stores.json          # 门店列表
    ├── menu.json            # 菜单（统一格式）
    ├── pricing.json         # 计价（统一格式）
    ├── plan.sample.json     # ★ 方案结果样例（第三页 / 第五页用）
    └── plan.no-solution.sample.json  # ★ 无解样例（预算不足，前端无解态用）
```

重新生成（仓库根目录，会真实调用 MCP）：

```powershell
npm run mcp:fixtures -w @mcd/server
```

---

## 0. 取样条件（读数据前必须知道）

| 项 | 值 |
|---|---|
| 取样时间 | 2026-10-25 03:11（服务端时间 GMT+8） |
| 门店 | `1950059` 麦当劳北京新王府井餐厅（关键词搜「北京 + 麦当劳」命中的首家） |
| 关键约束 | 凌晨门店全部 `businessStatus: false` |
| 绕过方式 | 门店相关工具统一带 `reservationDate=2026-10-25 12:00` 走预约链路 |
| 调用量 | 17 次 `tools/call` |

⚠️ **这一批价格是「预约今天 12:00」的预约报价，不是即时价。** 营业时段（06:00–22:00）复跑同一脚本，
价格与可售商品可能变化，尤其早餐档。前端演示没问题，正式计价必须实时调。

---

## 1. 数据可用性判定（对应任务第 3 步）

| 问题 | 结论 | 依据 |
|---|---|---|
| 有价格吗？ | ✅ 有 | `query-meals` 96 个商品全部带 `currentPrice` |
| 价格是数字还是文本？ | ⚠️ **两套** | `query-meals` 是**元字符串** `"29.9"`；`calculate-price` 是**分的整数** `2990`。转换层已统一成 `price`(元 number) + `priceFen`(分 int) |
| 菜品有分类吗？ | ✅ 有，15 个 | 但分类名是**两行显示设计**，原始值带 `\n`（`巨无霸\n牛鱼肉堡`），转换层已合成单行 `巨无霸·牛鱼肉堡` |
| 套餐/单点能区分吗？ | ✅ 能，但分置信度 | 真凭据是 `query-meal-detail` 的 `rounds` 非空；12 个商品已证实，其余靠标签/名称推断（见 `isComboSource`） |
| 优惠能算出实际折后价吗？ | ❌ **暂时不能** | `query-store-coupons` 在该门店 + 到店自取场景返回 `[]`（空数组），本账号无可用门店券。所以 `discount` 恒为 0、`payable = originalPrice` |
| 折后价怎么来的？ | ✅ 接口本身可信 | `calculate-price` 的 `price` 字段就是应付；有券时它会自动带入。**不要自己用原价乘折扣** |

**「暂用示例」的部分**（前端不要当真实业务逻辑）：

- `plan.sample.json` 里的 `members` 偏好、`tradeoffs`、`unsatisfiable` —— 协商算法还没实现，是人工构造的；
- `coupons.availableCount: 0` 与 `discount: 0` —— 真实，但换个有券账号就会变。

> 商品图片不用占位图：96 个商品的 `image` 都是公开 CDN 地址（如
> `https://menu-img.mcd.cn/pcm/prod/menu/20260309/product/MS_1100_320.png`），可直接 `<img src>`。
> 列表页、详情页的图都能省掉一轮「找图」。

---

## 2. `normalized/stores.json` —— 门店列表

数组，每项：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | 门店编码，即 MCP 的 `storeCode`。**后续所有门店相关调用都用它** |
| `name` | string | 门店名 |
| `address` | string? | 地址 |
| `businessStatus` | boolean? | 是否营业中。`false` 时门店工具必须带 `reservationDate`，否则报 `600057` |
| `businessHours` | string? | `06:00-22:00` |
| `distance` | number? | 原样透传的排序值，**单位不明**（实测 2 / 338 / 403…），不要当米渲染 |

## 3. `normalized/menu.json` —— 菜单

```jsonc
{
  "store": { "id": "1950059", "name": "麦当劳北京新王府井餐厅" },
  "currency": "CNY",
  "priceUnit": "yuan",
  "orderType": 1,          // 1 到店 / 2 外送
  "beType": 1,             // 1 到店自取 / 5 得来速 / 2 麦乐送 / 6 团餐
  "capturedAt": "2026-10-25T03:11:00.000Z",
  "categories": ["人气热卖", "小食拼盘/多人餐", ...],   // 15 个，顺序即 MCP 原始顺序，可直接做 tab
  "items": [ /* 见下表，96 条 */ ],
  "meta": { "itemCount": 96, "comboCount": 27, "comboVerifiedCount": 12, "orphanCount": 0 }
}
```

`items[]` 字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | 商品编码，下单/计价都用它 |
| `name` | string | 商品名（已清洗换行） |
| `price` | number | 现价，**元**，如 `26` |
| `priceFen` | number | 现价，**分**，如 `2600`。计算一律用它 |
| `originalPrice` / `originalPriceFen` | number? | 划线价，没有就不返回 |
| `category` | string | 主分类名（多分类时取第一个） |
| `categories` | string[] | 全部分类；同一商品可能同时在「人气热卖」和「精选单人餐」里 |
| `isCombo` | boolean | 是否套餐 |
| `isComboSource` | string | **判定依据的置信度**，见下 |
| `canWithOrder` | boolean | 是否随单购 |
| `tags` | string[] | MCP 原始标签，如 `["单品", "100%纯牛肉"]`、`["套餐"]` |
| `image` | string? | 图片 URL。实测 **96/96 个商品都有，且是公开 CDN 地址（无签名参数），可直接渲染**；若将来出现带签名的会被脱敏成 `?<signed>` |

`isComboSource` 取值：

| 值 | 含义 | 可信度 |
|---|---|---|
| `detail` | `query-meal-detail` 的 `rounds` 非空，**证实是套餐** | 高，可直接用 |
| `tag` | 标签命中「套餐/组合/超值/双人/全家/桶」 | 中 |
| `name` | 名称命中上述关键词 | 中 |
| `default` | 两个都没命中，判为单点 | 低（可能漏判套餐） |

> 96 个商品里只对 12 个调了详情（限流与耗时考虑）。要让 `isCombo` 全量可信，把
> `snapshot-fixtures.ts` 里的 `DETAIL_VERIFY_LIMIT` 调到 96 重跑即可（600 次/分钟限流撑得住）。

## 4. `normalized/pricing.json` —— 计价

| 字段 | 类型 | 含义 |
|---|---|---|
| `lines[]` | array | 明细行：`itemId / name / quantity / unitPrice / subtotal`（元与分双写） |
| `productOriginalPrice` | number | 商品原价合计（元） |
| `productPrice` | number | 商品现价合计（元）。**注意不等于应付** |
| `originalPrice` | number | 优惠前应付 |
| `discount` | number | 优惠金额，正数表示省了多少 |
| `payable` / `payableFen` | number | **实付，展示这个** |
| `takeWayOptions[]` | array | 取餐方式；`code`（`eat-in` / `take-in-store`）就是下单要的 `takeWayCode` |

`takeWayCode` 只在 `calculate-price` 里出现，`query-meals` 拿不到 —— 下单链路必须先试算再取值。

## 5. `normalized/plan.sample.json` —— 方案结果样例 ★

前端第三页、第五页照这个填。顶层结构：

| 字段 | 含义 |
|---|---|
| `planId` / `createdAt` / `status` | 方案标识、生成时间、状态（`awaiting_confirm` 待确认） |
| `store` / `orderType` / `beType` / `takeWay` | 归属门店与取餐方式 |
| `strategy` | **方案策略**：`id`/`name`/`summary`/`rationale`（为什么这么配）/`rejectedAlternatives`（为什么没选别的方案） |
| `members[]` | **每人分到的餐品和数量、每人花费**，见下 |
| `totals` | **总价**：`productOriginalPrice`（商品）、`discount`（优惠）、`payable`（应付）、`perPersonAvg`（人均）、`budgetRemaining`（剩余预算） |
| `coupons` | 券的可用情况；`availableCount: 0` 时要提示「无券可用，按原价」 |
| `preferenceMatch` | **偏好匹配**：总分 `score`（0–1）+ `dimensions[]` 四个维度各自打分与说明 |
| `tradeoffs[]` | **取舍说明**：`issue`（冲突是什么）/`chosen`（最终选了）/`alternative`（被放弃的）/`reason`/`costDelta`/`affectedMembers` |
| `unsatisfiable[]` | **无法满足的原因**：`request`/`reason`/`suggestion`/`severity`（`partial` 部分满足 / `blocked` 完全做不到） |
| `nextActions[]` | 底部按钮；`requiresSecondConfirm` 为 true 的必须走二次确认 |

`members[]` 字段：

| 字段 | 含义 |
|---|---|
| `id` / `name` / `budget` | 成员标识、称呼、预算上限（元），并附 `budgetFen` |
| `preferences` | 原始诉求（忌口、想吃、健康），用于回显「你提的要求」 |
| `items[]` | 分到的餐品：`itemId`/`name`/`quantity`/`unitPrice`/`subtotal`（元与分双写）/`isCombo`/`category` |
| `cost` / `costFen` | **该成员分摊到的真实应付**。`Σ costFen === totals.payableFen`，且恒 `≤ budgetFen` |
| `rawSubtotal` / `rawSubtotalFen` | 分摊前该成员在试算明细里的原值，用于排查「为什么我摊这么多」 |
| `budgetOverBy` / `budgetOverFen` | 恒为 0 —— 超预算的方案不会被返回 |
| `budgetCheck` | 固定 `"passed"`，表示分摊后复验过预算 |
| `preferenceMatch` | 该成员自己的匹配情况：`score` + `matched[]` + `unmet[]` |

`totals` 与 `allocation` 的关键字段：

| 字段 | 含义 |
|---|---|
| `totals.payable` / `payableFen` | **实付**，来自 `calculate-price`，展示这个 |
| `totals.discount` / `discountFen` | 优惠金额（正数表示省了多少） |
| `totals.budgetRemainingFen` | 预算合计 − 应付 |
| `allocation.method` | `proportional-largest-remainder`：按原值比例分摊 + 最大余数补零头 |
| `allocation.allocatedFenSum` | 各成员分摊合计，**必须等于 `payableFen`** |
| `allocation.roundingAdjustmentFen` | 整数取整产生的零头调整量 |
| `allocation.budgetCheck` | 分摊后逐人复验预算的结论 |

> 前端只需盯住一条不变量：`Σ members[].costFen === totals.payableFen`。
> 这条不成立就说明服务端算错了，不要靠四舍五入去「圆」它。

## 5.1 `plan.no-solution.sample.json` —— 无解样例

预算不足（¥5 买不到最便宜的主食 ¥14）时的真实返回：

```json
{
  "status": "no_solution",
  "issues": [{ "code": "no_main_within_budget", "memberId": "m1",
               "message": "只带五块钱 预算 ¥5 低于最便宜主食「芝芝火腿扒堡」¥14，无解",
               "budgetFen": 500, "cheapestFen": 1400, "shortfallFen": 900 }],
  "diagnostics": { "memberCount": 1, "budgetTotalFen": 500, "cheapestTotalFen": 1400 }
}
```

无解时**没有 `plan`、没有 `members`、没有 `totals`** —— 前端只能渲染无解态，不能拿空方案凑页面。

---

## 6. 已知问题 / 注意点

1. **商品名两套口径**：`query-meals` 叫「麦乐鸡 / 薯条 / 玉米杯」，`calculate-price` 叫「麦乐鸡5块 / 中薯条 / 小杯玉米杯」。
   本样例以 `calculate-price` 为准（更完整）。前端如果两处都展示，需要统一取一处，否则用户会看到两个名字。
2. **`distance` 单位不明**，且未定位置时门店坐标 `longitude/latitude` 均为 `0`，不要拿它算距离。
3. **`isError` 不能当失败判据**：MCP 层恒为 `false`，业务失败只看 `code !== 200` 或 `success === false`；
   失败时 `data` 键**直接缺失**（不是 `null`）。
4. **`content[0].text` 不进前端**：`query-meals` 一次 25187 字符、`now-time-info` 也有 1216 字符，
   都是给模型看的说明文本。前端只读 `structuredContent.data`。
5. **这些字段还没拿到真实形状**：门店券元素结构（账号无券，只有空数组）、外送/团餐版计价（需真实 `addressId`）、
   已支付订单的状态码。相关 UI 先用 `plan.sample.json` 里的假数据。
