# 麦当劳 MCP 写链路实测（`create-order` → `query-order` → `cancel-order`）

> 用途：把「成交层」三个工具的真实载荷固定下来。这三个工具的 `data` 无法只读观察，只能真建一单。
> 生成方式：`npm run mcp:order -w @mcd/server -- --confirm`；原始快照 [`mcp-order-shapes.json`](./mcp-order-shapes.json)（`orderId` 打码、支付链接不落盘）。
> 只读工具的基线见 [`mcp-data-shapes.md`](./mcp-data-shapes.md)。

## 0. 这次到底发生了什么（可审计）

| 项 | 值 |
|---|---|
| 时间 | 2026-10-25 02:49:59（服务端时间） |
| 门店 | `1950059` 麦当劳北京新王府井餐厅 |
| 商品 | `515837` 圆筒冰淇淋 × 1，**应付 ¥5.00**（`calculate-price` → `price:500`） |
| 取餐方式 | `takeWayCode=eat-in`（堂食）—— 脚本取了 `takeWayList[0]`，不是原计划的外带，见 §4 |
| 订单号 | `1030…`（已打码） |
| 支付 | **未支付**。`payH5Url` 已返回但**没有打开、没有落盘** |
| 取消 | `cancel-order(cancelReasonCode=1)` → `cancelResult:true` |
| 复验 | 再查一次 `query-order`：`status:"60"` / `orderStatus:"订单已取消"` |
| 支出 | ¥0 |

> 附带发现：未支付订单自带 `expirePayTime` = `createTime + 15 分钟`（02:49:59 → 03:04:59）。即使取消失败了，订单也会在 15 分钟后自动关闭，不会一直挂着。

## 1. `create-order` 的返回：外面包一层 `orderDetail`

```text
data: {
  orderId: string,
  payId: string,
  payH5Url: string,          // 支付页链接，只给用户，不写日志/不落盘
  orderDetail: {             // ← 注意这层：详情被包起来了
    orderId, orderStatus:"待支付", status:"10",
    storeName, storeAddress,
    orderProductList: Array<{
      productName, productImage, quantity,
      price:"5",             // 元字符串
      comboItemList:[]       // 套餐子项，单品为空数组
    }>,
    totalAmount:"5", realTotalAmount:"5", totalDiscountAmount:"0",
    productPrice:"5", deliveryPrice:"0", realDeliveryPrice:"0",
    couponList:[],
    createTime:"2026-10-25 02:49:59",
    expirePayTime:"2026-10-25 03:04:59",
    needTableware:false, takeWay:"堂食", pickupCode:"", remark:"",
    payId
  }
}
```

**`query-order` 的 `data` 就是 `create-order.data.orderDetail` 原样摊平**，字段一个不差。所以这两个工具可以共用一个 `OrderDetail` 类型，只是 `create-order` 多了 `orderId/payId/payH5Url` 三个外层字段。

## 2. 三个状态字段要一起看

| 字段 | 实测值 1 | 实测值 2 | 说明 |
|---|---|---|---|
| `orderStatus` | `"待支付"` | `"订单已取消"` | **中文文案**，不要拿来做逻辑判断 |
| `status` | `"10"` | `"60"` | **字符串**状态码，逻辑判断用这个 |
| `cancelResult` | — | `true` | 只在 `cancel-order` 返回，布尔 |

已知状态码：`10` = 待支付、`60` = 已取消。**其余（已支付/制作中/已完成/退款）未验证**，不要凭猜测写枚举 —— 需要真付一次才能确认，本次刻意没做。

`status` 是字符串不是数字：`status === 10` 永远为 false，必须写 `status === '10'`。

## 3. `cancel-order` 的返回极简

```text
data: { cancelResult: true, orderId: "1030…" }
```
- 成功与否看 `data.cancelResult`（布尔），不是看 `code`（`code` 也是 200，但真正的结论在 `cancelResult`）。
- `cancelReasonCode` 传的是**字符串** `"1"`（1 改主意 / 2 重复下单 / 3 点错 / 4 地址错 / 5 时间错 / -1 其它），虽然 schema 写 `string`，实测必须带。
- 取消后**订单不会被删**，`query-order` 仍能查到，只是状态变 `60`。

## 4. 三个必须记住的口径差

1. **金额单位在同一单里换了一次**：`calculate-price.price = 500`（**分**），`create-order`/`query-order` 里 `totalAmount = "5"`（**元字符串**）。下单前用分算，下单后展示用元。
2. **`takeWayCode` 不能取 `takeWayList[0]`**：实测顺序是 `[eat-in 堂食, take-in-store 外带]`，取第 0 个就是堂食。要外带必须显式找 `code === 'take-in-store'`。脚本这次就是踩了这个坑，订单实际是堂食。
3. **`orderDetail` 是 `create-order` 独有的包装层**：直接读 `create-order.data.status` 会拿到 `undefined`，必须先 `.orderDetail`。

## 5. 与 `outputSchema` 的差异（29 处）

| 工具 | drift | 典型项 |
|---|---|---|
| `calculate-price` | 8 | 缺 `deliveryPrice`/`packingPrice`/`enjoyed`/`mealAssistanceList` 等（外送/团餐字段） |
| `create-order` | 7 | 缺 `orderDetail.deliveryInfo`/`lockerCode`/`lockerQrCode`/`mealAssistance`/`realPackingFeeTotalPrice`；多 `orderDetail.needTableware` |
| `query-order` | 7 + 7 | 同上（两次查询 7 条一致） |
| `cancel-order` | 0 | 声明与实际一致 |

结论同只读侧：**声明是「全集」，实际按 `beType`/`orderType` 裁剪**。到店自取永远拿不到柜机码、餐柜、配送、团餐助餐这些字段，类型里必须全部可选。

## 6. 对 App 的硬性约束

1. `payH5Url` 只允许出现在一次性的跳转里：**不进日志、不进数据库、不进前端埋点**。本次探针直接把它替换成 `<payment-url-hidden>`。
2. 下单后判定「是否付成功」不能靠模型口头说，只能轮询 `query-order` 看 `status` 从 `10` 变化；未付满 15 分钟会自动关闭（`expirePayTime`）。
3. `cancel-order` 是**可挽回**操作，但也必须二次确认，且以 `cancelResult` 为准。
4. 重试安全：同一份 `items` 重复调 `create-order` 会产生**多个真实订单**。App 侧必须自己做幂等（客户端生成的请求 id + 服务端落库去重）。

## 7. 仍未验证

| 项 | 原因 | 怎么补 |
|---|---|---|
| 已支付后的状态码（20/30/40…） | 本次刻意不付款 | 需要真付一次 ¥5，不建议为取样付钱 |
| `pickupCode` 何时填充 | 未支付时为空串 | 同上 |
| 支付链接有效期 | 只观察到订单 15 分钟过期 | 同上 |
| 取消后是否释放库存 | 无接口可观测 | 只能信服务端 |
| 外送/团餐版 `create-order` | 需 `addressId` / `gmServiceCode` | 有地址后先跑 `delivery-query-stores` 补 `calculate-price`，再考虑下单 |
