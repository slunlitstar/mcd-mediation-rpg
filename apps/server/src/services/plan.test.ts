/**
 * 方案生成器的隔离测试。
 *
 * 关注两件本轮修正的正确性问题，全部离线跑（注入假 menu / 假 price，不连 MCP）：
 *
 * 1. 预算不足必须 `no_solution`，绝不能返回超预算方案；
 * 2. 分摊必须基于真实试算的应付金额、用整数分，且 `Σ成员分摊 === 应付`，
 *    并在分摊后逐人复验预算。
 *
 * 运行：npm run test --workspace=@mcd/server
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { allocateCents, planMeal } from './plan.js';
import type { PlanDependencies } from './plan.js';
import type { UnifiedMenu, UnifiedMenuItem, UnifiedPricing } from '../mcp/normalize.js';

// ---------------------------------------------------------------- 假数据构造

interface MenuSeed {
  id: string;
  name: string;
  priceYuan: number;
  isCombo?: boolean;
  category?: string;
}

function makeMenu(seeds: MenuSeed[]): UnifiedMenu {
  const items: UnifiedMenuItem[] = seeds.map((seed) => ({
    id: seed.id,
    name: seed.name,
    price: seed.priceYuan,
    priceFen: Math.round(seed.priceYuan * 100),
    category: seed.category ?? '测试分类',
    categories: [seed.category ?? '测试分类'],
    isCombo: seed.isCombo === true,
    isComboSource: seed.isCombo === true ? 'detail' : 'default',
    canWithOrder: false,
    tags: [],
  }));

  return {
    store: { id: 'S001', name: '测试门店' },
    currency: 'CNY',
    priceUnit: 'yuan',
    orderType: 1,
    beType: 1,
    capturedAt: '2026-10-25T00:00:00.000Z',
    categories: ['测试分类'],
    items,
    meta: {
      itemCount: items.length,
      comboCount: items.filter((item) => item.isCombo).length,
      comboVerifiedCount: 0,
      orphanCount: 0,
    },
  };
}

/**
 * 假计价器：按菜单价汇总，再叠加「优惠」或「附加费」。
 * `discountFen` 正数表示优惠，`surchargeFen` 正数表示外送费这类加价。
 */
function makePricing(
  menu: UnifiedMenu,
  options: { discountFen?: number; surchargeFen?: number } = {},
): (storeCode: string, items: { productCode: string; quantity: number }[]) => Promise<UnifiedPricing> {
  const byId = new Map(menu.items.map((item) => [item.id, item]));

  return async (_storeCode, basket) => {
    const lines = basket.map((line) => {
      const item = byId.get(line.productCode);
      assert.ok(item, `计价器收到不存在的商品 ${line.productCode}`);
      const subtotalFen = item.priceFen * line.quantity;
      return {
        itemId: item.id,
        name: item.name,
        quantity: line.quantity,
        unitPrice: item.price,
        unitPriceFen: item.priceFen,
        originalSubtotal: item.price * line.quantity,
        originalSubtotalFen: subtotalFen,
        subtotal: (subtotalFen / 100) * 1,
        subtotalFen,
      };
    });

    const productPriceFen = lines.reduce((sum, line) => sum + line.subtotalFen, 0);
    const discountFen = options.discountFen ?? 0;
    const surchargeFen = options.surchargeFen ?? 0;
    const payableFen = productPriceFen - discountFen + surchargeFen;

    return {
      store: { id: 'S001', name: '测试门店' },
      currency: 'CNY',
      priceUnit: 'yuan',
      lines,
      productOriginalPrice: productPriceFen / 100,
      productOriginalPriceFen: productPriceFen,
      productPrice: productPriceFen / 100,
      productPriceFen,
      originalPrice: productPriceFen / 100,
      originalPriceFen: productPriceFen,
      discount: discountFen / 100,
      discountFen,
      payable: payableFen / 100,
      payableFen,
      takeWayOptions: [{ code: 'eat-in', title: '堂食' }],
    };
  };
}

function deps(
  menu: UnifiedMenu,
  priceOptions: { discountFen?: number; surchargeFen?: number } = {},
  couponCount = 0,
): PlanDependencies {
  return {
    menu: async () => menu,
    price: makePricing(menu, priceOptions),
    couponCount: async () => couponCount,
  };
}

const BASIC_MENU = makeMenu([
  { id: 'm-burger', name: '经典牛肉堡', priceYuan: 20 },
  { id: 'm-chicken', name: '香煎鸡腿堡', priceYuan: 18 },
  { id: 'm-spicy', name: '麦辣鸡腿堡', priceYuan: 16 },
  { id: 'm-wings', name: '麦乐鸡', priceYuan: 12 },
  { id: 'm-corn', name: '玉米杯', priceYuan: 8 },
  { id: 'm-drink', name: '可乐', priceYuan: 9 },
]);

// ---------------------------------------------------------------- 1) 预算不足 → 无解

test('预算低于最便宜主食时返回 no_solution，且不返回任何方案', async () => {
  const outcome = await planMeal(
    { storeCode: 'S001', members: [{ id: 'a', name: '穷学生', budget: 10 }] },
    deps(BASIC_MENU),
  );

  assert.equal(outcome.status, 'no_solution');
  assert.equal('plan' in outcome, false, '无解时不得携带 plan');
  assert.equal(outcome.issues.length, 1);

  const issue = outcome.issues[0];
  assert.equal(issue.code, 'no_main_within_budget');
  assert.equal(issue.memberId, 'a');
  assert.equal(issue.budgetFen, 1000);
  // 最便宜的主食是辣味汉堡 16 元，普通用户忌辣后是麦乐鸡以外的主食 —— 这里只断言差值方向
  assert.ok((issue.shortfallFen ?? 0) > 0, '差额应为正数');
  assert.ok((issue.cheapestFen ?? 0) > 1000, '最便宜可行主食应高于预算');
});

test('忌辣条件下商品池为空时返回 no_solution', async () => {
  const spicyOnly = makeMenu([{ id: 's1', name: '麦辣鸡腿堡', priceYuan: 16 }]);

  const outcome = await planMeal(
    { storeCode: 'S001', members: [{ id: 'a', name: '不吃辣', budget: 50, spicy: false }] },
    deps(spicyOnly),
  );

  assert.equal(outcome.status, 'no_solution');
  assert.equal(outcome.issues[0]?.code, 'no_menu_item_matching_constraints');
});

test('单人都买得起但合计应付超过总预算时返回 no_solution', async () => {
  // 两人各 20 元，各买 20 元汉堡 → 明细 40 元；附加费 5 元 → 应付 45 元 > 预算合计 40 元
  const outcome = await planMeal(
    {
      storeCode: 'S001',
      members: [
        { id: 'a', name: '甲', budget: 20 },
        { id: 'b', name: '乙', budget: 20 },
      ],
    },
    deps(BASIC_MENU, { surchargeFen: 500 }),
  );

  assert.equal(outcome.status, 'no_solution');
  assert.ok(outcome.issues.some((issue) => issue.code === 'total_budget_exceeded'));
  assert.equal('plan' in outcome, false);
});

test('分摊后个人超预算时返回 no_solution，而不是硬塞给用户', async () => {
  // 甲预算 50 买 10 元、乙预算 12 买 12 元 → 明细 22 元；附加费 8 元 → 应付 30 元（未超总预算 62）
  // 但按原值比例分摊，乙要承担约 16.36 元 > 12 元预算 → 必须判无解
  const menu = makeMenu([
    { id: 'cheap', name: '小食拼盘', priceYuan: 10 },
    { id: 'small', name: '鸡腿堡', priceYuan: 12 },
  ]);

  const outcome = await planMeal(
    {
      storeCode: 'S001',
      members: [
        { id: 'a', name: '甲', budget: 50 },
        { id: 'b', name: '乙', budget: 12 },
      ],
    },
    deps(menu, { surchargeFen: 800 }),
  );

  assert.equal(outcome.status, 'no_solution');
  assert.ok(outcome.issues.some((issue) => issue.code === 'allocation_exceeds_budget'));
  assert.equal('plan' in outcome, false);
});

test('无解结果里不会出现任何成员花费字段', async () => {
  const outcome = await planMeal(
    { storeCode: 'S001', members: [{ id: 'a', name: '穷学生', budget: 5 }] },
    deps(BASIC_MENU),
  );

  assert.equal(outcome.status, 'no_solution');
  const asRecord = outcome as unknown as Record<string, unknown>;
  assert.equal(asRecord.members, undefined);
  assert.equal(asRecord.totals, undefined);
});

// ---------------------------------------------------------------- 2) 整数分摊

test('有优惠时 Σ成员分摊分文不差地等于应付', async () => {
  // 优惠 8.11 元，让应付变成一个除不尽的数，专门验证零头分配。
  const discountFen = 811;

  const outcome = await planMeal(
    {
      storeCode: 'S001',
      members: [
        { id: 'a', name: '甲', budget: 30 },
        { id: 'b', name: '乙', budget: 30 },
        { id: 'c', name: '丙', budget: 30 },
      ],
    },
    deps(BASIC_MENU, { discountFen }),
  );

  assert.equal(outcome.status, 'ok');
  if (outcome.status !== 'ok') return;

  const { plan } = outcome;
  const allocated = plan.members.reduce((sum, member) => sum + member.costFen, 0);

  // 应付必须等于「商品合计 − 优惠」，不是菜单价硬加
  assert.equal(plan.totals.payableFen, plan.allocation.productPriceFen - discountFen);
  assert.ok(plan.allocation.productPriceFen > discountFen, '固件应保证应付为正');

  // 核心不变量
  assert.equal(allocated, plan.totals.payableFen, '成员分摊合计必须等于应付');
  assert.equal(plan.allocation.allocatedFenSum, plan.totals.payableFen);

  // 分摊必须是整数分，且零头被完整分配
  for (const member of plan.members) {
    assert.equal(Number.isInteger(member.costFen), true, `${member.name} 的分摊必须是整数分`);
  }
  assert.ok(
    plan.allocation.roundingAdjustmentFen >= 0 && plan.allocation.roundingAdjustmentFen < plan.members.length,
    '取整调整量应小于成员数',
  );
});

test('分摊后每个人都重新通过了预算校验', async () => {
  const outcome = await planMeal(
    {
      storeCode: 'S001',
      members: [
        { id: 'a', name: '甲', budget: 25 },
        { id: 'b', name: '乙', budget: 22 },
        { id: 'c', name: '丙', budget: 30, lightEater: true, wantVegetable: true },
      ],
    },
    deps(BASIC_MENU, { discountFen: 333 }),
  );

  assert.equal(outcome.status, 'ok');
  if (outcome.status !== 'ok') return;

  for (const member of outcome.plan.members) {
    assert.ok(member.costFen <= member.budgetFen, `${member.name} 分摊超出预算`);
    assert.equal(member.budgetOverFen, 0);
    assert.equal(member.budgetCheck, 'passed');
  }
  assert.equal(outcome.plan.allocation.budgetCheck, 'passed');
});

test('元字段与分字段互相自洽', async () => {
  const outcome = await planMeal(
    { storeCode: 'S001', members: [{ id: 'a', name: '甲', budget: 40 }] },
    deps(BASIC_MENU, { discountFen: 155 }),
  );

  assert.equal(outcome.status, 'ok');
  if (outcome.status !== 'ok') return;

  const { plan } = outcome;
  for (const member of plan.members) {
    assert.equal(Math.round(member.cost * 100), member.costFen);
    for (const item of member.items) {
      assert.equal(Math.round(item.unitPrice * 100), item.unitPriceFen);
      assert.equal(item.subtotalFen, item.unitPriceFen * item.quantity);
    }
  }
  assert.equal(Math.round(plan.totals.payable * 100), plan.totals.payableFen);
});

// ---------------------------------------------------------------- 3) 分摊算法本身

test('allocateCents：三人分 8170 分，合计严格相等', () => {
  const result = allocateCents(
    [
      { memberId: 'a', rawFen: 2600 },
      { memberId: 'b', rawFen: 2350 },
      { memberId: 'c', rawFen: 3050 },
    ],
    8170,
  );

  const total = [...result.allocatedFen.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(total, 8170);
  for (const value of result.allocatedFen.values()) {
    assert.equal(Number.isInteger(value), true);
  }
});

test('allocateCents：1 分钱也要分出去且只有一个人拿到', () => {
  const result = allocateCents(
    [
      { memberId: 'a', rawFen: 100 },
      { memberId: 'b', rawFen: 100 },
      { memberId: 'c', rawFen: 100 },
    ],
    1,
  );

  const values = [...result.allocatedFen.values()];
  assert.equal(values.reduce((sum, value) => sum + value, 0), 1);
  assert.equal(values.filter((value) => value === 1).length, 1);
});

test('allocateCents：权重全为 0 时退化为平均分且合计相等', () => {
  const result = allocateCents(
    [
      { memberId: 'a', rawFen: 0 },
      { memberId: 'b', rawFen: 0 },
    ],
    1001,
  );

  const total = [...result.allocatedFen.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(total, 1001);
});

test('allocateCents：零成员不崩溃', () => {
  const result = allocateCents([], 500);
  assert.equal(result.allocatedFen.size, 0);
  assert.equal(result.roundingAdjustmentFen, 0);
});
