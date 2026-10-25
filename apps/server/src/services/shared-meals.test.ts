import test from 'node:test';
import assert from 'node:assert/strict';
import { mediate } from './mediate.js';
import type { MediateDependencies, MemberInput } from './mediate.js';
import type { UnifiedMenu, UnifiedMenuItem, UnifiedPricing } from '../mcp/normalize.js';

export function sharingFixture(count = 2, oddCent = false): UnifiedMenu {
  const item = (id: string, name: string, priceFen: number, category: string): UnifiedMenuItem => ({ id, name, priceFen, price: priceFen / 100, category, categories: [category], isCombo: false, isComboSource: 'default', canWithOrder: false, tags: [] });
  const main = item('burger', '鸡腿堡', 2000, '汉堡'); const fries = item('fries', '中薯条', 800, '小食'); const drink = item('drink', '可乐', 600, '饮品');
  const meal = item('share-combo', `${count}人分享餐`, count === 2 ? 3500 + Number(oddCent) : 4500, '多人餐');
  meal.isCombo = true; meal.isComboSource = 'detail';
  meal.combo = { verified: true, components: [{ id: main.id, name: main.name, quantity: count }, { id: fries.id, name: fries.name, quantity: count === 2 ? 1 : 2 }, { id: drink.id, name: drink.name, quantity: count }], roundList: [{ round: '1', comboItemList: [{ code: main.id, quantity: count }] }, { round: '2', comboItemList: [{ code: fries.id, quantity: count === 2 ? 1 : 2 }] }, { round: '3', comboItemList: [{ code: drink.id, quantity: count }] }] };
  return { store: { id: 'SHARED', name: '共享测试门店' }, currency: 'CNY', priceUnit: 'yuan', orderType: 1, beType: 1, capturedAt: '2026-10-25T00:00:00Z', categories: ['汉堡', '多人餐'], items: [main, fries, drink, meal], meta: { itemCount: 4, comboCount: 1, comboVerifiedCount: 1, orphanCount: 0 } };
}

export function sharingDeps(menu: UnifiedMenu, discount = 0): MediateDependencies {
  return { proposals: null, menu: async () => menu, couponCount: async () => 0, price: async (_store, basket): Promise<UnifiedPricing> => {
    const lines = basket.map(entry => {
      const product = menu.items.find(item => item.id === entry.productCode)!;
      assert.ok(product, '套餐子项不可作为额外购买的虚构商品');
      if (product.isCombo) assert.deepEqual(entry.roundList, product.combo!.roundList);
      const subtotalFen = product.priceFen * entry.quantity;
      return { itemId: product.id, name: product.name, quantity: entry.quantity, unitPrice: product.price, unitPriceFen: product.priceFen, originalSubtotal: subtotalFen / 100, originalSubtotalFen: subtotalFen, subtotal: subtotalFen / 100, subtotalFen };
    });
    const total = lines.reduce((sum, line) => sum + line.subtotalFen, 0);
    return { store: menu.store, currency: 'CNY', priceUnit: 'yuan', lines, productOriginalPrice: total / 100, productOriginalPriceFen: total, productPrice: total / 100, productPriceFen: total, originalPrice: total / 100, originalPriceFen: total, discount: discount / 100, discountFen: discount, payable: (total - discount) / 100, payableFen: total - discount };
  } };
}

const members = (count = 2): MemberInput[] => Array.from({ length: count }, (_, index) => ({ id: index + 1, budget: 30, hunger: 'hungry', likes: ['burger', 'fries', 'drink'] }));

test('a shared meal is purchased once while main/cups stay whole and side portions may be shared', async () => {
  const menu = sharingFixture(); const dependencies = sharingDeps(menu); const sharedQuotes: number[] = [];
  const result = await mediate({ storeId: menu.store.id, members: members() }, { ...dependencies, price: async (...args) => { const line = args[1].find(item => item.productCode === 'share-combo'); if (line) sharedQuotes.push(line.quantity); return dependencies.price(...args); } });
  const plan = result.plans.find(plan => plan.strategy === 'saving')!;
  assert.ok(plan.sharedMeals?.length === 1);
  assert.equal(plan.totalCents, 3500); assert.deepEqual(plan.basket, [{ productId: 'share-combo', quantity: 1 }]);
  assert.ok(sharedQuotes.length > 0 && sharedQuotes.every(quantity => quantity === 1));
  assert.ok(plan.allocations.every(allocation => allocation.items.length === 0 && allocation.sharedItems!.length > 0));
  const meal = plan.sharedMeals[0];
  assert.equal(meal.components.filter(part => part.hasMain).length, 2);
  assert.ok(meal.components.filter(part => part.hasMain || part.category === 'drink').every(part => part.memberIds.length === 1));
  assert.equal(meal.components.length, 5);
  assert.ok(meal.components.some(part => part.category === 'fries' && part.memberIds.length === 2));
  assert.equal(plan.allocations.reduce((sum, member) => sum + member.totalCents, 0), 3500);
  assert.ok(plan.allocations.every(member => member.totalCents <= member.budgetCents));
});

test('odd cents, discounts and per-component weights reconcile exactly', async () => {
  const menu = sharingFixture(2, true);
  const result = await mediate({ storeId: menu.store.id, members: members() }, sharingDeps(menu, 137));
  for (const plan of result.plans.filter(plan => plan.sharedMeals?.length)) {
    assert.equal(plan.allocations.reduce((sum, member) => sum + member.totalCents, 0), plan.payableCents);
    assert.equal(plan.productSubtotalCents - plan.discountCents, plan.payableCents);
    assert.equal(plan.sharedMeals![0].memberSubtotals.reduce((sum, member) => sum + member.subtotalCents, 0), plan.sharedMeals![0].subtotalCents);
    assert.ok(plan.allocations.every(member => Number.isInteger(member.totalCents)));
  }
  assert.ok(result.plans.some(plan => plan.sharedMeals?.length));
});

test('three members can share one three-person meal, four can share two separate two-person meals', async () => {
  for (const count of [3, 4]) {
    const menu = sharingFixture(count === 3 ? 3 : 2);
    const result = await mediate({ storeId: menu.store.id, members: members(count) }, sharingDeps(menu));
    const plan = result.plans.find(plan => plan.strategy === 'saving')!;
    assert.ok(plan.sharedMeals?.length === (count === 3 ? 1 : 2));
    assert.equal(new Set(plan.sharedMeals.flatMap(meal => meal.memberIds)).size, count);
    assert.deepEqual(plan.basket, [{ productId: 'share-combo', quantity: count === 3 ? 1 : 2 }]);
    assert.equal(plan.allocations.reduce((sum, member) => sum + member.totalCents, 0), plan.totalCents);
  }
});

test('each person receives only compatible components even when a shared parent contains both beef and spicy food', async () => {
  const menu = sharingFixture(); const beef = { ...menu.items[0], id: 'beef', name: '牛肉汉堡' }; const chicken = { ...menu.items[0], id: 'spicy', name: '麦辣鸡腿堡' };
  menu.items.push(beef, chicken);
  menu.items[3].combo!.components.splice(0, 1, { id: beef.id, name: beef.name, quantity: 1 }, { id: chicken.id, name: chicken.name, quantity: 1 });
  const input = members(); input[0].requirement = 'no-beef'; input[1].requirement = 'no-spicy';
  const result = await mediate({ storeId: menu.store.id, members: input }, sharingDeps(menu));
  const meal = result.plans.find(plan => plan.sharedMeals?.length)!.sharedMeals![0];
  assert.deepEqual(meal.components.find(part => part.id === 'beef')!.memberIds, [2]);
  assert.deepEqual(meal.components.find(part => part.id === 'spicy')!.memberIds, [1]);
});

test('drink exclusions are checked on the assigned cups, without discarding any recipe items', async () => {
  const menu = sharingFixture(); const input = members(); input[0].dislikes = ['drink'];
  const result = await mediate({ storeId: menu.store.id, members: input }, sharingDeps(menu));
  const meal = result.plans.find(plan => plan.sharedMeals?.length)!.sharedMeals![0];
  assert.ok(meal.components.filter(part => part.category === 'drink').every(part => part.memberIds.length === 1 && part.memberIds[0] === 2));
  assert.equal(meal.components.length, 5);
});

test('missing child menu prices use explicit portion weights, never invented child prices', async () => {
  const menu = sharingFixture(); menu.items[3].combo!.components[2].id = 'unlisted-cup';
  const result = await mediate({ storeId: menu.store.id, members: members() }, sharingDeps(menu));
  const meal = result.plans.find(plan => plan.sharedMeals?.length)!.sharedMeals![0];
  assert.equal(meal.allocationBasis, 'equal-portions');
  assert.equal(meal.components.find(part => part.id === 'unlisted-cup')!.referencePriceCents, null);
});

test('sharing cannot hide an exceeded individual budget or pretend a missing recipe is verified', async () => {
  const menu = sharingFixture(); const input = members(); input[0].budget = 5;
  const result = await mediate({ storeId: menu.store.id, members: input }, sharingDeps(menu));
  assert.equal(result.plans.length, 0);
  delete menu.items[3].combo;
  const unresolved = await mediate({ storeId: menu.store.id, members: members() }, sharingDeps(menu));
  assert.ok(unresolved.plans.every(plan => !plan.sharedMeals?.length));
});

test('revision preserves shared recipes and other members; cheaper does not drop a shared participant', async () => {
  const menu = sharingFixture(); const input = members(); input.forEach(member => member.budget = 60);
  const base = await mediate({ storeId: menu.store.id, members: input }, sharingDeps(menu));
  const previous = base.plans.find(plan => plan.sharedMeals?.length)!;
  const snapshot = { ...previous };
  const revised = await mediate({ storeId: menu.store.id, members: input, revision: { memberId: 1, action: 'hungrier' }, excludePlan: snapshot }, sharingDeps(menu));
  assert.ok(revised.plans.length === 1);
  assert.deepEqual(revised.plans[0].sharedMeals!.map(meal => meal.components), previous.sharedMeals!.map(meal => meal.components));
  assert.deepEqual(revised.plans[0].allocations[1].sharedItems, previous.allocations[1].sharedItems);
  assert.ok(revised.plans[0].allocations[0].items.length > 0);
  const cheap = await mediate({ storeId: menu.store.id, members: input, revision: { memberId: 1, action: 'cheaper' }, excludePlan: snapshot }, sharingDeps(menu));
  assert.equal(cheap.plans.length, 0); assert.equal(cheap.issues[0].code, 'revision_shared_locked');
  const damaged = structuredClone(snapshot); damaged.sharedMeals![0].components[0].quantity = 2;
  const invalid = await mediate({ storeId: menu.store.id, members: input, revision: { memberId: 1, action: 'hungrier' }, excludePlan: damaged }, sharingDeps(menu));
  assert.equal(invalid.plans.length, 0); assert.equal(invalid.issues[0].code, 'revision_shared_changed');
});

test('rule-generated shared assignments are not labelled as model assignments', async () => {
  const menu = sharingFixture();
  const result = await mediate({ storeId: menu.store.id, members: members() }, { ...sharingDeps(menu), proposals: { label: 'fixture-model', propose: async () => ({ proposal: { plans: ['saving', 'peace', 'happy'].map(strategy => ({ strategy, allocations: [1, 2].map(memberId => ({ memberId, items: [{ productId: 'burger', quantity: 1 }] })) })) }, raw: '', latencyMs: 1 }) } });
  assert.ok(result.plans.some(plan => plan.sharedMeals?.length));
  for (const plan of result.plans.filter(plan => plan.sharedMeals?.length)) assert.equal(result.meta.llmDetail?.find(attempt => attempt.strategy === plan.strategy)?.code, 'shared_rule_choice');
});

test('self-filled requirements stay pending review in a shared plan', async () => {
  const menu = sharingFixture(); const input = members(); input[0].requirement = 'other'; input[0].customRequirement = '不要冰';
  const result = await mediate({ storeId: menu.store.id, members: input }, sharingDeps(menu));
  const plan = result.plans.find(plan => plan.sharedMeals?.length)!;
  assert.equal(plan.allocations[0].requiresManualReview, true);
  assert.equal(plan.requiresManualReview, true);
});
