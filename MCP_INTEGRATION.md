# MCP 接入说明

本文说明本项目**如何真实调用麦当劳 MCP**：用了哪些工具、怎么握手、失败怎么判定、踩过哪些坑。
代码全部在 `apps/server/src/`，无需任何第三方 MCP SDK。

## 1. 接入事实

| 项 | 值 |
|---|---|
| 端点 | `https://mcp.mcd.cn`（Streamable HTTP） |
| 鉴权 | `Authorization: Bearer <32 位 token>`，token 从 [open.mcd.cn/mcp](https://open.mcd.cn/mcp) 申请 |
| 协议版本 | 协商结果 `2025-06-18` |
| 服务端标识 | `mcd-mcp v1.0.0` |
| 工具总数 | **35**（官方 README 表格只列 33，实测多 `query-promotions`、`query-survey-coupon`） |
| 限流 | 600 次/分钟/Token，超限 429 |
| Token 位置 | 仓库根 `.env` 的 `MCD_MCP_TOKEN`，已被 `.gitignore` 排除，全程不进前端、不进日志 |

## 2. 本项目实际调用的工具（5 个，全部只读）

| 工具 | 用途 | 调用位置 |
|---|---|---|
| `now-time-info` | 取服务端时间，算预约时间 | `src/mcp/probe-data.ts` |
| `query-nearby-stores` | 关键词搜门店（`searchType=2`） | `src/services/mcd.ts` → `GET /api/stores` |
| `query-meals` | 门店实时菜单（96 个商品 / 15 分类） | `src/services/mcd.ts` → `GET /api/menu` |
| `query-meal-detail` | 用 `rounds` 判定「套餐 vs 单点」 | `src/mcp/snapshot-fixtures.ts` |
| `calculate-price` | 试算真实应付、优惠、取餐方式 | `src/services/mcd.ts` → `POST /api/plan` |
| `query-store-coupons` | 查可用券 | `src/services/plan.ts` |

**有意不调用的写工具**：`create-order`、`mall-create-order`、`party-order-create`、`draw-lottery`、
`auto-bind-coupons`、`delivery-create-address`。这些会花钱、扣积分或写入个人信息，需要用户二次确认，
当前版本不做自动下单。`cancel-order` 仅在一次性验证脚本里用过（建单不付款后立即取消）。

## 3. 调用链

```text
[前端] POST /api/plan
   │
   ├─ query-nearby-stores (beType=1, searchType=2, city, keyword)   ← 10 分钟缓存
   ├─ query-meals         (storeCode, orderType=1, beType=1)        ← 5 分钟缓存
   │     └─ 若报「未营业」→ 自动带 reservationDate 重试一次
   ├─ 本地规则协商：按每人预算/忌口选品，合并成一张订单
   ├─ calculate-price     (storeCode, orderType, beType, items[])
   │     └─ 同样支持「未营业 → 预约链路」降级
   └─ query-store-coupons (失败不阻断，按 0 券处理)
   │
   └─ 返回：members[] + totals(真实应付/优惠) + tradeoffs + unsatisfiable
```

握手顺序：`initialize` → `notifications/initialized` → `tools/list` → `tools/call`。
`Mcp-Session-Id` 由服务端在 `initialize` 响应头下发，后续请求必须回传。
实现见 [`apps/server/src/mcp/client.ts`](../apps/server/src/mcp/client.ts)（原生 `fetch`，含 SSE 分帧解析）。

## 4. 四个必须知道的坑

### 4.1 `isError` 永远是 `false`

业务失败（`600050` 收藏为空、`600057` 门店未营业）在 MCP 层的 `isError` 也是 `false`。
**唯一可靠判据是 `structuredContent.code === 200`**。失败时 `data` 键直接缺失（不是 `null`），
先判 `code` 再取 `data`。

### 4.2 金额有两套单位

| 工具 | 单位 | 例 |
|---|---|---|
| `query-meals.meals[].currentPrice` | 元字符串 | `"29.9"` |
| `calculate-price.*` | 分整数 | `2990` |

混用就是 100 倍错误。转换层统一为 `price`（元）+ `priceFen`（分），见
[`normalize.ts`](../apps/server/src/mcp/normalize.ts) 里的 `toFen()` / `fenToYuan()`。

### 4.3 关门时的业务码不统一

`query-meals` 关门给 `600057`，`calculate-price` 关门给的却是文案「门店暂停营业，请重新选择门店」，
业务码不同。所以降级判据写成「码 `600057` **或** 文案命中 `/营业|暂停|关门|打烊|休息/`」，
见 `mcd.ts` 的 `shouldRetryWithReservation()`。否则换个工具就要改一次判断。

### 4.4 `content[0].text` 不是给前端看的

每次 `tools/call` 都附带一段 `# API Response Information …` 的 Markdown（`query-meals` 单次 **25187 字符**），
是给模型读的字段说明。前端只读 `structuredContent.data`，这段文本一律丢弃。

## 5. 工程约束

| 约束 | 做法 |
|---|---|
| 不引入 MCP SDK | 项目骨架约定「暂不引入业务框架」，`client.ts` 自己实现 4 个方法的子集 |
| 限流保护 | 菜单 5 分钟、门店 10 分钟进程内缓存；一次 `/api/plan` 稳定 3–4 次调用 |
| 连接复用 | `mcd.ts` 里是进程内单例，只在首次请求时握手；`SIGINT/SIGTERM` 时 `DELETE` 会话 |
| 脱敏 | 落盘前掩码手机号、券码、带签名的图片 URL（`snapshot-fixtures.ts` 的 `sanitize()`） |
| 失败不撒谎 | 券查不到就是 0 张，写进 `unsatisfiable`；优惠为 0 就不说「已省钱」 |

## 6. 复现

```sh
npm ci
cp .env.example .env          # 填入 MCD_MCP_TOKEN
npm run dev:server            # 真实调用 MCP
curl http://127.0.0.1:3001/api/health
npm run mcp:fixtures --workspace=@mcd/server   # 重新抓取前端样例
```

实测记录（2026-10-25）：

- `tools/list` 35 个工具，握手 436ms
- `query-meals` 返回 96 商品 / 15 分类 / 27 套餐（12 个由 `query-meal-detail` 证实）
- `POST /api/plan` 3 人：原价 ¥89.8 → 优惠 ¥8.1 → **实付 ¥81.7**，人均 ¥27.23
- 取样时为凌晨，门店 `businessStatus: false`，全部走 `reservationDate` 预约链路

更多数据细节见 [`docs/mcp-tools.md`](mcp-tools.md)、[`docs/mcp-data-shapes.md`](mcp-data-shapes.md)
与 [`apps/server/fixtures/README.md`](../apps/server/fixtures/README.md)。
