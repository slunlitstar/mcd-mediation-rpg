import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, generateLivePlans, liveRequestBody, loadStores, parseLiveResult, preferredStrategy, resultSourceLabel } from './live-service';
import { newMember } from './demo-data';
import type { Party } from '../types/demo';

const sample = JSON.parse(readFileSync(new URL('../../../server/fixtures/normalized/mediate.sample.json', import.meta.url), 'utf8'));
const party: Party = { storeId: sample.store.id, members: [35, 30, 40].map((budget, index) => ({ ...newMember(index + 1), roleId: 'saver', budget, configured: true })) };
const fixture = () => structuredClone(sample);
const respond = (value: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

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
