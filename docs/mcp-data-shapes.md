# 麦当劳 MCP `data` 形状实测（MVP 8 个只读工具）

> 用途：把 `structuredContent.data` 的**真实形状**固化下来，作为服务端 TypeScript 类型与前端渲染的直接依据。
> 生成方式：`npm run mcp:shapes -w @mcd/server`；原始快照见 [`mcp-data-shapes.json`](./mcp-data-shapes.json)（已脱敏：手机号、券码、带签名图片 URL 均掩码，长字符串截断到 160 字符）。
> 工具清单与入参见 [`mcp-tools.md`](./mcp-tools.md) 与 [`mcp-tools.snapshot.json`](./mcp-tools.snapshot.json)。

## 0. 取样条件（读结论前先看这个）

| 项 | 值 |
|---|---|
| 取样时间 | 2026-10-25 02:00（服务端时间，GMT+8） |
| 账号 | 单一真实 Token（`query-my-coupons` 只有 1 张券） |
| 门店 | 北京 5 家（首个：`1950059` 麦当劳北京新王府井餐厅） |
| 关键约束 | **凌晨门店全部 `businessStatus: false`**，`query-meals` 直接报 `600057 门店可能已关闭或不在营业时间` |
| 绕过方式 | 门店相关工具统一带 `reservationDate=2026-10-25 12:00` 走**预约链路**，返回 200 |
| 调用量 | 15 次 `tools/call`（MVP 12 次 + 门店发现 2 次 + 赠品取样 1 次），限流 600/min 无压力 |

⚠️ 这带来一个必须记住的口径差：**本次所有价格/菜单都是「预约今天 12:00」的报价，不是即时价**。白天营业时段复跑同一脚本，价格与可售商品可能不同（尤其早餐档）。

## 1. 横切结论（不看清这 8 条会写出错代码）

| # | 结论 | 证据 / 影响 |
|---|---|---|
| 1 | **信封比文档多一个 `datetime`** | 实际 `structuredContent = {success, code, message, datetime, traceId, data}`，文档只写了 5 个。`datetime` 是 ISO 时间串，可当服务端时钟用 |
| 2 | **`isError` 永远是 `false`** | `600050`、`600057` 这类业务失败也是 MCP 层 `isError:false`，只能在 `data.code !== 200` 或 `success === false` 里判断。**绝不能拿 `isError` 当失败判据** |
| 3 | **失败时没有 `data` 键** | `搜索收藏为空`、`门店未营业` 的响应里 `data` 直接缺失（不是 `null`）。取 `data` 前必须先看 `code` |
| 4 | **`content[0].text` 开销恒定存在** | `now-time-info` 只有 11 个字段，`content` 文本却有 **1216 字符**（`# API Response Information …` 说明 + 字段讲解）。`query-meals` 一次 **25187 字符**。这份文本只该进模型上下文，不该进前端 |
| 5 | **`calculate-price` 的金额单位是「分」** | `productPrice: 2990` = ¥29.90。而 `query-meals.meals[].currentPrice` 是**元字符串**（`"29.9"`）。两套单位，混用就是 100 倍错误 |
| 6 | **`data.meals` 是动态字典，不是数组** | 96 个键全是商品码（`1100`、`1401`…），`tools/list` 里却声明成带 `mapKey` 占位属性的普通对象。类型要写成 `Record<string, Meal>` |
| 7 | **`list-nutrition-foods.data` 是紧凑表格字符串** | `[160]{productName,energyKj,…}:\n  猪柳麦满分,null,1288,…`，**不是 JSON**，`JSON.parse` 必失败。`[160]` 是行数，`{}` 内是列名，之后每行逗号分隔；实测 160 行/9 列，`nutritionDescription` 整列为字符串 `"null"` |
| 8 | **`outputSchema` 声明的是「全集」，实际按场景裁剪** | `calculate-price` 声明 15 个字段，到店自取只返回 7 个（无 `deliveryPrice`/`packingPrice`/`enjoyed`/`enjoyable`/`mealAssistanceList`…）。类型里这些字段必须 `?` 可选 |

另有两条与上文 `mcp-tools.md` 的修正：

- `query-meal-detail` 的 `supportModify` / `modification` **不在顶层**，在 `rounds[].choices[]` 里。顶层只有 `code`/`name`/`rounds`/`image`/`supportModify`（`supportModify` 顶层这个是对的，但 `modification` 只在 choice 里）。
- `takeWayList`（拿 `takeWayCode` 的地方）**由 `calculate-price` 返回**，`query-meals` 里没有。

## 2. 逐工具实测形状

### 2.1 `now-time-info` — 11 字段，无差异

```text
{ timestamp:number, datetime:string "2026-10-25T01:57:28.367",
  formatted:string "2026-10-25 01:57:28", date:string "2026-10-25",
  year:number, month:number, day:number,
  dayOfWeek:string "SUNDAY", timezone:string "GMT+08:00",
  offset:string "+08:00", utc:string "2026-10-24T17:57:28.367Z" }
```
与 `outputSchema` 完全一致（drift 0）。`formatted` 可直接喂给 `reservationDate` 的日期部分。

### 2.2 `query-nearby-stores` — 3 处差异

```text
data: Array<{
  storeCode, storeName, address,
  distance:number, businessStatus:boolean,
  businessStartTime "06:00", businessEndTime "22:00",
  longitude:number, latitude:number,      // ← 声明里没有
  reservation:boolean,
  reservationTimeOptions: Array<{ date, today:boolean, reservationOptionText }>
}>                                        // 声明里的 beCode 实际不存在（到店自取不传）
```

- 差异：多 `longitude` / `latitude`；缺 `beCode`（`beType=1` 场景本来就不需要，与文档「到店自取不传 beCode」一致）。
- 实测坑：`searchType=1`（收藏餐厅）对新账号必然返回 `600050 收藏餐厅列表为空`，**`searchType=2` + `city` + `keyword` 才是可用路径**。
- `longitude/latitude` 实测都是 `0`（未按定位搜索时），别拿它算距离；`distance` 也是小整数（门店排序用，米/公里不明）。

### 2.3 `query-meals` — 25187 字符，3 处差异

```text
data: {
  categories: Array<{ name, meals: Array<{ code, tags:string[] }> }>   // 15 个分类
  meals: Record<string, {                                            // 96 个商品码
    name, image, currentPrice:"29.9", originalPrice:"35", canWithOrder:boolean
  }>                                                                 // 声明里的 discountType / withOrder 实际没有
}
```
- `categories[].meals[]` 只给 `{code, tags}`，**展示信息全在 `meals` 字典里**，必须 join 一次。
- `frequent`（常点）声明了但实测缺失 → 类型上要可选。
- 声明里 `meals.*` 有 `discountType`、`withOrder`，实测都没有；`withOrder` 只在 `canWithOrder=true` 的少部分商品上才出现（本次抽样未覆盖）。

### 2.4 `query-meal-detail` — 1 处差异（位置错配）

```text
data: {
  code, name, image, supportModify:boolean,
  rounds: Array<{
    id:number, name "选择套餐内小食", quantity, maxQuantity, minQuantity,
    choices: Array<{
      code, name, quantity, maxQuantity, isDefault:1|0, diffPrice:"+ ¥0",
      supportModify:boolean,
      modification?: { items: Array<{
        maxValues:number, minValues:number,
        values: Array<{ code, price:number, name,
                        maxQuantity, minQuantity,
                        selectedQuantity, selectedKey:"0-1", unselectedKey:"0-0" }>
      }> }
    }>
  }>
}
```
- **`modification` 在 `rounds[].choices[]` 内**，不在顶层（这正是那 1 处 `declared-missing`）。
- 特调规则实锤：`selectedKey`/`unselectedKey` 是 `"轮-值"` 形式（`0-1` = 第 0 项选 1 个），`values[]` 里 `price:0` 表示免费特调；`maxValues:2` 表示最多选 2 项。
- `quantity/maxQuantity` 里 `-1` 表示不限（`maxQuantity:-1`），**别直接当上限用**。

### 2.5 `query-store-coupons` — 空数组（本次没取到元素形状）

```text
data: []          // 6 次调用、3 家北京门店 × (带/不带 reservationDate) 全部为空
```
- 追加验证（脚本外）：上海/深圳 `beType=1`、广州/上海 `beType=5`（含 `beCode`）各 3 家店，**依旧全为 `[]`**。
- 结论：**该账号当前没有门店券**，`data` 形状只能确认是「数组」，元素结构仍未验证。`content` 文本也只是 772 字符的字段说明，没有数据。
- 影响：`query-store-coupons` 的元素类型暂时只能按 `query-my-coupons` 的券结构近似，**待有券账号复跑后再定稿**。

### 2.6 `list-nutrition-foods` — 紧凑表格，160 行 × 9 列

```text
data: string
"[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
  猪柳蛋麦满分,null,1618,387,23,21,25,846,243
  …"
```
- 解析规则：`^\[行数\]\{列名,...\}:\n` + 每行 `逗号分隔`。实测 `[160]` 与实际行数 **一致**（160）。
- `nutritionDescription` 整列都是字符串 `"null"` → **按缺失处理**，不要当文案渲染。
- 单位：`energyKj`/`energyKcal` 双份、`protein/fat/carbohydrate/sodium/calcium` 推测为 g/mg，**文档没写单位，需业务确认**。

### 2.7 `query-my-coupons` — 60 字段 / 声明 20 字段（drift 52）

```text
data: { coupons: Array<Coupon>, totalCount, currentPage, pageSize, totalPages }

Coupon（60 个字段，声明只有 20 个）：
  摘要层   id, code, title, subtitle, showType:100, image, bigImage,
           tradeStartDate, tradeEndDate, tradeStartDateTime, tradeEndDateTime,
           enable:0|1, discountInfo
  规则层   weekdays, isAllTradeTime, tradeTimePeriods[{startTime:"10:30:00", endTime:"23:59:59"}],
           orderType, orderTypes[], beType, beTypes[], filterValues[], channels[],
           supportReservation, supportSoldOut, appliedCategory, fulfillment,
           multipleProducts, promotionId, couponCardType, mpCouponType,
           couponPromotionType, promotionChildrenType, isPrepaid, ifFreeCoupon
  展示层   tags[{type, value, label, color}], instructions{labels:[{text, color}]},
           reducePrice, reducePriceText, btnText, disableBtnText, toastText,
           channelIconUrls[], datetimeText, bindButtonGif, receivedDaysMsg
  风控层   isCanGive, isGiveAway, shareThemeId, unavailableType, jumpUseScenes[],
           currentChannelCanRedeem, onlyAppCanRedeem, onlyPosCanRedeem,
           paymentType, paymentTypeForSort, receiveTime, receivedDays,
           currentDayAvailableCount, totalAvailableCount, totalCount
```
- `discountInfo` 实际 4 字段：`discountValue / discountDesc / discountTypePosition / discountTypeText`（声明只有前 2 个）。
- 实测信号：`instructions.labels[].text` 出现了 `"未到使用时间"`、`"到店"` —— **这张券当前不可用**，`enable` 与 `currentChannelCanRedeem` 才是可用性判据，别只看 `enable`。
- 项目约束：`id`/`code` 属敏感，快照里已掩码；前端不要整串回显，服务端日志同样要脱敏。

### 2.8 `calculate-price` — 7 字段（到店自取），8 处声明字段缺失

```text
data: {
  productOriginalPrice:2990, productPrice:2990,
  originalPrice:2990, discount:0, price:2990,          // 全部单位：分
  productList: Array<{ productCode, productName, quantity, originalSubtotal, subtotal }>,
  takeWayList: Array<{ code:"eat-in"|"take-in-store", title:"堂食"|"外带", subtitle }>
}
```
- 声明里 15 个字段，到店自取只回 7 个；`deliveryPrice`/`deliveryOriginalPrice`/`packingPrice`/`packingOriginalPrice`/`enjoyed`/`enjoyable`/`mealAssistanceList`/`tenderList` 全部缺失 → **外送/团餐场景才有**。
- **`takeWayList[].code` 就是下单要的 `takeWayCode`**（`eat-in` / `take-in-store`）。这个值只在 `calculate-price` 里出现，`query-meals` 拿不到 —— 下单链路必须先试算再取值。
- `productPrice`（商品小计）≠ `price`（应付）：本例恰好相等（`discount:0`），有优惠时必须用 `price`。

### 2.9 附：`available-coupons`（MVP 外，赠品取样）

```text
data: Array<{ couponName, couponImage, couponStatus:"CAN_GET", label:"可领取" }>   // 3 条
```
- 只有 4 个字段，**与 `query-store-coupons` / `query-my-coupons` 的元素结构完全不同**，是三套独立模型，不能共用类型。
- 读它是为了在「门店 0 券」时至少有一个可渲染的券列表形状；`auto-bind-coupons`（写）**未调用**。

## 3. 差异汇总（`outputSchema` vs 实测）

| 工具 | drift | 主要问题 | 处理 |
|---|---|---|---|
| `now-time-info` | 0 | — | 可直接按声明写类型 |
| `query-nearby-stores` | 3 | 多 `longitude/latitude`，缺 `beCode` | 类型加两个数字字段，`beCode?` 可选 |
| `query-meals` | 3 | `frequent` 缺失；`meals.*` 无 `discountType`/`withOrder` | 全部改可选；`meals` 写 `Record<string, Meal>` |
| `query-meal-detail` | 1 | `modification` 在 `choices[]` 内 | 按实测层级写类型 |
| `query-store-coupons` | 0 | 空数组，元素未验证 | 暂缺，见 §4 |
| `list-nutrition-foods` | 0 | 类型标 `string` 是**对的**，但内容是表格 | 自写解析器 |
| `query-my-coupons` | 52 | 声明只覆盖 20/60 字段 | 按实测 60 字段建类型，未用的也留着 |
| `calculate-price` | 8 | 声明含外送/团餐字段 | 全部可选，到店只读 7 个 |

`drift` 总数 64 条，其中 52 条来自 `query-my-coupons` —— **它的 `outputSchema` 基本不可用，以实测为准**。

## 4. 仍未取到 / 需白天复跑

| 项 | 原因 | 复跑条件 |
|---|---|---|
| `query-store-coupons` 元素形状 | 账号无门店券 | 换一个有券的账号，或白天营业时段 |
| `withOrder`（随单购）+ `discountType` | 抽样商品未命中 | 挑 `canWithOrder=true` 的商品 |
| 外送/团餐版 `calculate-price` | 需 `addressId` 且未走该链路 | 有真实地址后补 `delivery-query-addresses` → `delivery-query-stores` |
| 即时价 vs 预约价差异 | 取样在凌晨，全部走 `reservationDate` | 营业时段（06:00–22:00）不带 `reservationDate` 复跑 |

复跑一条命令即可，`docs/mcp-data-shapes.json` 会被覆盖并带上新的 `capturedAt`：

```powershell
npm run mcp:shapes -w @mcd/server
```

## 5. 对服务端类型层的结论

1. 信封类型 `{ success, code, message, datetime, traceId, data? }`，**`data` 可选**；只有 `code === 200` 时才读。
2. 金额统一在服务端转成「分」的整数再出接口，前端不碰字符串元。
3. 三个券模型（门店券 / 卡包券 / 可领券）分别建模，字段不共用。
4. `meals`、`stores` 这些动态字典在类型里一律 `Record<string, T>`；`outputSchema` 的 `mapKey` 占位不可信。
5. `list-nutrition-foods` 的解析器要有单测（列数、行数、`"null"` 列）。
