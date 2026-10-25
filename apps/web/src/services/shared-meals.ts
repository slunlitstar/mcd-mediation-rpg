import type { Allocation, Category, Party, Plan, Product } from '../types/demo';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Check physical inventory separately from per-person display references. */
export function validateSharedPlan(plan: Plan, products: Product[], party: Party): void {
  const fail = (reason: string): never => { throw new Error(`共享套餐数据未通过核对：${reason}，请重新生成。`); };
  if (plan.sharedMeals !== undefined && (!Array.isArray(plan.sharedMeals) || plan.sharedMeals.length > 2)) fail('共享套餐数量有误');
  const meals = plan.sharedMeals ?? [];
  const mealIds = new Set<string>(); const groupedMembers = new Set<number>(); const expected = new Set<string>(); const actual = new Set<string>();
  const basket = new Map<string, number>();
  for (const allocation of plan.allocations) for (const item of allocation.items) basket.set(item.productId, (basket.get(item.productId) ?? 0) + item.quantity);
  for (const meal of meals) {
    if (!record(meal) || typeof meal.sharedMealId !== 'string' || mealIds.has(meal.sharedMealId) || meal.quantity !== 1 || !Array.isArray(meal.memberIds) || meal.memberIds.length < 2 || meal.memberIds.length > 4 || new Set(meal.memberIds).size !== meal.memberIds.length || meal.memberIds.some(id => groupedMembers.has(id) || !party.members.some(member => member.id === id))) fail('参与成员或整套数量有误');
    mealIds.add(meal.sharedMealId); meal.memberIds.forEach(id => groupedMembers.add(id));
    const parent = products.find(product => product.id === meal.productId);
    if (!parent?.isCombo || !parent.components?.length || !Array.isArray(meal.components)) fail('套餐组成缺失');
    if (parent!.components!.reduce((sum, component) => sum + component.quantity, 0) > 24) fail('套餐餐品数量超出范围');
    const units = parent!.components!.flatMap((component, index) => Array.from({ length: component.quantity }, (_, unit) => ({ ...component, componentId: `${index}:${unit}` })));
    if (units.length > 24 || units.length !== meal.components.length) fail('餐品重复或缺失');
    const basis = units.every(unit => Number(unit.referencePriceCents) > 0) ? 'component-menu-price' : 'equal-portions';
    if (meal.allocationBasis !== basis) fail('分摊依据不一致');
    const componentIds = new Set<string>();
    for (const component of meal.components) {
      if (!record(component)) fail('餐品结构有误');
      const official = units.find(unit => unit.componentId === component.componentId);
      if (!official || componentIds.has(component.componentId) || component.id !== official.id || component.name !== official.name || component.category !== official.category || component.hasMain !== official.hasMain || component.quantity !== 1 || !Array.isArray(component.memberIds) || !component.memberIds.length || new Set(component.memberIds).size !== component.memberIds.length || component.memberIds.some(id => !meal.memberIds.includes(id))) fail('餐品归属或数量不一致');
      if ((component.hasMain || !['fries', 'snack'].includes(component.category)) && component.memberIds.length !== 1) fail('主餐或饮料被拆分');
      componentIds.add(component.componentId);
      for (const memberId of component.memberIds) {
        const member = party.members.find(member => member.id === memberId)!;
        if (member.dislikes.includes(component.category) || member.requirement === 'no-spicy' && official!.dietary?.spicy.inferred || member.requirement === 'no-beef' && official!.dietary?.beef.inferred) fail('分餐不满足食物限制');
        expected.add(`${memberId}/${meal.sharedMealId}/${component.componentId}`);
      }
    }
    if (meal.memberIds.some(id => !meal.components.some(component => component.hasMain && component.memberIds.includes(id)))) fail('有人没有分到主餐');
    if (!cents(meal.subtotalCents) || !Array.isArray(meal.memberSubtotals) || meal.memberSubtotals.some(entry => !record(entry)) || meal.memberSubtotals.length !== meal.memberIds.length || new Set(meal.memberSubtotals.map(entry => entry.memberId)).size !== meal.memberIds.length || meal.memberSubtotals.some(entry => !meal.memberIds.includes(entry.memberId) || !cents(entry.subtotalCents)) || meal.memberSubtotals.reduce((sum, entry) => sum + entry.subtotalCents, 0) !== meal.subtotalCents) fail('套餐分摊金额不一致');
    const weights = meal.memberIds.map(memberId => meal.components.reduce((sum, part) => {
      const official = units.find(unit => unit.componentId === part.componentId)!;
      return sum + (part.memberIds.includes(memberId) ? (basis === 'component-menu-price' ? official.referencePriceCents! : 1) / part.memberIds.length : 0);
    }, 0));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const exact = weights.map((weight, index) => ({ index, value: meal.subtotalCents * weight / totalWeight }));
    const expectedSubtotals = exact.map(entry => Math.floor(entry.value));
    let remainder = meal.subtotalCents - expectedSubtotals.reduce((sum, value) => sum + value, 0);
    const ranked = [...exact].sort((a, b) => b.value - Math.floor(b.value) - (a.value - Math.floor(a.value)));
    for (let index = 0; remainder > 0; index++, remainder--) expectedSubtotals[ranked[index % ranked.length].index]++;
    if (meal.memberIds.some((id, index) => meal.memberSubtotals.find(entry => entry.memberId === id)?.subtotalCents !== expectedSubtotals[index])) fail('分摊与餐品归属不一致');
    basket.set(meal.productId, (basket.get(meal.productId) ?? 0) + 1);
  }
  for (const allocation of plan.allocations) {
    if (allocation.sharedItems !== undefined && !Array.isArray(allocation.sharedItems)) fail('个人分餐引用有误');
    for (const ref of allocation.sharedItems ?? []) {
      if (!record(ref) || typeof ref.sharedMealId !== 'string' || typeof ref.componentId !== 'string') fail('个人分餐引用有误');
      const key = `${allocation.memberId}/${ref.sharedMealId}/${ref.componentId}`;
      if (!expected.has(key) || actual.has(key)) fail('个人分餐重复或越界');
      actual.add(key);
    }
  }
  if (actual.size !== expected.size) fail('套餐中有餐品未分配');
  if (meals.length) {
    if (!Array.isArray(plan.basket) || plan.basket.some(item => !record(item)) || plan.basket.length !== basket.size || new Set(plan.basket.map(item => item.productId)).size !== basket.size || plan.basket.some(item => !Number.isSafeInteger(item.quantity) || item.quantity !== basket.get(item.productId))) fail('整单购买数量不一致');
    const subtotal = plan.allocations.reduce((sum, allocation) => sum + allocation.items.reduce((value, item) => value + (item.subtotalCents ?? NaN), 0), 0) + meals.reduce((sum, meal) => sum + meal.subtotalCents, 0);
    if (subtotal !== plan.productSubtotalCents) fail('套餐被重复计费或商品小计不一致');
  }
}

export function allocationCategories(allocation: Allocation | undefined, plan: Plan | undefined, products: Product[]): Category[] {
  return [...new Set([...(allocation?.items ?? []).flatMap(item => { const product = products.find(product => product.id === item.productId); return product?.includedCategories ?? (product ? [product.category] : []); }), ...(allocation?.sharedItems ?? []).flatMap(ref => { const component = plan?.sharedMeals?.find(meal => meal.sharedMealId === ref.sharedMealId)?.components.find(component => component.componentId === ref.componentId); return component ? [component.category] : []; })])];
}

export function sharedSignature(allocation: Allocation): string {
  return (allocation.sharedItems ?? []).map(ref => `${ref.sharedMealId}/${ref.componentId}`).sort().join('|');
}
