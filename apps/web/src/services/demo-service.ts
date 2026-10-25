import { categoryLabel, hungers, products, strategies } from './demo-data';
import type { Allocation, Category, MediationRequest, MediationResult, Member, Plan, Product, Strategy } from '../types/demo';

interface Candidate {
  items: Allocation['items'];
  cost: number;
  fullness: number;
  categories: Category[];
  variety: number;
}

export function memberError(member: Member): string | null {
  const customRequirement = (member.customRequirement ?? '').trim();
  if (!member.roleId) return '先选一个属于你的角色吧。';
  if (member.budget === null || !Number.isFinite(member.budget) || member.budget < 1 || member.budget > 200 || !Number.isInteger(member.budget)) {
    return '请填写 1—200 元的整数预算。';
  }
  if (['burger', 'fries', 'drink'].includes(member.requirement) && member.dislikes.includes(member.requirement as Category)) {
    return '不可退让的要求与不喜欢的食物冲突，请调整其中一项。';
  }
  if (member.requirement === 'other' && !customRequirement) return '请填写这条不可退让的要求。';
  if (member.requirement === 'other' && customRequirement.length > 120) return '自填要求请控制在 120 字以内。';
  return null;
}

function candidatesFor(member: Member): Candidate[] {
  const budget = Math.round((member.budget ?? 0) * 100);
  const target = hungers.find(hunger => hunger.id === member.hunger)!.units;
  const allowed = products.filter(product =>
    !member.dislikes.includes(product.category) &&
    !(member.requirement === 'no-spicy' && product.spicy) &&
    !(member.requirement === 'no-beef' && product.beef));
  const candidates: Candidate[] = [];
  const visit = (start: number, selected: Product[], cost: number, fullness: number) => {
    if (cost > budget) return;
    const categories = [...new Set(selected.map(product => product.category))];
    const requiredCategory = ['burger', 'fries', 'drink'].includes(member.requirement) ? member.requirement as Category : null;
    if (selected.length && fullness >= target && (!requiredCategory || categories.includes(requiredCategory))) {
      const counts = new Map<string, number>();
      selected.forEach(product => counts.set(product.id, (counts.get(product.id) ?? 0) + 1));
      candidates.push({ items: [...counts].map(([productId, quantity]) => ({ productId, quantity })), cost, fullness, categories, variety: counts.size });
    }
    if (selected.length === 5) return;
    for (let index = start; index < allowed.length; index++) {
      const product = allowed[index];
      if (selected.filter(item => item.category === product.category).length >= (product.category === 'burger' ? 2 : 1)) continue;
      visit(index, [...selected, product], cost + product.priceCents, fullness + (product.fullness ?? 0));
    }
  };
  visit(0, [], 0, 0);
  return candidates;
}

function score(candidate: Candidate, member: Member, strategy: Strategy): number {
  const matches = member.likes.filter(category => candidate.categories.includes(category)).length;
  const target = hungers.find(hunger => hunger.id === member.hunger)!.units;
  const excess = candidate.fullness - target;
  if (strategy === 'saving') return -candidate.cost + matches * 0.1 - excess * 0.01;
  if (strategy === 'happy') return matches * 10000 + candidate.variety * 300 - candidate.cost * 0.1 - excess * 400;
  return matches * 2500 + candidate.variety * 100 - candidate.cost - excess * 300;
}

// Adapter boundary: replace this service with backend calls after the contract is agreed.
// No model, MCP, store API, coupon API or payment is invoked by this demo.
export async function generateDemoPlans(request: MediationRequest): Promise<MediationResult> {
  const { party } = request;
  const issues: MediationResult['issues'] = [];
  if (party.members.length < 2 || party.members.length > 4) {
    return { source: 'demo', plans: [], issues: [{ memberId: 0, message: '饭局需要 2—4 位成员。', kind: 'input' }] };
  }
  const options = party.members.map(member => {
    const error = memberError(member);
    if (error) {
      issues.push({ memberId: member.id, message: error, kind: 'input' });
      return [];
    }
    const candidates = candidatesFor(member);
    if (!candidates.length) issues.push({ memberId: member.id, message: '示例菜单暂时无法同时满足这些条件，可以调整预算、饥饿程度或食物要求。', kind: 'constraint' });
    return candidates;
  });
  if (issues.length) return { source: 'demo', plans: [], issues };

  const plans: Plan[] = strategies.map(strategy => {
    const allocations: Allocation[] = party.members.map((member, index) => {
      const previous = request.excludePlan?.strategy === strategy.id
        ? request.excludePlan.allocations.find(allocation => allocation.memberId === member.id) : undefined;
      const isRevisionTarget = request.revision?.memberId === member.id;
      let candidates = options[index];
      // A revision is a request, not a promise: if the cheapest option is unchanged,
      // retain it and explicitly explain that no cheaper valid option was found.
      if (isRevisionTarget && request.revision?.action === 'cheaper') {
        const minimum = Math.min(...candidates.map(candidate => candidate.cost));
        candidates = candidates.filter(candidate => candidate.cost === minimum);
      } else if (isRevisionTarget && previous) {
        const alternate = candidates.filter(candidate => JSON.stringify(candidate.items) !== JSON.stringify(previous.items));
        if (alternate.length) candidates = alternate;
      }
      const best = candidates.reduce((current, candidate) => score(candidate, member, strategy.id) > score(current, member, strategy.id) ? candidate : current);
      const matchedLikes = member.likes.filter(category => best.categories.includes(category));
      const missingLikes = member.likes.filter(category => !best.categories.includes(category));
      const reason = missingLikes.length
        ? `优先满足可核对的预算与食物限制；本套未安排${missingLikes.map(categoryLabel).join('、')}。`
        : matchedLikes.length ? `已安排你偏好的${matchedLikes.map(categoryLabel).join('、')}，同时满足示例饱腹条件。` : '满足预算和示例饱腹条件，优先保留花费余地。';
      return { memberId: member.id, items: best.items, totalCents: best.cost, matchedLikes, missingLikes, reason, requiresManualReview: member.requirement === 'other' };
    });
    const explanations = ['所有餐品和价格均为演示数据；同一订单，按成员分别分配。', '不喜欢的品类在本 Demo 中直接排除；饱腹程度使用示例权重计算。'];
    if (allocations.some(allocation => allocation.requiresManualReview)) explanations.push('自填要求已保留，但示例算法无法自动判断是否满足，请核对后再接受方案。');
    if (request.revision) {
      const current = allocations.find(allocation => allocation.memberId === request.revision!.memberId)!;
      const previous = request.excludePlan?.allocations.find(allocation => allocation.memberId === request.revision!.memberId);
      if (request.revision.action === 'cheaper' && previous && current.totalCents >= previous.totalCents) {
        explanations.push(`成员${request.revision.memberId}：目前没有更便宜且通过自动检查的示例组合，保留当前最低价选择；自填要求仍需核对。`);
      } else {
        explanations.push(`已按成员${request.revision.memberId}的复议重新检查预算与可计算的条件。`);
      }
    }
    return { strategy: strategy.id, allocations, totalCents: allocations.reduce((sum, allocation) => sum + allocation.totalCents, 0), explanations };
  });
  return { source: 'demo', plans, issues: [] };
}
