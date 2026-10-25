import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, generateLivePlans, liveRequestBody, loadStores, parseLiveResult, preferredStrategy, prepareRecovery, resultSourceLabel } from './live-service';
import { newMember } from './demo-data';
import type { Party } from '../types/demo';
import { allocationCategories } from './shared-meals';

const sample = JSON.parse(readFileSync(new URL('../../../server/fixtures/normalized/mediate.sample.json', import.meta.url), 'utf8'));
const party: Party = { storeId: sample.store.id, members: [35, 30, 40].map((budget, index) => ({ ...newMember(index + 1), roleId: 'saver', budget, configured: true })) };
const fixture = () => structuredClone(sample);
const respond = (value: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const sharedSample = JSON.parse(readFileSync(new URL('../../../server/fixtures/normalized/mediate.shared.sample.json', import.meta.url), 'utf8'));
const sharedParty: Party = { storeId: sharedSample.store.id, members: [1, 2].map(id => ({ ...newMember(id), roleId: 'saver', budget: 80, configured: true })) };

test('real shared fixture preserves one physical purchase, complete component ownership and exact money', () => {
  const result = parseLiveResult(structuredClone(sharedSample), sharedParty);
  const plan = result.plans.find(plan => plan.sharedMeals?.length)!;
  assert.ok(plan);
  assert.equal(plan.sharedMeals![0].quantity, 1);
  assert.equal(plan.basket!.filter(item => item.productId === plan.sharedMeals![0].productId)[0].quantity, 1);
  assert.equal(plan.allocations.reduce((sum, member) => sum + member.totalCents, 0), plan.totalCents);
  assert.ok(plan.allocations.every(member => member.items.length === 0 && member.sharedItems!.length > 0));
  assert.ok(allocationCategories(plan.allocations[0], plan, result.products!).includes('burger'));
  const body = liveRequestBody({ party: sharedParty, revision: { memberId: 1, action: 'hungrier' }, excludePlan: plan });
  assert.deepEqual(body.excludePlan!.sharedMeals, plan.sharedMeals);
  assert.deepEqual(body.excludePlan!.allocations[1].sharedItems, plan.allocations[1].sharedItems);
});

test('shared inventory tampering, orphan references, double purchases and incorrect weights are rejected', () => {
  const alter = (mutate: (data: typeof sharedSample, plan: any) => void) => {
    const data = structuredClone(sharedSample); const plan = data.plans.find((plan: any) => plan.sharedMeals?.length); mutate(data, plan);
    assert.throws(() => parseLiveResult(data, sharedParty), /共享套餐/);
  };
  alter((_data, plan) => { plan.sharedMeals[0].components[0].quantity = 2; });
  alter((_data, plan) => { plan.allocations[0].sharedItems.pop(); });
  alter((_data, plan) => { plan.sharedMeals[0].components.find((part: any) => part.hasMain).memberIds = [1, 2]; });
  alter((_data, plan) => { plan.basket[0].quantity = 2; });
  alter((_data, plan) => { plan.sharedMeals[0].memberSubtotals[0].subtotalCents++; plan.sharedMeals[0].memberSubtotals[1].subtotalCents--; });
});

test('client checks component-price weights as well as the equal-portion fallback', () => {
  const data = structuredClone(sharedSample); const plan = data.plans.find((plan: any) => plan.sharedMeals?.length);
  const meal = plan.sharedMeals[0]; const parent = data.products.find((product: any) => product.id === meal.productId);
  parent.components.forEach((component: any, index: number) => { component.referencePriceCents = index === 0 ? 2 : 1; });
  meal.allocationBasis = 'component-menu-price';
  // This real recipe is split into 4 reference portions each; member1's main
  // receives one extra reference unit, hence 5:4 of 11450 cents.
  meal.memberSubtotals = [{ memberId: 1, subtotalCents: 6361 }, { memberId: 2, subtotalCents: 5089 }];
  plan.allocations[0].totalCents = 6361; plan.allocations[1].totalCents = 5089;
  assert.ok(parseLiveResult(data, sharedParty).plans.some(plan => plan.sharedMeals?.length));
});

test('revision cannot silently change another participant shared component ownership', async () => {
  const previous = parseLiveResult(structuredClone(sharedSample), sharedParty).plans.find(plan => plan.sharedMeals?.length)!;
  // A completely valid independent-meal response still cannot replace a shared meal in one-member revision.
  const changed = structuredClone(sharedSample); changed.plans = changed.plans.filter((plan: any) => !plan.sharedMeals?.length);
  await assert.rejects(generateLivePlans({ party: sharedParty, revision: { memberId: 1, action: 'hungrier' }, excludePlan: previous }, undefined, respond({ ok: true, data: changed })), /共享套餐分配/);
});

test('verified recovery applies only explicit changes and revalidates all prices without mutating the party', () => {
  const original = structuredClone(party); original.members[0].budget = 1;
  const raw = { ...fixture(), plans: [], issues: [{ code: 'no_main_within_budget', kind: 'constraint', blocking: true, message: '预算不足' }], suggestions: [{ id: 's1', title: '调整预算', summary: '保留其他要求', verifiedAt: new Date().toISOString(), changes: [{ memberId: 1, budget: 35 }], plan: sample.plans[0] }] };
  const result = parseLiveResult(raw, original);
  assert.equal(result.plans.length, 0); assert.equal(result.suggestions?.length, 1);
  const next = prepareRecovery(result, original, result.suggestions![0]);
  assert.equal(original.members[0].budget, 1);
  assert.equal(next.party.members[0].budget, 35);
  assert.deepEqual(next.party.members.slice(1), original.members.slice(1));
  assert.equal(next.result.meta?.reasoning, 'rules');
  assert.equal(next.result.plans[0].allocations.reduce((sum, item) => sum + item.totalCents, 0), next.result.plans[0].payableCents);
  const invalid = structuredClone(raw); invalid.suggestions[0].changes[0].budget = 1;
  assert.equal(parseLiveResult(invalid, original).suggestions?.length, 0);
  const stale = structuredClone(raw); stale.suggestions[0].verifiedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  assert.equal(parseLiveResult(stale, original).suggestions?.length, 0);
  const dietary = structuredClone(original); dietary.members[0].requirement = 'no-beef';
  assert.throws(() => prepareRecovery(result, dietary, { ...result.suggestions![0], changes: [{ memberId: 1, requirement: 'none' }] }), ApiError);
});

test('backend fixture uses live catalog, exact cents and nonblocking manual review', () => {
  const result = parseLiveResult(fixture(), party);
  assert.equal(result.source, 'live');
  assert.equal(result.plans.length, 2);
  assert.ok(result.issues.some(issue => issue.code === 'custom_requirement_unverified' && issue.blocking === false));
  assert.ok(result.products!.every(product => product.fullness === null));
  assert.ok(result.plans.every(plan => plan.allocations.reduce((sum, item) => sum + item.totalCents, 0) === plan.payableCents));
  assert.equal(result.plans[0].planId, sample.plans[0].planId);
});

test('request adapter sends real store and complete previous plan without multiplying cents', () => {
  const result = parseLiveResult(fixture(), party);
  const body = liveRequestBody({ party, revision: { memberId: 2, action: 'cheaper' }, excludePlan: result.plans[0] });
  assert.equal(body.storeId, party.storeId);
  assert.equal(body.members[0].budget, 35);
  assert.equal(body.excludePlan?.payableCents, result.plans[0].totalCents);
  assert.equal(body.excludePlan?.allocations.length, 3);
  assert.throws(() => liveRequestBody({ party, revision: { memberId: 1, action: 'cheaper' } }), ApiError);
  const withSavedText = structuredClone(party); withSavedText.members[0].customRequirement = 'hidden old requirement';
  assert.equal(liveRequestBody({ party: withSavedText }).members[0].customRequirement, '');
  assert.equal(withSavedText.members[0].customRequirement, 'hidden old requirement');
});

test('reject inconsistent money, an exceeded budget, and unknown product IDs', () => {
  const mismatched = fixture(); mismatched.plans[0].allocations[0].totalCents += 1;
  assert.throws(() => parseLiveResult(mismatched, party), ApiError);
  const smallBudget = structuredClone(party); smallBudget.members[0].budget = 1;
  assert.throws(() => parseLiveResult(fixture(), smallBudget), ApiError);
  const unknown = fixture(); unknown.plans[0].allocations[0].items[0].productId = 'invented';
  assert.throws(() => parseLiveResult(unknown, party), ApiError);
  const unverified = fixture(); unverified.meta.pricingVerified = false;
  assert.throws(() => parseLiveResult(unverified, party), ApiError);
});

test('missing input and no-solution responses remain distinguishable from service failure', () => {
  const data = fixture(); data.plans = []; data.meta.pricingVerified = false;
  data.issues = [{ memberId: 1, code: 'budget_missing', kind: 'input', blocking: false, message: '请填写预算' }];
  const result = parseLiveResult(data, party);
  assert.equal(result.plans.length, 0); assert.equal(result.issues[0].kind, 'input');
  data.issues = [{ memberId: 1, code: 'constraint', kind: 'constraint', blocking: true, message: '预算不足' }];
  assert.equal(parseLiveResult(data, party).issues[0].kind, 'constraint');
});

test('strategy fallback handles deduplicated peace or happy without inventing a plan', () => {
  const result = parseLiveResult(fixture(), party);
  assert.equal(preferredStrategy([result.plans[0]], 'happy'), result.plans[0].strategy);
  assert.equal(result.plans.some(plan => plan.strategy === 'happy'), false);
  assert.match(resultSourceLabel(result), /规则推荐/);
  assert.doesNotMatch(resultSourceLabel(result), /模型参与/);
});

test('uses API envelope and real store query; HTTP errors never turn into demo results', async () => {
  let received = '';
  const stores = await loadStores('上海', '人民广场', undefined, async input => { received = String(input); return new Response(JSON.stringify({ ok: true, data: [{ id: 'real-store', name: '测试店' }] })); });
  assert.equal(new URL(received, 'http://localhost').searchParams.get('city'), '上海');
  assert.equal(stores[0].id, 'real-store');
  const result = await generateLivePlans({ party }, undefined, respond({ ok: true, data: fixture() }));
  assert.equal(result.source, 'live');
  await assert.rejects(generateLivePlans({ party }, undefined, respond({ ok: false, error: { kind: 'mcp_auth_failed', message: 'internal configuration detail' } }, 502)), /服务端配置/);
  await assert.rejects(generateLivePlans({ party }, undefined, respond({ ok: false, error: { kind: 'bad_request', message: 'members 必须 2–4 人' } }, 400)), /2–4/);
  await assert.rejects(generateLivePlans({ party }, undefined, async () => { throw new TypeError('offline'); }), /连接不上/);
});

test('an aborted request is cancelled instead of updating a later screen', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateLivePlans({ party }, controller.signal, async (_url, init) => { init!.signal!.throwIfAborted(); throw new Error('must not be reached'); }), { name: 'AbortError' });
});

test('revision result cannot silently replace another member or reuse unchanged target', async () => {
  const previous = parseLiveResult(fixture(), party).plans[0];
  const request = { party, revision: { memberId: 1, action: 'cheaper' as const }, excludePlan: previous };
  await assert.rejects(generateLivePlans(request, undefined, respond({ ok: true, data: fixture() })), /原方案已保留/);
});

test('model fixture passes the same catalog and money checks; source labels follow each strategy', () => {
  const modelSample = JSON.parse(readFileSync(new URL('../../../server/fixtures/normalized/mediate.llm.sample.json', import.meta.url), 'utf8'));
  const modelParty: Party = { storeId: modelSample.store.id, members: modelSample.plans[0].allocations.map((allocation: { memberId: number; budgetCents: number }) => ({ ...newMember(allocation.memberId), roleId: 'saver', budget: allocation.budgetCents / 100 })) };
  const parsed = parseLiveResult(modelSample, modelParty);
  assert.ok(parsed.plans.length > 0);
  assert.match(resultSourceLabel(parsed, true, parsed.plans[0].strategy), /模型参与/);
  const mixed = structuredClone(parsed);
  mixed.meta!.degraded = true;
  mixed.meta!.llmDetail = [{ strategy: 'saving', status: 'accepted' }, { strategy: 'peace', status: 'rejected' }, { strategy: 'happy', status: 'skipped' }];
  assert.match(resultSourceLabel(mixed, true, 'saving'), /模型参与/);
  assert.match(resultSourceLabel(mixed, true, 'peace'), /规则推荐/);
  assert.match(resultSourceLabel(mixed, true, 'happy'), /规则推荐/);
});
