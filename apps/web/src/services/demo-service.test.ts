import assert from 'node:assert/strict';
import test from 'node:test';
import { exampleParty, hungers, newMember, productFor } from './demo-data';
import { generateDemoPlans, memberError } from './demo-service';
import type { Member, Party } from '../types/demo';

function validatePlans(party: Party, result: Awaited<ReturnType<typeof generateDemoPlans>>) {
  assert.equal(result.issues.length, 0);
  assert.equal(result.plans.length, 3);
  for (const plan of result.plans) {
    assert.equal(plan.allocations.length, party.members.length);
    assert.equal(plan.totalCents, plan.allocations.reduce((sum, allocation) => sum + allocation.totalCents, 0));
    for (const allocation of plan.allocations) {
      const member = party.members.find(person => person.id === allocation.memberId)!;
      const items = allocation.items.flatMap(item => Array.from({ length: item.quantity }, () => productFor(item.productId)));
      assert.equal(allocation.totalCents, items.reduce((sum, item) => sum + item.priceCents, 0));
      assert.ok(allocation.totalCents <= Math.round(member.budget! * 100));
      assert.ok(items.reduce((sum, item) => sum + item.fullness, 0) >= hungers.find(hunger => hunger.id === member.hunger)!.units);
      assert.ok(items.every(item => !member.dislikes.includes(item.category)));
      if (member.requirement === 'no-spicy') assert.ok(items.every(item => !item.spicy));
      if (member.requirement === 'no-beef') assert.ok(items.every(item => !item.beef));
      if (['burger', 'fries', 'drink'].includes(member.requirement)) assert.ok(items.some(item => item.category === member.requirement));
    }
  }
}

test('example plans respect each member and reconcile every amount', async () => {
  const party = exampleParty();
  validatePlans(party, await generateDemoPlans({ party }));
});

test('2 and 4 member meals preserve hard constraints across hunger levels', async () => {
  for (const count of [2, 4]) {
    for (const hunger of hungers) {
      const members: Member[] = Array.from({ length: count }, (_, index) => ({
        ...newMember(index + 1), roleId: 'hungry', budget: 40, hunger: hunger.id,
        likes: ['burger', 'drink'], dislikes: ['dessert'],
        requirement: index % 2 ? 'no-beef' : 'no-spicy', configured: true,
      }));
      const party = { storeId: 'demo-campus', members };
      validatePlans(party, await generateDemoPlans({ party }));
    }
  }
});

test('unaffordable meals return an issue instead of overspending', async () => {
  const party = exampleParty(); party.members[0].budget = 1;
  const result = await generateDemoPlans({ party });
  assert.equal(result.plans.length, 0);
  assert.equal(result.issues[0].memberId, 1);
  assert.equal(result.issues[0].kind, 'constraint');
});

test('invalid and contradictory input is rejected', async () => {
  const member = { ...exampleParty().members[0], requirement: 'fries' as const, dislikes: ['fries' as const] };
  assert.match(memberError(member)!, /冲突/);
  for (const budget of [null, 0, -1, 201, 20.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.ok(memberError({ ...exampleParty().members[0], budget }));
  const party = exampleParty(); party.members[0] = member;
  const result = await generateDemoPlans({ party });
  assert.equal(result.plans.length, 0);
  assert.equal(result.issues[0].kind, 'input');
});

test('cheaper revision preserves other members and does not invent savings', async () => {
  const party = exampleParty();
  const before = await generateDemoPlans({ party });
  const selected = before.plans.find(plan => plan.strategy === 'peace')!;
  const after = await generateDemoPlans({ party, revision: { memberId: 1, action: 'cheaper' }, excludePlan: selected });
  validatePlans(party, after);
  const updated = after.plans.find(plan => plan.strategy === 'peace')!;
  assert.ok(updated.allocations[0].totalCents <= selected.allocations[0].totalCents);
  assert.deepEqual(updated.allocations.slice(1), selected.allocations.slice(1));
  const minimum = after.plans.find(plan => plan.strategy === 'saving')!;
  const again = await generateDemoPlans({ party, revision: { memberId: 1, action: 'cheaper' }, excludePlan: minimum });
  assert.ok(again.plans.find(plan => plan.strategy === 'saving')!.explanations.some(text => text.includes('没有更便宜')));
});

test('a changed hunger request can become infeasible without silently relaxing a rule', async () => {
  const party = exampleParty(); party.members[0].budget = 12; party.members[0].hunger = 'faint';
  const before = structuredClone(party);
  const result = await generateDemoPlans({ party, revision: { memberId: 1, action: 'hungrier' } });
  assert.equal(result.plans.length, 0);
  assert.deepEqual(party, before);
});

test('custom requirements require meaningful text and reject excessively long input', () => {
  const member: Member = { ...exampleParty().members[0], requirement: 'other', customRequirement: '   ' };
  assert.match(memberError(member)!, /请填写/);
  assert.match(memberError({ ...member, customRequirement: '字'.repeat(121) })!, /120/);
  assert.equal(memberError({ ...member, customRequirement: '饮料不要冰' }), null);
});

test('custom text is retained while unverified requirements are marked for review in every strategy', async () => {
  const party = exampleParty();
  party.members[0] = { ...party.members[0], requirement: 'other', customRequirement: '汉堡不要酱，饮料不要冰' };
  const original = structuredClone(party);
  const result = await generateDemoPlans({ party });
  validatePlans(party, result);
  for (const plan of result.plans) {
    assert.equal(plan.allocations[0].requiresManualReview, true);
    assert.ok(plan.allocations.slice(1).every(allocation => !allocation.requiresManualReview));
    assert.ok(plan.explanations.some(text => text.includes('无法自动判断')));
  }
  assert.deepEqual(party, original);
  const after = await generateDemoPlans({ party, revision: { memberId: 2, action: 'cheaper' }, excludePlan: result.plans[0] });
  assert.ok(after.plans.every(plan => plan.allocations[0].requiresManualReview));
  assert.equal(party.members[0].customRequirement, original.members[0].customRequirement);
});
