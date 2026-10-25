import type { Category, MediateProduct, MemberInput } from './mediate.js';

export interface SharedReference { sharedMealId: string; componentId: string }
export type MealComponent = NonNullable<MediateProduct['components']>[number];
export interface SharedComponent extends MealComponent { componentId: string; memberIds: number[] }
export interface SharedDraft {
  sharedMealId: string;
  productId: string;
  quantity: 1;
  memberIds: number[];
  components: SharedComponent[];
  allocationBasis: 'component-menu-price' | 'equal-portions';
}
export interface SharedMeal extends SharedDraft {
  subtotalCents: number;
  memberSubtotals: { memberId: number; subtotalCents: number }[];
}

export function allowsComponent(member: MemberInput, component: MealComponent): boolean {
  return !(member.dislikes ?? []).includes(component.category) &&
    !(member.requirement === 'no-spicy' && component.dietary?.spicy.inferred) &&
    !(member.requirement === 'no-beef' && component.dietary?.beef.inferred);
}

export function sharedWeights(draft: SharedDraft): { memberId: number; rawFen: number }[] {
  return draft.memberIds.map(memberId => ({ memberId, rawFen: draft.components.reduce((sum, component) =>
    sum + (component.memberIds.includes(memberId) ? (draft.allocationBasis === 'component-menu-price' ? component.referencePriceCents! : 1) * component.quantity / component.memberIds.length : 0), 0) }));
}

export function componentUnits(product: MediateProduct): Omit<SharedComponent, 'memberIds'>[] {
  if (!product.isCombo || !product.components?.length) return [];
  if (product.components.reduce((sum, component) => sum + component.quantity, 0) > 24) return [];
  return product.components.flatMap((component, index) => Array.from({ length: component.quantity }, (_, unit) => ({ ...component, quantity: 1, componentId: `${index}:${unit}` })));
}

/** Bounded assignments of a verified default recipe. No fractional burgers/cups,
 * no discarded pieces and no change of the actual order recipe. */
export function sharedDrafts(products: MediateProduct[], members: MemberInput[]): SharedDraft[] {
  const drafts: SharedDraft[] = [];
  for (const product of products) {
    const units = componentUnits(product);
    if (units.filter(component => component.hasMain).length < 2) continue;
    for (let mask = 1; mask < 1 << members.length; mask++) {
      const group = members.filter((_, index) => mask & 1 << index);
      if (group.length < 2 || group.length > units.filter(component => component.hasMain).length) continue;
      const memberIds = group.map(member => member.id);
      const basis = units.every(component => Number.isSafeInteger(component.referencePriceCents) && Number(component.referencePriceCents) > 0) ? 'component-menu-price' : 'equal-portions';
      const totalWeight = units.reduce((sum, component) => sum + (basis === 'component-menu-price' ? component.referencePriceCents! : 1), 0);
      const ordered = [...units].sort((a, b) => Number(b.hasMain) - Number(a.hasMain));
      const mainCount = units.filter(component => component.hasMain).length;
      const score = (components: SharedComponent[]): number => group.reduce((sum, member) => {
        const assigned = components.filter(component => component.memberIds.includes(member.id));
        const categories = new Set(assigned.map(component => component.category));
        const weight = assigned.reduce((value, component) => value + (basis === 'component-menu-price' ? component.referencePriceCents! : 1) / component.memberIds.length, 0);
        const estimated = product.priceCents * weight / Math.max(1, totalWeight);
        const excess = Math.max(0, estimated - (member.budget ?? 0) * 100);
        const main = assigned.some(component => component.hasMain);
        const required = ['burger', 'fries', 'drink'].includes(member.requirement ?? '') ? member.requirement as Category : null;
        return sum + Number(main) * 1000 + Number(required !== null && categories.has(required)) * 80 +
          (member.likes ?? []).filter(category => categories.has(category)).length * 10 +
          Number(member.hunger === 'faint' && categories.has('drink')) * 5 - excess - Math.abs(weight / Math.max(1, totalWeight) - 1 / group.length) * 10;
      }, 0);
      let beam: SharedComponent[][] = [[]];
      for (const [index, component] of ordered.entries()) {
        const allowed = group.filter(member => allowsComponent(member, component)).map(member => member.id);
        if (!allowed.length) { beam = []; break; }
        const choices: number[][] = [];
        const canShare = !component.hasMain && ['fries', 'snack'].includes(component.category);
        for (let subset = 1; subset < 1 << allowed.length; subset++) {
          const consumers = allowed.filter((_, bit) => subset & 1 << bit);
          if (canShare || consumers.length === 1) choices.push(consumers);
        }
        const next = beam.flatMap(assigned => choices.map(consumers => [...assigned, { ...component, memberIds: consumers }])).filter(assigned =>
          index + 1 < mainCount || memberIds.every(id => assigned.some(part => part.hasMain && part.memberIds.includes(id))));
        beam = next.map(components => ({ components, score: score(components) })).sort((a, b) => b.score - a.score).slice(0, 96).map(entry => entry.components);
        if (!beam.length) break;
      }
      for (const components of beam.slice(0, 3)) drafts.push({ sharedMealId: `shared-${product.id}-${memberIds.join('-')}`, productId: product.id, quantity: 1, memberIds, components: [...components].sort((a, b) => a.componentId.localeCompare(b.componentId)), allocationBasis: basis });
    }
  }
  const perGroup = new Map<string, number>();
  return drafts.sort((a, b) => products.find(product => product.id === a.productId)!.priceCents / a.memberIds.length - products.find(product => product.id === b.productId)!.priceCents / b.memberIds.length).filter(draft => {
    const key = draft.memberIds.join('-'); const count = perGroup.get(key) ?? 0;
    perGroup.set(key, count + 1); return count < 6;
  });
}

/** Rebuild an untrusted revision snapshot from the current authoritative recipe. */
export function restoreSharedDrafts(raw: unknown, products: MediateProduct[], members: MemberInput[]): SharedDraft[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 2) throw new Error('sharedMeals 必须是最多两个共享套餐');
  const ids = new Set<string>(); const usedMembers = new Set<number>();
  return raw.map(value => {
    if (!value || typeof value !== 'object') throw new Error('共享套餐结构不完整');
    const meal = value as SharedMeal;
    const product = products.find(product => product.id === meal.productId);
    const recipe = product ? componentUnits(product) : [];
    if (!product || !recipe.length || typeof meal.sharedMealId !== 'string' || ids.has(meal.sharedMealId) || meal.quantity !== 1 || !Array.isArray(meal.memberIds) || meal.memberIds.length < 2 || meal.memberIds.length > 4 || new Set(meal.memberIds).size !== meal.memberIds.length || meal.memberIds.some(id => usedMembers.has(id) || !members.some(member => member.id === id)) || !Array.isArray(meal.components) || meal.components.length !== recipe.length) throw new Error('共享套餐或参与成员无效');
    ids.add(meal.sharedMealId); meal.memberIds.forEach(id => usedMembers.add(id));
    const componentIds = new Set<string>();
    const components = meal.components.map(component => {
      const official = recipe.find(part => part.componentId === component.componentId);
      if (!official || componentIds.has(component.componentId) || component.id !== official.id || component.quantity !== 1 || !Array.isArray(component.memberIds) || !component.memberIds.length || new Set(component.memberIds).size !== component.memberIds.length || component.memberIds.some(id => !meal.memberIds.includes(id))) throw new Error('共享套餐餐品数量或归属无效');
      if ((official.hasMain || !['fries', 'snack'].includes(official.category)) && component.memberIds.length !== 1) throw new Error('主餐和饮料必须整份分配');
      if (component.memberIds.some(id => !allowsComponent(members.find(member => member.id === id)!, official))) throw new Error('共享餐品不满足成员食物限制');
      componentIds.add(component.componentId); return { ...official, memberIds: component.memberIds };
    });
    if (meal.memberIds.some(id => !components.some(component => component.hasMain && component.memberIds.includes(id)))) throw new Error('每位共享成员必须分到主餐');
    const allocationBasis = components.every(component => Number(component.referencePriceCents) > 0) ? 'component-menu-price' : 'equal-portions';
    return { sharedMealId: meal.sharedMealId, productId: meal.productId, quantity: 1, memberIds: meal.memberIds, components, allocationBasis };
  });
}
