/**
 * `/api/mediate` 的隔离测试（离线，注入假菜单/假计价器）。
 *
 * 重点验证契约里那几条硬规则，而不是「算法有多聪明」：
 * - `budget: null` 只给非阻塞提示，不产出方案；
 * - `dislikes` 是硬排除；
 * - `requirement: no-spicy` 排除辣味商品；
 * - 人工核对永不阻塞；
 * - 三策略的每个方案都满足 `Σ totalCents === payableCents` 且没人超预算；
 * - 复议只改指定成员，其他成员餐品保持不变。
 *
 * 运行：npm run test --workspace=@mcd/server
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mediate, toCategory, inferDietary } from './mediate.js';
import type { ExcludedPlan, MediateDependencies, MemberInput } from './mediate.js';
import type { UnifiedMenu, UnifiedMenuItem, UnifiedPricing } from '../mcp/normalize.js';

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
    meta: {
      itemCount: items.length,
      comboCount: 0,
      comboVerifiedCount: 0,
      orphanCount: 0,
    },
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

function deps(menu: UnifiedMenu, discountFen = 0): MediateDependencies {
  return {
    menu: async () => menu,
    price: fakePrice(menu, discountFen),
    couponCount: async () => 0,
    // 这一组测试只验证规则版契约，必须显式关掉模型，否则本机填了 AI_* 就会真打网络。
    proposals: null,
  };
}

const MENU = makeMenu([
  { id: 'b1', name: '牛肉汉堡', priceYuan: 20, tags: ['单品', '100%纯牛肉'] },
  { id: 'b2', name: '鸡腿堡', priceYuan: 18 },
  { id: 'b3', name: '麦辣鸡腿堡', priceYuan: 16, tags: ['辣'] },
  { id: 's1', name: '中薯条', priceYuan: 12, category: '小食甜品/其他' },
  { id: 's2', name: '麦乐鸡', priceYuan: 14, category: '炸鸡' },
  { id: 'd1', name: '可乐', priceYuan: 9, category: '饮品' },
  { id: 'x1', name: '北美招牌牧场酱', priceYuan: 3, category: '蘸酱炸鸡', tags: ['蘸酱'] },
  { id: 'x2', name: '旋旋星愿贴', priceYuan: 3.9, category: '小食甜品/其他', tags: ['限量周边'] },
]);

// ---------------------------------------------------------------- 枚举与推导

test('分类映射：薯条优先，饮品/甜点/汉堡各归其位', () => {
  const byName = new Map(MENU.items.map((item) => [item.name, item]));
  assert.equal(toCategory(byName.get('中薯条') as UnifiedMenuItem), 'fries');
  assert.equal(toCategory(byName.get('可乐') as UnifiedMenuItem), 'drink');
  assert.equal(toCategory(byName.get('牛肉汉堡') as UnifiedMenuItem), 'burger');
  assert.equal(toCategory(byName.get('麦乐鸡') as UnifiedMenuItem), 'snack');
});

test('食材推导保留来源与不确定性：没出现关键词只能是 low', () => {
  const byName = new Map(MENU.items.map((item) => [item.name, item]));

  const beef = inferDietary(byName.get('牛肉汉堡') as UnifiedMenuItem);
  assert.equal(beef.beef.inferred, true);
  assert.equal(beef.beef.source, 'tag');
  assert.equal(beef.beef.confidence, 'high');

  const spicy = inferDietary(byName.get('麦辣鸡腿堡') as UnifiedMenuItem);
  assert.equal(spicy.spicy.inferred, true);

  const plain = inferDietary(byName.get('中薯条') as UnifiedMenuItem);
  assert.equal(plain.spicy.inferred, false);
  assert.equal(plain.spicy.source, 'name');
  assert.equal(plain.spicy.confidence, 'low', '未命中关键词不等于官方确认不含');
});

test('产品体系里 fullness 恒为 null', async () => {
  const result = await mediate(
    { storeId: 'S001', members: [{ id: 1, budget: 30 }, { id: 2, budget: 30 }] },
    deps(MENU),
  );

  assert.ok(result.products !== undefined && result.products.length > 0);
  for (const product of result.products ?? []) {
    assert.equal(product.fullness, null);
    assert.equal(product.fullnessSource, 'unknown');
  }
});

// ---------------------------------------------------------------- 预算 null

test('budget 为 null 时不产出方案，只给非阻塞提示', async () => {
  const result = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: null },
        { id: 2, budget: 30 },
      ],
    },
    deps(MENU),
  );

  assert.equal(result.plans.length, 0, '未填写预算不得产出方案');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.code, 'budget_missing');
  assert.equal(result.issues[0]?.blocking, false, '未填写预算不得把整页打成无解');
  assert.ok(result.hints.some((hint) => hint.message.includes('不等于不限预算')));
  assert.equal(result.meta.pricingVerified, false);
});

// ---------------------------------------------------------------- 硬约束

test('dislikes 是硬排除：不喜欢 drink 就不出现任何饮品', async () => {
  const result = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: 40, hunger: 'faint', dislikes: ['drink'] },
        { id: 2, budget: 40, hunger: 'faint' },
      ],
    },
    deps(MENU),
  );

  assert.ok(result.plans.length > 0);
  const drinkIds = new Set(MENU.items.filter((item) => toCategory(item) === 'drink').map((item) => item.id));

  for (const plan of result.plans) {
    const first = plan.allocations.find((entry) => entry.memberId === 1);
    assert.ok(first !== undefined);
    for (const item of first.items) {
      assert.equal(drinkIds.has(item.productId), false, `成员1 不应拿到饮品 ${item.productId}`);
    }
  }
});

test('requirement: no-spicy 排除辣味商品', async () => {
  const result = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: 30, requirement: 'no-spicy' },
        { id: 2, budget: 30 },
      ],
    },
    deps(MENU),
  );

  assert.ok(result.plans.length > 0);
  for (const plan of result.plans) {
    const first = plan.allocations.find((entry) => entry.memberId === 1);
    assert.ok(first !== undefined);
    for (const item of first.items) {
      assert.notEqual(item.productId, 'b3', '忌辣成员不应拿到麦辣鸡腿堡');
    }
  }
});

test('蘸酱与周边不会被当成配餐', async () => {
  const result = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: 15, hunger: 'hungry' },
        { id: 2, budget: 15, hunger: 'hungry' },
      ],
    },
    deps(MENU),
  );

  for (const plan of result.plans) {
    for (const allocation of plan.allocations) {
      for (const item of allocation.items) {
        assert.notEqual(item.productId, 'x1', '蘸酱不应占配餐名额');
        assert.notEqual(item.productId, 'x2', '周边贴纸不应占配餐名额');
      }
    }
  }
});

// ---------------------------------------------------------------- 人工核对

test('自填要求走 requiresManualReview，且 issue 非阻塞', async () => {
  const result = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: 30, customRequirement: '不要洋葱' },
        { id: 2, budget: 30 },
      ],
    },
    deps(MENU),
  );

  const issue = result.issues.find((entry) => entry.code === 'custom_requirement_unverified');
  assert.ok(issue !== undefined);
  assert.equal(issue?.blocking, false, '人工核对永远不得阻塞');
  assert.equal(issue?.kind, 'input');

  assert.ok(result.plans.length > 0, '有人工核对项也要正常出方案');
  for (const plan of result.plans) {
    const first = plan.allocations.find((entry) => entry.memberId === 1);
    assert.equal(first?.requiresManualReview, true);
    assert.equal(plan.requiresManualReview, true);
  }
  assert.ok(result.hints.some((hint) => hint.level === 'info'));
});

// ---------------------------------------------------------------- 分摊不变量

test('三策略的每个方案都满足分摊不变量', async () => {
  const result = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: 35, hunger: 'hungry', likes: ['burger'] },
        { id: 2, budget: 30, hunger: 'faint', likes: ['fries'] },
        { id: 3, budget: 40, hunger: 'little', likes: ['drink'] },
      ],
    },
    deps(MENU, 137),
  );

  assert.ok(result.plans.length > 0);
  assert.equal(result.meta.pricingVerified, true);

  for (const plan of result.plans) {
    const allocated = plan.allocations.reduce((sum, entry) => sum + entry.totalCents, 0);
    assert.equal(allocated, plan.payableCents, `${plan.strategy}: 分摊合计必须等于应付`);
    assert.equal(plan.allocationAudit.allocatedCentsSum, plan.payableCents);
    assert.equal(plan.productSubtotalCents - plan.discountCents, plan.payableCents);

    for (const allocation of plan.allocations) {
      assert.ok(Number.isInteger(allocation.totalCents), '分摊必须是整数分');
      assert.ok(allocation.totalCents <= allocation.budgetCents, `成员 ${allocation.memberId} 超预算`);
      assert.equal(allocation.budgetOverCents, 0);
    }
  }
});

test('策略去重：相同方案不重复返回，但要如实记录', async () => {
  const result = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: 60, hunger: 'little' },
        { id: 2, budget: 60, hunger: 'little' },
      ],
    },
    deps(MENU),
  );

  const signatures = new Set(
    result.plans.map((plan) =>
      plan.allocations
        .map((entry) => `${String(entry.memberId)}:${entry.items.map((item) => item.productId).sort().join(',')}`)
        .join('|'),
    ),
  );

  assert.equal(signatures.size, result.plans.length, '返回的方案不能完全相同');
  assert.equal(
    result.meta.strategiesReturned.length + result.meta.strategiesDeduplicated.length,
    3,
    '三种策略要么返回要么被记录为去重',
  );
});

// ---------------------------------------------------------------- 复议

test('复议只改指定成员，其他成员餐品保持不变', async () => {
  const base = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: 40, hunger: 'hungry' },
        { id: 2, budget: 40, hunger: 'hungry', likes: ['fries'] },
      ],
    },
    deps(MENU),
  );

  const original = base.plans[0];
  assert.ok(original !== undefined);

  const excluded = {
    planId: original.planId,
    strategy: original.strategy,
    allocations: original.allocations.map((entry) => ({
      memberId: entry.memberId,
      items: entry.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      totalCents: entry.totalCents,
    })),
    productSubtotalCents: original.productSubtotalCents,
    discountCents: original.discountCents,
    payableCents: original.payableCents,
  };

  const revised = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: 40, hunger: 'hungry' },
        { id: 2, budget: 40, hunger: 'hungry', likes: ['fries'] },
      ],
      // 用「加一杯饮料」验证复议：比 cheaper 更确定性（菜单里最便宜的汉堡可能已被选中）
      revision: { memberId: 2, action: 'drink' },
      excludePlan: excluded,
    },
    deps(MENU),
  );

  const plan = revised.plans[0];
  assert.ok(plan !== undefined);

  const before = original.allocations.find((entry) => entry.memberId === 1);
  const after = plan.allocations.find((entry) => entry.memberId === 1);
  assert.deepEqual(
    after?.items.map((item) => `${item.productId}x${String(item.quantity)}`).sort(),
    before?.items.map((item) => `${item.productId}x${String(item.quantity)}`).sort(),
    '非目标成员的餐品必须保持不变',
  );

  // 目标成员应该多出饮品
  const target = plan.allocations.find((entry) => entry.memberId === 2);
  assert.ok(target !== undefined);
  assert.ok(
    target.items.some((item) => item.productId === 'd1'),
    '复议 drink 后目标成员应包含可乐',
  );

  // 分摊变了也要守住不变量
  const allocated = plan.allocations.reduce((sum, entry) => sum + entry.totalCents, 0);
  assert.equal(allocated, plan.payableCents);
  for (const allocation of plan.allocations) {
    assert.ok(allocation.totalCents <= allocation.budgetCents);
  }
});

test('复议缺少 excludePlan 时给出阻塞提示', async () => {
  const result = await mediate(
    {
      storeId: 'S001',
      members: [
        { id: 1, budget: 40 },
        { id: 2, budget: 40 },
      ],
      revision: { memberId: 1, action: 'cheaper' },
    },
    deps(MENU),
  );

  const issue = result.issues.find((entry) => entry.code === 'exclude_plan_required');
  assert.ok(issue !== undefined);
  assert.equal(issue?.blocking, true);
  assert.equal(result.plans.length, 0);
});

test('mediate 不得把买不起主食的成员留成空餐盘再返回成功', async () => {
  let priced = false;
  const injected = deps(MENU);
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 1 }, { id: 2, budget: 40 }] }, {
    ...injected, price: async (...args) => {
      priced = true;
      const mains = args[1].filter(line => MENU.items.find(item => item.id === line.productCode)?.name.includes('堡'));
      assert.ok(mains.reduce((sum, line) => sum + line.quantity, 0) >= 2, '调整建议也不得试算缺少主食的组合');
      return injected.price(...args);
    },
  });
  assert.equal(result.plans.length, 0);
  assert.ok(result.issues.some(issue => issue.memberId === 1 && issue.kind === 'constraint' && issue.blocking));
  assert.equal(priced, true, '原预算无解后，允许试算明确提高预算的调整建议');
  assert.ok(result.suggestions?.some(suggestion => suggestion.changes.some(change => change.memberId === 1 && Number(change.budget) > 1)));
});

test('必须有的类别不能因预算不足被静默省略', async () => {
  const withoutDrink = makeMenu([{ id: 'b1', name: '鸡腿堡', priceYuan: 18 }]);
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 30, requirement: 'drink' }, { id: 2, budget: 40 }] }, deps(withoutDrink));
  assert.equal(result.plans.length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'required_food_unavailable' && issue.blocking));
});

test('joint selection finds an affordable main and mandatory side even when preference ranking favours an expensive side', async () => {
  const menu = makeMenu([
    { id: 'b', name: '鸡腿堡', priceYuan: 10 },
    { id: 'f1', name: '中薯条', priceYuan: 6 },
    { id: 'f2', name: '大薯条', priceYuan: 19 },
  ]);
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 16, requirement: 'fries' }, { id: 2, budget: 16 }] }, deps(menu));
  assert.ok(result.plans.length);
  for (const plan of result.plans) assert.deepEqual(plan.allocations[0].items.map(item => item.productId).sort(), ['b', 'f1']);
});

test('default combo covers required fries without duplicate sides or drinks and sends real rounds to pricing', async () => {
  const menu = makeMenu([
    { id: 'combo', name: '鸡腿堡三件套', priceYuan: 18 },
    { id: 'b', name: '鸡腿堡', priceYuan: 14 },
    { id: 'f', name: '中薯条', priceYuan: 8, category: '小食' },
    { id: 'd', name: '可乐中杯', priceYuan: 6, category: '饮品' },
  ]);
  menu.items[0].isCombo = true;
  menu.items[0].combo = { verified: true, components: [{ id: 'b', name: '鸡腿堡', quantity: 1 }, { id: 'f', name: '中薯条', quantity: 1 }, { id: 'd', name: '可乐中杯', quantity: 1 }], roundList: [{ round: '1', comboItemList: [{ code: 'b', quantity: 1 }] }, { round: '2', comboItemList: [{ code: 'f', quantity: 1 }] }, { round: '3', comboItemList: [{ code: 'd', quantity: 1 }] }] };
  const injected = deps(menu);
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 20, hunger: 'faint', requirement: 'fries' }, { id: 2, budget: 20, hunger: 'faint' }] }, {
    ...injected, price: async (...args) => {
      assert.deepEqual(args[1].find(item => item.productCode === 'combo')?.roundList, menu.items[0].combo!.roundList);
      return injected.price(...args);
    },
  });
  assert.ok(result.plans.length);
  for (const plan of result.plans) {
    assert.ok(plan.allocations.every(allocation => allocation.items.length === 1 && allocation.items[0].productId === 'combo'));
    assert.equal(plan.allocations.reduce((sum, item) => sum + item.totalCents, 0), plan.payableCents);
  }
  const excluded = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 20, dislikes: ['drink'] }, { id: 2, budget: 20 }] }, injected);
  assert.ok(excluded.plans.length);
  assert.ok(excluded.plans.every(plan => plan.allocations[0].items.every(item => item.productId !== 'combo')));
  delete menu.items[0].combo;
  const unresolved = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 20 }, { id: 2, budget: 20 }] }, injected);
  assert.ok(unresolved.plans.every(plan => plan.allocations.every(allocation => allocation.items.every(item => item.productId !== 'combo'))));
});

test('recovery suggestions are fully priced and preserve other members and dietary requirements', async () => {
  const menu = makeMenu([{ id: 'b', name: '酱香鸡腿堡', priceYuan: 14 }, { id: 'f', name: '麦香鱼', priceYuan: 12 }, { id: 'd', name: '牛奶', priceYuan: 6, category: '饮品' }]);
  const members = [{ id: 1, budget: 5, requirement: 'no-beef' as const }, { id: 2, budget: 30, requirement: 'no-spicy' as const }];
  const result = await mediate({ storeId: 'S001', members }, deps(menu));
  assert.equal(result.plans.length, 0);
  const suggestion = result.suggestions?.find(suggestion => suggestion.changes.some(change => change.budget));
  assert.ok(suggestion);
  assert.deepEqual(suggestion.changes, [{ memberId: 1, budget: 12 }]);
  assert.equal(suggestion.plan.allocations.reduce((sum, member) => sum + member.totalCents, 0), suggestion.plan.payableCents);
  assert.ok(suggestion.plan.allocations.every(member => member.totalCents <= member.budgetCents));
  assert.ok(suggestion.plan.allocations.every(member => member.items[0].productId === 'f'));
  assert.equal(members[0].budget, 5, 'suggestions never mutate input automatically');
  assert.equal(result.products!.find(product => product.id === 'd')!.dietary.beef.inferred, false, 'milk is not beef');
});

test('a single food exclusion may be explicitly relaxed; an impossible dietary restriction is never relaxed', async () => {
  const menu = makeMenu([{ id: 'b', name: '麦辣牛肉汉堡', priceYuan: 10 }]);
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 20, dislikes: ['burger'] }, { id: 2, budget: 20 }] }, deps(menu));
  assert.ok(result.suggestions?.some(suggestion => suggestion.changes[0].dislikes?.length === 0));
  const blocked = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 20, requirement: 'no-beef' }, { id: 2, budget: 20 }] }, deps(menu));
  assert.equal(blocked.suggestions?.length, 0);
});

test('a failed recovery quote preserves the original constraint response without unverified suggestions', async () => {
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 1 }, { id: 2, budget: 40 }] }, { ...deps(MENU), price: async () => { throw new Error('offline'); } });
  assert.equal(result.plans.length, 0);
  assert.equal(result.suggestions?.length, 0);
  assert.ok(result.issues.some(issue => issue.kind === 'constraint'));
});

function priorPlan(menu: UnifiedMenu, baskets: Array<Array<[string, number]>>): ExcludedPlan {
  const allocations = baskets.map((basket, index) => ({ memberId: index + 1, items: basket.map(([productId, quantity]) => ({ productId, quantity })), totalCents: basket.reduce((sum, [id, quantity]) => sum + menu.items.find(item => item.id === id)!.priceFen * quantity, 0) }));
  const total = allocations.reduce((sum, allocation) => sum + allocation.totalCents, 0);
  return { planId: 'previous', strategy: 'peace', allocations, productSubtotalCents: total, discountCents: 0, payableCents: total };
}

function revisionMenu(): UnifiedMenu {
  const menu = makeMenu([
    { id: 'combo', name: '鸡腿堡三件套', priceYuan: 26 },
    { id: 'expensive', name: '大鸡腿堡', priceYuan: 18 },
    { id: 'b', name: '鸡腿堡', priceYuan: 10 },
    { id: 'f', name: '中薯条', priceYuan: 5, category: '小食' },
    { id: 'd', name: '可乐', priceYuan: 3, category: '饮品' },
    { id: 'x', name: '冰淇淋', priceYuan: 2, category: '甜品' },
  ]);
  menu.items[0].isCombo = true;
  menu.items[0].combo = { verified: true, components: [{ id: 'b', name: '鸡腿堡', quantity: 1 }, { id: 'f', name: '中薯条', quantity: 1 }, { id: 'd', name: '可乐', quantity: 1 }], roundList: [{ round: '1', comboItemList: [{ code: 'b', quantity: 1 }] }, { round: '2', comboItemList: [{ code: 'f', quantity: 1 }] }, { round: '3', comboItemList: [{ code: 'd', quantity: 1 }] }] };
  return menu;
}

test('hungrier revision replaces an unaffordable-to-extend combo with more main portions and locks other members', async () => {
  const menu = revisionMenu(); const excluded = priorPlan(menu, [[['combo', 1]], [['combo', 1]]]);
  const members: MemberInput[] = [{ id: 1, budget: 30, hunger: 'hungry', dislikes: ['dessert'] }, { id: 2, budget: 30 }];
  const result = await mediate({ storeId: 'S001', members, revision: { memberId: 1, action: 'hungrier' }, excludePlan: excluded }, deps(menu));
  assert.equal(result.plans.length, 1);
  const plan = result.plans[0];
  assert.equal(plan.strategy, 'peace');
  const target = plan.allocations[0];
  assert.ok(target.items.some(item => item.productId === 'b' && item.quantity >= 2));
  assert.ok(target.items.every(item => item.productId !== 'combo' && item.productId !== 'x'));
  assert.deepEqual(plan.allocations[1].items.map(item => ({ productId: item.productId, quantity: item.quantity })), excluded.allocations[1].items);
  assert.ok(target.totalCents <= 3000);
  assert.equal(plan.allocations.reduce((sum, member) => sum + member.totalCents, 0), plan.payableCents);
  assert.ok(result.hints.some(hint => hint.message.includes('移除') && hint.message.includes('加入') && hint.message.includes('个人实付')));
});

test('requested fries are found by replacing the original main when direct add-on would exceed budget', async () => {
  const menu = revisionMenu(); const excluded = priorPlan(menu, [[['expensive', 1]], [['expensive', 1]]]);
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 20 }, { id: 2, budget: 40 }], revision: { memberId: 1, action: 'fries' }, excludePlan: excluded }, deps(menu));
  assert.equal(result.plans.length, 1);
  assert.deepEqual(result.plans[0].allocations[0].items.map(item => item.productId).sort(), ['b', 'f']);
  assert.equal(result.plans[0].allocations[0].totalCents, 1500);
  assert.equal(result.plans[0].allocations[1].items[0].productId, 'expensive');
});

test('cheaper revision may replace a combo with individual items while preserving the hard required category', async () => {
  const menu = revisionMenu(); const excluded = priorPlan(menu, [[['combo', 1]], [['combo', 1]]]);
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 30, requirement: 'fries' }, { id: 2, budget: 30 }], revision: { memberId: 1, action: 'cheaper' }, excludePlan: excluded }, deps(menu));
  assert.equal(result.plans.length, 1);
  const target = result.plans[0].allocations[0];
  assert.ok(target.totalCents < excluded.allocations[0].totalCents);
  assert.ok(target.items.some(item => item.productId === 'f'));
  assert.ok(target.items.some(item => item.productId === 'b'));
});

test('already included combo category is explained without a redundant quote or returning the old plan as new', async () => {
  const menu = revisionMenu(); let quotes = 0;
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 30 }, { id: 2, budget: 30 }], revision: { memberId: 1, action: 'drink' }, excludePlan: priorPlan(menu, [[['combo', 1]], [['combo', 1]]]) }, { ...deps(menu), price: async (...args) => { quotes++; return fakePrice(menu)(args[0], args[1]); } });
  assert.equal(result.plans.length, 0); assert.equal(quotes, 0);
  assert.equal(result.issues[0].code, 'revision_already_included');
});

test('an impossible larger meal gives a specific budget explanation and preserves the input plan', async () => {
  const menu = makeMenu([{ id: 'b', name: '鸡腿堡', priceYuan: 20 }]);
  const excluded = priorPlan(menu, [[['b', 1]], [['b', 1]]]);
  const copy = structuredClone(excluded);
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 20 }, { id: 2, budget: 20 }], revision: { memberId: 1, action: 'hungrier' }, excludePlan: excluded }, deps(menu));
  assert.equal(result.plans.length, 0);
  assert.equal(result.issues[0].code, 'revision_no_larger_meal');
  assert.match(result.issues[0].message, /20/);
  assert.deepEqual(excluded, copy);
});

test('revision tries another complete candidate after real pricing exceeds a member budget', async () => {
  const menu = revisionMenu(); let quotes = 0;
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 30 }, { id: 2, budget: 30 }], revision: { memberId: 1, action: 'cheaper' }, excludePlan: priorPlan(menu, [[['combo', 1]], [['combo', 1]]]) }, {
    ...deps(menu), price: async (...args) => {
      const price = await fakePrice(menu)(args[0], args[1]); quotes++;
      return quotes === 1 ? { ...price, productPriceFen: price.productPriceFen + 10000, productPrice: price.productPrice + 100, payableFen: price.payableFen + 10000, payable: price.payable + 100 } : price;
    },
  });
  assert.ok(quotes > 1 && quotes <= 8);
  assert.equal(result.plans.length, 1);
  assert.ok(result.plans[0].allocations.every(allocation => allocation.totalCents <= allocation.budgetCents));
});

test('cheaper means lower actual personal payment, not just a lower menu sticker price', async () => {
  const menu = revisionMenu(); const excluded = priorPlan(menu, [[['combo', 1]], [['combo', 1]]]);
  // Simulate a previous heavily discounted price which current quotes cannot beat.
  excluded.allocations[0].totalCents = 1; excluded.allocations[1].totalCents = 1;
  excluded.productSubtotalCents = 5200; excluded.discountCents = 5198; excluded.payableCents = 2;
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 30 }, { id: 2, budget: 30 }], revision: { memberId: 1, action: 'cheaper' }, excludePlan: excluded }, deps(menu));
  assert.equal(result.plans.length, 0); assert.equal(result.issues[0].code, 'revision_no_cheaper_plan');
});

test('a missing product in another member basket cannot silently disappear during revision', async () => {
  const menu = revisionMenu(); const excluded = priorPlan(menu, [[['expensive', 1]], [['combo', 1]]]);
  excluded.allocations[1].items[0].productId = 'removed-product';
  const result = await mediate({ storeId: 'S001', members: [{ id: 1, budget: 30 }, { id: 2, budget: 30 }], revision: { memberId: 1, action: 'fries' }, excludePlan: excluded }, deps(menu));
  assert.equal(result.plans.length, 0); assert.equal(result.issues[0].code, 'revision_menu_changed');
});
