# 麦当劳 MCP 工具盘点

> 用途：工具清点与契约基线，确定「麦门饭局调解所」用哪些工具、按什么顺序串。
> 数据来源：**2026-10-25 01:31 实测 `tools/list`**（`npm run mcp:probe -w @mcd/server`），完整 schema 存于 [`mcp-tools.snapshot.json`](./mcp-tools.snapshot.json)。
> 官方 README 表格仅作对照，**运行时 schema 优先**。

## 0. 实测结论

| 项 | 值 |
|---|---|
| 工具总数 | **35**（官方 README 表格只列 33，实测多 2 个：`query-promotions`、`query-survey-coupon`） |
| 端点 | `https://mcp.mcd.cn`，Streamable HTTP |
| 握手 | `initialize` 436ms，返回 `Mcp-Session-Id`，协商协议 `2025-06-18` |
| 服务端标识 | `mcd-mcp v1.0.0`（注意：这是服务自身版本串，与文档版本日志的 1.0.9 不是一套编号） |
| 鉴权 | `Authorization: Bearer <32位 token>`；无 token → 403，假 token → 401 |
| 限流 | 600 次/分钟/Token，超限 429 |

## 1. 返回体结构（接入前必须知道）

`tools/call` 返回三个字段：`content`、`structuredContent`、`isError`。

- **`structuredContent` 是给程序用的**：统一信封 `{ success, code, message, datetime, traceId, data }`（**`datetime` 是实测新增，文档未写**）。App 应该只读这里。
- **失败时没有 `data` 键**，且 MCP 层 `isError` 恒为 `false` —— 业务失败只看 `code !== 200` 或 `success === false`。详见 [`mcp-data-shapes.md`](./mcp-data-shapes.md)。
- **`content[0].text` 是给模型看的**：`# API Response Information ...` 开头的 Markdown，含字段说明 + 数据，单次 1200+ 字符。塞进前端会浪费上下文。
- 工具描述里夹带大量 agent 指令（如 `draw-lottery` 写着"必须展示 nextConsumption 并得到明确确认"）。**不要在 UI 里原样展示 `description`**。
- 所有工具的 `title` 字段为空，展示名需要自己维护 i18n 映射。

## 2. 工具全清单（35）

### 2.1 门店与地址（4）

| 工具 | 作用 | 必填 | 读写 |
|---|---|---|---|
| `query-nearby-stores` | 到店自取 `beType=1` / 得来速 `beType=5` 查门店 | `beType`,`searchType`（=2 时另需 `city`,`keyword`） | 只读 |
| `delivery-query-stores` | 麦乐送 `beType=2` / 团餐 `beType=6` 按地址查门店 | `beType`,`addressId` | 只读 |
| `delivery-query-addresses` | 查配送地址列表 | — | 只读（敏感） |
| `delivery-create-address` | 新增配送地址 | `city`,`contactName`,`phone`,`address`,`addressDetail` | 写 + 个人信息 |

### 2.2 菜单与商品（4）

| 工具 | 作用 | 必填 | 读写 |
|---|---|---|---|
| `query-meals` | 门店实时菜单（分类、餐品编码、标签） | `storeCode`,`orderType`,`beType` | 只读 |
| `query-meal-detail` | 套餐组成、`supportModify` 特调项 | `storeCode`,`orderType`,`beType`,`code` | 只读 |
| `list-nutrition-foods` | 营养数据（热量/蛋白/脂肪/钠/钙） | — | 只读 |
| `query-meal-assistance` | 团餐助餐服务，产出 `gmServiceCode` | `storeCode` | 只读 |

### 2.3 促销与券（5）

| 工具 | 作用 | 必填 | 读写 |
|---|---|---|---|
| `query-promotions` | **实测新增**：团餐场景满减/满折规则原始数据（`promotionType` 31 满减 / 33 折扣） | `storeCode`,`orderType`,`beType` | 只读 |
| `query-store-coupons` | 当前门店 + 订单形态下**可用**的券（下单有效性以它为准） | `storeCode`,`orderType`,`beType` | 只读 |
| `available-coupons` | 麦麦省可领券列表 | — | 只读 |
| `auto-bind-coupons` | 一键领取所有可领券 | — | 写（领券） |
| `query-my-coupons` | 卡包已拥有的券（**不能**替代 `query-store-coupons`） | `page`,`pageSize` 均可选 | 只读（敏感） |

### 2.4 计价与下单（2）

| 工具 | 作用 | 必填 | 读写 |
|---|---|---|---|
| `calculate-price` | 试算金额/配送费/优惠/应付；`items[]` 支持 `couponId`、`modification`、`withOrder` | `storeCode`,`orderType`,`beType`（其余 6 项按场景） | 只读（试算） |
| `create-order` | 真下单，返回 `orderId`、`payId`、`payH5Url` | `storeCode`,`orderType`,`beType`；到店需 `takeWayCode`，外送需 `addressId` | **写、不可逆** |

### 2.5 订单（5）

| 工具 | 作用 | 必填 | 读写 |
|---|---|---|---|
| `query-order` | 订单状态与明细 | `orderId` | 只读 |
| `order-list` | 近期到店/外送历史订单 | — | 只读 |
| `cancel-order` | 取消订单，`cancelReasonCode`：1 改主意 / 2 重复下单 / 3 点错 / 4 地址错 / 5 时间错 / -1 其它 | `orderId`,`cancelReasonCode` | 写、可挽回 |
| `query-survey-coupon` | **实测新增**：按订单号查 CSAT 满意度答卷与关联奖券 | `orderId` | 只读 |
| `now-time-info` | 服务器时间（相对日期、预约时间不明确时先调） | — | 只读 |

### 2.6 活动（1）

| 工具 | 作用 | 必填 | 读写 |
|---|---|---|---|
| `campaign-calendar` | 当月活动日历，返回营销文案 Markdown | `specifiedDate` 可选 | 只读 |

### 2.7 积分与麦麦商城（6）

| 工具 | 作用 | 必填 | 读写 |
|---|---|---|---|
| `query-my-account` | 积分账户（可用/累计/冻结/将过期） | — | 只读（敏感） |
| `mall-points-products` | 可兑商品列表，`catRuleIds` 筛类目（1>4 商品券、2 实物、1>6>20 生日派对…） | `catRuleIds` 可选 | 只读 |
| `mall-product-detail` | 商品详情、`skuList[].skuId`、`spuCategory`（1 虚拟 / 2 实物）、`shopId` | `spuId` | 只读 |
| `mall-create-order` | 积分兑换下单，虚拟与**实物合并**（`spuCategory="2"` 时 `addressId` 必填） | `skuId`,`spuCategory` | **写、扣积分** |
| `mall-order-list` | 商城订单列表（`lastId`+`size` 翻页） | — | 只读 |
| `mall-order-detail` | 商城订单详情 | `orderId` | 只读 |

### 2.8 积分抽奖（3）

| 工具 | 作用 | 必填 | 读写 |
|---|---|---|---|
| `query-lottery-info` | 活动状态、奖品、`drawDecision`（本次消耗、是否够格） | — | 只读 |
| `draw-lottery` | 抽一次；服务端原子扣次数/积分 | — | **写、消耗积分** |
| `query-my-prizes` | 我的奖品（`pageNum`/`pageSize` 可选） | — | 只读 |

### 2.9 主题活动（5）

| 工具 | 作用 | 必填 | 读写 |
|---|---|---|---|
| `query-party-city` | 活动可参与城市（需先有 `spuId`） | `spuId` | 只读 |
| `query-party-store` | 城市下的可参与门店 | `code`（另需 `latitude`/`longitude`/`spuId`） | 只读 |
| `query-party-store-date` | 门店可预约日期 | `spuId`,`storeCode` | 只读 |
| `query-party-store-session` | 日期下的场次 | `spuId`,`storeCode`,`dateStr` | 只读 |
| `party-order-create` | 按 `spuId`/`skuId`/城市/门店/日期/场次建单，`partyType` 1 包场 / 2 拼团 | `partyType`（其余 11 项按链路） | **写、不可逆** |

## 3. 与官方 README 表格的差异（实测校准）

| 差异 | 说明 |
|---|---|
| `query-promotions` | README 未列。团餐满减/满折规则查询，**只在 `beType=6` 可用** |
| `query-survey-coupon` | README 未列。CSAT 满意度 + 关联奖券 |
| `query-party-store-date` / `query-party-store-session` | README 写作 `query-partystore-date` / `query-partystore-session`，**连字符位置不同**，用错会 404/工具不存在 |
| `mall-create-order-physical` | **不存在**。实物与虚拟合并进 `mall-create-order`，靠 `spuCategory` 区分 |
| `cancel-order` | README 只写"取消订单"，实测还要求 `cancelReasonCode` 枚举 |
| `beCode` 规则 | **到店自取 `beType=1` 不传 `beCode`**；得来速/麦乐送/团餐必传。此前"全链路回传"的说法要修正 |
| `title` 字段 | 全部为空，UI 展示名需自建映射 |

## 4. 业务线矩阵

| 场景 | `beType` | `orderType` | 门店查询 | `beCode` | 关键链路 |
|---|---|---|---|---|---|
| 到店自取 | 1 | 1 | `query-nearby-stores` | 不传 | 门店 → 券 → 菜单 → 详情 → 计价（取 `takeWayList[].code` 作 `takeWayCode`）→ 下单 |
| 得来速 | 5 | 1 | `query-nearby-stores` | 必传 | 同上 |
| 麦乐送 | 2 | 2 | `delivery-query-stores` | 必传 | 地址 → 门店 → 券 → 菜单 → 计价（含配送费）→ 下单 |
| 企业团餐 | 6 | 2 | `delivery-query-stores` | 必传 | 地址 → 门店 → `query-promotions` → 助餐 → 券 → 菜单 → 计价（必带 `gmServiceCode`）→ 下单 |

规约：

- `orderType` 只有 `1`（到店）/ `2`（外送），与 `beType` 是两套概念。
- 预约场景 `reservationDate` 格式 `yyyy-MM-dd HH:mm`，从查券到下单必须一致。
- 价格单位：`calculate-price` 是**分**（无引号整数，展示 /100）；其余工具金额已是**元**字符串。

## 5. 风险分级

| 级别 | 工具 | 约束 |
|---|---|---|
| 只读 | 26 个 | 可自由调用，注意 600/min |
| 写但可挽回 | `cancel-order`、`auto-bind-coupons` | 对话内二次确认后执行 |
| 写且花钱/扣积分 | `create-order`、`mall-create-order`、`draw-lottery`、`party-order-create` | **必须二次确认**，服务端留痕，不允许模型自行决定 |
| 个人信息 | `delivery-create-address`、`delivery-query-addresses`、`query-my-coupons`、`query-my-account` | 只走服务端，不落前端日志，不回显完整手机号 |

`create-order` 只返回支付链接，钱由用户在支付页完成；但订单已创建，属实质副作用。

实测补充（2026-10-25 02:50，1 单 ¥5 空跑）：未支付订单 `createTime + 15 分钟` 自动过期（`expirePayTime`）；`cancel-order` 成功看 `data.cancelResult` 布尔而非 `code`；状态判定用 `status` 字符串码（`10` 待支付 / `60` 已取消），`orderStatus` 只是中文文案。详见 [`mcp-order-shapes.md`](./mcp-order-shapes.md)。

## 6. 对本项目的最小工具集

「麦门饭局调解所」的核心是**多人协商**：几个人口味/预算/热量诉求不同，系统要算出一单大家都能接受的组合，并把差价讲清楚。协商阶段本质是反复试算，`calculate-price` 是唯一成本函数。

**MVP（只读，8 个）**

`now-time-info` → 门店（`query-nearby-stores` / `delivery-query-stores`）→ `query-meals` → `query-meal-detail` → `query-store-coupons` → `calculate-price` → `list-nutrition-foods` → `query-my-coupons`

**成交层（写，2 个，需二次确认）**

`create-order` → `query-order`（支付链接给用户，状态靠轮询查，不靠模型口头宣告）

**二期（按需）**

`campaign-calendar` + `available-coupons` + `auto-bind-coupons` 做"今天有什么优惠"；`mall-*` 做积分玩法；`party-*` 做线下聚会；团餐（`query-promotions` + `query-meal-assistance`）适合"公司下午茶"场景。

**暂不纳入**：`draw-lottery`、`party-order-create`、`delivery-create-address`（不可逆或涉个人信息，收益低）。

## 7. 工程落地状态

| 环节 | 状态 |
|---|---|
| Token 落 `.env` | ✅ `MCD_MCP_URL` / `MCD_MCP_TOKEN`，已被 `.gitignore` 排除；服务端用 Node 原生 `--env-file-if-exists` 读取 |
| MCP client | ✅ [`apps/server/src/mcp/client.ts`](../apps/server/src/mcp/client.ts)：`initialize` → `notifications/initialized` → `tools/list`（含游标分页）→ `tools/call`，处理 `Mcp-Session-Id` 与 SSE 分帧 |
| 错误映射 | ✅ [`errors.ts`](../apps/server/src/mcp/errors.ts)：401/403/429/超时/网络/解析失败 → 稳定 `kind` |
| 配置校验 | ✅ [`config/env.ts`](../apps/server/src/config/env.ts)：缺变量给可执行提示，并拦截 `VITE_*TOKEN` 泄漏 |
| 工具清单固化 | ✅ 本文 + `mcp-tools.snapshot.json`（可用 `npm run mcp:probe -w @mcd/server` 重新生成） |
| `data` 形状固化 | ✅ [`mcp-data-shapes.md`](./mcp-data-shapes.md) + `mcp-data-shapes.json`（`npm run mcp:shapes -w @mcd/server` 重新生成；8 个 MVP 只读工具实跑，脱敏后入库） |
| 写链路形状固化 | ✅ [`mcp-order-shapes.md`](./mcp-order-shapes.md) + `mcp-order-shapes.json`（`npm run mcp:order -w @mcd/server -- --confirm`：真建一单 ¥5 不付款→抓形状→立即取消，已验证 `status 10→60`） |
| HTTP 路由对接前端 | ⬜ 未做（按 CONTRIBUTING，需先定接口契约再实现） |

## 8. 仍未确认

- **已解决（2026-10-25 02:00 实跑）**：8 个 MVP 只读工具的 `data` 形状已全部抓取，见 [`mcp-data-shapes.md`](./mcp-data-shapes.md)。顺带纠正三处口径：`modification` 在 `rounds[].choices[]` 内、`takeWayList` 由 `calculate-price` 返回、金额在 `calculate-price` 是「分」而 `query-meals` 是「元字符串」。
- **仍未验证**：`query-store-coupons` 的元素形状（该账号所有门店均为 0 券，只确认 `data: []`）；`withOrder` 随单购；外送/团餐版 `calculate-price`（需真实 `addressId`）；`needTableware`、`remark`（≤50 字，仅外送）。
- 本次取样在凌晨，门店全部 `businessStatus=false`，菜单/价格均走 `reservationDate` 预约链路；营业时段需复跑一次校准即时价。
- 写链路的**已支付**状态码（`20`/`30`/`40`…）、`pickupCode` 填充时机、支付链接有效期均未验证 —— 需要真付款一次，取样不值得花这个钱。
