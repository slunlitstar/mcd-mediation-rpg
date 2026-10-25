/**
 * 模型 × `/api/mediate` 的联合测试（离线，注入假模型 + 假菜单 + 假计价器）。
 *
 * 这里只关心一件事：**模型能不能影响最终结果，以及被拦下时会不会说真话**。
 *
 * - 模型方案通过校验 → `planner: llm-validated-v1`，商品就是模型选的，
 *   但金额仍然来自真实计价 + 整数分摊（模型自带的价格必须被忽略）；
 * - 模型编造商品 / 漏成员 / 直接抛错 → 结果降级到 `rule-based-v2`，
 *   方案照常给出，`degraded: true`，并且**不新增 blocking issue**；
 * - 未配置模型 → `llm: not_configured`，`degraded: false`，不能谎称降级；
 * - 复议 → 不调用模型（动作语义由规则版保证），其他成员餐品一动不动。
 *
 * 运行：npm run test --workspace=@mcd/server
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mediate } from './mediate.js';
import type { MediateDependencies } from './mediate.js';
import type { ProposalCallResult, ProposalProvider, ProposalRequest } from './ai.js';
import type { UnifiedMenu, UnifiedMenuItem, UnifiedPricing } from '../mcp/normalize.js';

// ---------------------------------------------------------------- 假菜单

interface Seed {
  id: string;
  name: string;
  priceYuan: number;
  category?: string;
  tags?: string[];
}

function makeMenu(seeds: Seed[]): UnifiedMenu {
  const items: UnifiedMenuItem[] = seeds.map((seed) => ({
    id: seed.id,
    name: seed.name,
    price: seed.priceYuan,
    priceFen: Math.round(seed.priceYuan * 100),
    category: seed.category ?? '巨无霸·牛鱼肉堡',
    categories: [seed.category ?? '巨无霸·牛鱼肉堡'],
    isCombo: false,
    isComboSource: 'default',
    canWithOrder: false,
    tags: seed.tags ?? [],
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
    meta: { itemCount: items.length, comboCount: 0, comboVerifiedCount: 0, orphanCount: 0 },
  };
}

function fakePrice(
  menu: UnifiedMenu,
  discountFen = 0,
): (storeCode: string, items: { productCode: string; quantity: number }[]) => Promise<UnifiedPricing> {
  const byId = new Map(menu.items.map((item) => [item.id, item]));

  return async (_storeCode, basket) => {
    const lines = basket.map((line) => {
      const item = byId.get(line.productCode);
      assert.ok(item, `未知商品 ${line.productCode}`);
      const subtotalFen = item.priceFen * line.quantity;
      return {
        itemId: item.id,
        name: item.name,
        quantity: line.quantity,
        unitPrice: item.price,
        unitPriceFen: item.priceFen,
        originalSubtotal: item.price * line.quantity,
        originalSubtotalFen: subtotalFen,
        subtotal: subtotalFen / 100,
        subtotalFen,
      };
    });

    const productPriceFen = lines.reduce((sum, line) => sum + line.subtotalFen, 0);
    const payableFen = productPriceFen - discountFen;

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

const MENU = makeMenu([
  { id: 'b1', name: '巨无霸', priceYuan: 26, tags: ['100%纯牛肉'] },
  { id: 'b2', name: '麦香鸡', priceYuan: 14 },
  { id: 's1', name: '中薯条', priceYuan: 12, category: '小食甜品/其他' },
  { id: 'd1', name: '可乐', priceYuan: 9, category: '饮品' },
]);

function deps(provider: ProposalProvider | null, discountFen = 0): MediateDependencies {
  return {
    menu: async () => MENU,
    price: fakePrice(MENU, discountFen),
    couponCount: async () => 0,
    proposals: provider,
  };
}

/**
 * 假模型：把同一份 allocations 复制给请求里所有策略（模拟「模型认为三策略一样」），
 * 并记录被调用次数与最后一次请求，便于断言「一次请求覆盖全部策略」。
 */
function providerWith(
  allocations: unknown,
  label = 'fake-model',
): ProposalProvider & { calls: number; lastRequest?: ProposalRequest } {
  const provider = {
    label,
    calls: 0,
    lastRequest: undefined as ProposalRequest | undefined,
    async propose(input: ProposalRequest): Promise<ProposalCallResult> {
      provider.calls += 1;
      provider.lastRequest = input;
      const proposal = {
        plans: input.strategies.map((strategy) => ({ strategy, allocations })),
      };
      return { proposal: proposal as never, raw: JSON.stringify(proposal), latencyMs: 1 };
    },
  };

  return provider;
}

function request(): Parameters<typeof mediate>[0] {
  return {
    storeId: 'S001',
    members: [
      { id: 1, budget: 45, hunger: 'hungry', likes: ['fries'], dislikes: [], requirement: 'none' },
      { id: 2, budget: 25, hunger: 'little', likes: [], dislikes: [], requirement: 'no-spicy' },
    ],
  };
}

function assertAllocationInvariant(plans: Awaited<ReturnType<typeof mediate>>['plans']): void {
  for (const plan of plans) {
    const sum = plan.allocations.reduce((total, allocation) => total + allocation.totalCents, 0);
    assert.equal(sum, plan.payableCents, `策略 ${plan.strategy} 分摊合计必须等于应付`);
    assert.equal(plan.allocationAudit.allocatedCentsSum, plan.payableCents);
    for (const allocation of plan.allocations) {
      assert.ok(allocation.totalCents <= allocation.budgetCents, '分摊后不能超预算');
    }
  }
}

// ---------------------------------------------------------------- 用例

test('未配置模型：meta 如实写 not_configured + rules，且不谎称降级', async () => {
  const result = await mediate(request(), deps(null));

  assert.ok(result.plans.length > 0);
  assert.equal(result.meta.llm, 'not_configured');
  assert.equal(result.meta.planner, 'rule-based-v2');
  assert.equal(result.meta.reasoning, 'rules');
  assert.equal(result.meta.degraded, false);
  assert.deepEqual(result.meta.llmDetail, []);
});

test('模型方案通过校验：采用模型选品，但金额仍来自真实计价（模型价格被忽略）', async () => {
  // 规则版永远只选 1 份主食；模型这里给成员 1 点了 2 个汉堡，还伪造了 1 分钱的价格
  // —— 用来证明「选品来自模型、金额来自程序」。
  const provider = providerWith([
    { memberId: 1, items: [{ productId: 'b2', quantity: 2, priceCents: 1 }], reason: '两个汉堡更顶饱' },
    { memberId: 2, items: [{ productId: 'b2', quantity: 1, priceCents: 1 }], reason: '一个堡就够了' },
  ]);

  const result = await mediate(request(), deps(provider, 500));

  assert.equal(provider.calls, 1, '三策略由一次请求覆盖，避免撞限流');
  assert.equal(result.meta.planner, 'llm-validated-v1');
  assert.equal(result.meta.reasoning, 'llm');
  assert.equal(result.meta.degraded, false);
  assert.equal(result.meta.llm, 'fake-model');

  const plan = result.plans[0];
  assert.ok(plan);

  const firstItems = plan.allocations.find((entry) => entry.memberId === 1)?.items ?? [];
  assert.deepEqual(
    firstItems.map((item) => `${item.productId}x${String(item.quantity)}`),
    ['b2x2'],
    '数量 2 只能来自模型，规则版不会这么点',
  );

  // 金额来自假计价器（1400×3 − 500 = 3700），不是模型说的 1 分。
  assert.equal(plan.productSubtotalCents, 4200);
  assert.equal(plan.discountCents, 500);
  assert.equal(plan.payableCents, 3700);

  assertAllocationInvariant(result.plans);
});

test('模型只给配餐、没有主食：拒绝并降级（烤不出「一份薯条当一顿饭」）', async () => {
  const provider = providerWith([
    { memberId: 1, items: [{ productId: 'b2', quantity: 1 }], reason: '正常' },
    { memberId: 2, items: [{ productId: 's1', quantity: 1 }], reason: '只想吃薯条' },
  ]);

  const result = await mediate(request(), deps(provider));

  assert.equal(result.meta.llmDetail?.[0]?.code, 'model_missing_main');
  assert.equal(result.meta.planner, 'rule-based-v2');
  assert.ok(result.plans.length > 0);
  assertAllocationInvariant(result.plans);
});

test('模型编造商品 ID：整体拒绝，降级规则版，且不产生 blocking issue', async () => {
  const provider = providerWith([
      { memberId: 1, items: [{ productId: 'not-exist', quantity: 1 }] },
      { memberId: 2, items: [{ productId: 'b2', quantity: 1 }] },
    ]);

  const result = await mediate(request(), deps(provider));

  assert.ok(result.plans.length > 0, '降级后仍要给方案');

  // 商品全部来自真实菜单。
  const menuIds = new Set(MENU.items.map((item) => item.id));
  for (const plan of result.plans) {
    for (const allocation of plan.allocations) {
      for (const item of allocation.items) {
        assert.ok(menuIds.has(item.productId), `${item.productId} 必须是真实商品`);
      }
    }
  }

  assert.equal(result.meta.planner, 'rule-based-v2');
  assert.equal(result.meta.reasoning, 'rules-fallback');
  assert.equal(result.meta.degraded, true);
  assert.equal(result.issues.some((issue) => issue.blocking), false, '模型被拦不是无解');
  assert.ok(result.meta.llmDetail?.every((entry) => entry.status === 'rejected'));
  assert.ok(result.hints.some((hint) => hint.message.includes('模型方案未通过校验')));

  assertAllocationInvariant(result.plans);
});

test('模型调用直接抛错（超时/网络）：降级规则版，接口不失败', async () => {
  const provider: ProposalProvider = {
    label: 'fake-model',
    propose: async () => {
      throw Object.assign(new Error('模型请求超过 20000ms 未返回'), { code: 'model_timeout' });
    },
  };

  const result = await mediate(request(), deps(provider));

  assert.ok(result.plans.length > 0);
  assert.equal(result.meta.planner, 'rule-based-v2');
  assert.equal(result.meta.degraded, true);
  assert.equal(result.meta.llmDetail?.[0]?.code, 'model_timeout');
  assertAllocationInvariant(result.plans);
});

test('模型漏掉成员：整体拒绝，不用"半份方案"', async () => {
  const provider = providerWith([{ memberId: 1, items: [{ productId: 'b2', quantity: 1 }] }]);

  const result = await mediate(request(), deps(provider));

  assert.equal(result.meta.planner, 'rule-based-v2');
  assert.equal(result.meta.llmDetail?.[0]?.code, 'model_missing_member');
  assert.ok(result.plans.length > 0);
});

test('模型选中蘸酱/周边：拒绝并降级', async () => {
  const menu = makeMenu([
    { id: 'b2', name: '麦香鸡', priceYuan: 14 },
    { id: 'x1', name: '北美招牌牧场酱', priceYuan: 3, category: '蘸酱炸鸡', tags: ['蘸酱'] },
  ]);

  const provider = providerWith([
      { memberId: 1, items: [{ productId: 'x1', quantity: 1 }] },
      { memberId: 2, items: [{ productId: 'b2', quantity: 1 }] },
    ]);

  const result = await mediate(request(), {
    menu: async () => menu,
    price: fakePrice(menu),
    couponCount: async () => 0,
    proposals: provider,
  });

  assert.equal(result.meta.llmDetail?.[0]?.code, 'model_non_meal_product');
  assert.equal(result.meta.planner, 'rule-based-v2');
});

test('复议：不调用模型，其他成员餐品原样保留', async () => {
  const provider = providerWith([
      { memberId: 1, items: [{ productId: 'b1', quantity: 1 }] },
      { memberId: 2, items: [{ productId: 'b2', quantity: 1 }] },
    ]);

  const base = await mediate(request(), deps(provider));
  provider.calls = 0;

  const plan = base.plans[0];
  assert.ok(plan);

  const revised = await mediate(
    {
      ...request(),
      revision: { memberId: 1, action: 'fries' },
      excludePlan: {
        planId: plan.planId,
        strategy: plan.strategy,
        allocations: plan.allocations.map((allocation) => ({
          memberId: allocation.memberId,
          items: allocation.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
          totalCents: allocation.totalCents,
        })),
        productSubtotalCents: plan.productSubtotalCents,
        discountCents: plan.discountCents,
        payableCents: plan.payableCents,
      },
    },
    deps(provider),
  );

  assert.equal(provider.calls, 0, '复议不应调用模型');
  assert.ok(revised.plans.length, '复议必须实际产生新餐品，不能用空数组通过金额断言');
  assert.equal(revised.meta.reasoning, 'rules');
  assert.equal(revised.meta.degraded, false);
  assert.ok(revised.meta.llmDetail?.every((entry) => entry.status === 'skipped'));
  assertAllocationInvariant(revised.plans);

  // 成员 2 的餐品必须和原方案一致。
  const before = plan.allocations.find((entry) => entry.memberId === 2);
  for (const next of revised.plans) {
    const after = next.allocations.find((entry) => entry.memberId === 2);
    assert.deepEqual(
      after?.items.map((item) => `${item.productId}x${String(item.quantity)}`).sort(),
      before?.items.map((item) => `${item.productId}x${String(item.quantity)}`).sort(),
    );
  }
});
