/** Offline HTTP integration: production routes + browser client, with fixture MCP dependencies. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleApi } from '../src/routes/api.js';
import { mcd } from '../src/services/mcd.js';
import { defaultCombo } from '../src/mcp/default-combo.js';
import type { UnifiedMenu, UnifiedPricing, UnifiedStore } from '../src/mcp/normalize.js';
import { generateLivePlans, liveRequestBody, loadStores, prepareRecovery } from '../../web/src/services/live-service.js';
import { newMember } from '../../web/src/services/demo-data.js';
import type { Party } from '../../web/src/types/demo.js';

const menu = JSON.parse(readFileSync(new URL('../fixtures/normalized/menu.json', import.meta.url), 'utf8')) as UnifiedMenu;
const details = JSON.parse(readFileSync(new URL('../fixtures/raw/meal-detail.json', import.meta.url), 'utf8')).details;
for (const item of menu.items) if (item.isCombo && details[item.id]) item.combo = defaultCombo(details[item.id]);
const stores = JSON.parse(readFileSync(new URL('../fixtures/normalized/stores.json', import.meta.url), 'utf8')) as UnifiedStore[];
const original = { menu: mcd.menu, stores: mcd.stores, price: mcd.price, call: mcd.call };
mcd.menu = async () => menu;
mcd.stores = async () => stores;
mcd.call = async () => ({ ok: true, data: [] });
mcd.price = async (_storeCode, items): Promise<UnifiedPricing> => {
  const lines = items.map(entry => {
    const item = menu.items.find(item => item.id === entry.productCode);
    assert.ok(item);
    const subtotalFen = item.priceFen * entry.quantity;
    return { itemId: item.id, name: item.name, quantity: entry.quantity, unitPrice: item.price, unitPriceFen: item.priceFen, originalSubtotal: subtotalFen / 100, originalSubtotalFen: subtotalFen, subtotal: subtotalFen / 100, subtotalFen };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.subtotalFen, 0);
  const discount = Math.min(201, subtotal);
  return { store: menu.store, currency: 'CNY', priceUnit: 'yuan', lines, productOriginalPrice: subtotal / 100, productOriginalPriceFen: subtotal, productPrice: subtotal / 100, productPriceFen: subtotal, originalPrice: subtotal / 100, originalPriceFen: subtotal, discount: discount / 100, discountFen: discount, payable: (subtotal - discount) / 100, payableFen: subtotal - discount };
};

const server = createServer((request, response) => {
  void handleApi(request, response, new URL(request.url ?? '/', 'http://localhost')).then(handled => { if (!handled) response.writeHead(404).end(); }).catch(() => response.writeHead(500).end());
});
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const fetcher: typeof fetch = (input, init) => fetch(new URL(String(input), base), init);
  const found = await loadStores('北京', '麦当劳', undefined, fetcher);
  assert.ok(found.length > 0);
  console.log('PASS browser client → stores HTTP route → fixture menu gateway');
  const party: Party = { storeId: menu.store.id, members: [1, 2].map(id => ({ ...newMember(id), budget: 80, roleId: 'saver', configured: true })) };
  const result = await generateLivePlans({ party }, undefined, fetcher);
  assert.ok(result.plans.length > 0);
  assert.ok(result.plans.every(plan => plan.allocations.reduce((sum, item) => sum + item.totalCents, 0) === plan.totalCents));
  assert.ok(result.plans.every(plan => plan.discountCents === 201));
  console.log('PASS mediate HTTP envelope, real catalog IDs, discounted cent allocation');
  const plan = result.plans[0];
  const revised = await generateLivePlans({ party, revision: { memberId: 1, action: 'fries' }, excludePlan: plan }, undefined, fetcher);
  assert.ok(revised.plans.length > 0);
  assert.deepEqual(revised.plans[0].allocations.find(item => item.memberId === 2)?.items.map(item => [item.productId, item.quantity]), plan.allocations.find(item => item.memberId === 2)?.items.map(item => [item.productId, item.quantity]));
  console.log('PASS complete excludePlan accepted by route; other member food unchanged');
  const custom = structuredClone(party); custom.members[0].requirement = 'other'; custom.members[0].customRequirement = '不要洋葱';
  const manual = await generateLivePlans({ party: custom }, undefined, fetcher);
  assert.ok(manual.plans.length > 0 && manual.issues.some(issue => issue.blocking === false));
  assert.ok(manual.plans[0].allocations.find(item => item.memberId === 1)?.requiresManualReview);
  console.log('PASS manual review remains nonblocking through real HTTP serialization');
  const low = structuredClone(party); low.members[0].budget = 1;
  const noSolution = await generateLivePlans({ party: low }, undefined, fetcher);
  assert.equal(noSolution.plans.length, 0);
  assert.ok(noSolution.issues.some(issue => issue.kind === 'constraint'));
  console.log('PASS insufficient budget is no-solution, never a demo fallback');
  assert.ok(noSolution.suggestions?.length);
  const recovered = prepareRecovery(noSolution, low, noSolution.suggestions![0]);
  assert.ok(recovered.result.plans.length);
  assert.deepEqual(recovered.party.members[1], low.members[1]);
  assert.ok(recovered.result.plans[0].allocations.every(member => member.totalCents <= recovered.party.members.find(person => person.id === member.memberId)!.budget! * 100));
  console.log('PASS verified recovery survives HTTP serialization and applies without another model call');
  const comboParty = structuredClone(party);
  comboParty.members = comboParty.members.map(member => ({ ...member, hunger: 'faint', requirement: 'fries' }));
  const comboResult = await generateLivePlans({ party: comboParty }, undefined, fetcher);
  assert.ok(comboResult.plans.some(plan => plan.allocations.some(allocation => allocation.items.some(item => comboResult.products!.find(product => product.id === item.productId)!.isCombo))));
  console.log('PASS default combo content is retained through HTTP route and browser client');
  const hungrier = structuredClone(party); hungrier.members[0].hunger = 'hungry';
  const larger = await generateLivePlans({ party: hungrier, revision: { memberId: 1, action: 'hungrier' }, excludePlan: plan }, undefined, fetcher);
  assert.ok(larger.plans.length === 1);
  assert.deepEqual(larger.plans[0].allocations[1].items.map(item => [item.productId, item.quantity]), plan.allocations[1].items.map(item => [item.productId, item.quantity]));
  assert.ok(larger.hints?.some(hint => hint.message.includes('重新搭配') && hint.message.includes('个人实付')));
  console.log('PASS hungrier revision returns a genuinely changed, priced basket and an explicit change summary');
  // A deterministic discount in the offline gateway makes sharing the best
  // option; this never modifies the saved real-price menu fixture.
  const sharedProduct = menu.items.find(item => item.id === '9900011056')!;
  assert.ok(sharedProduct.combo?.verified);
  sharedProduct.priceFen = 1000; sharedProduct.price = 10;
  const sharingParty = structuredClone(party); sharingParty.members.forEach(member => { member.hunger = 'hungry'; member.likes = ['burger', 'fries', 'drink']; });
  const sharedResult = await generateLivePlans({ party: sharingParty }, undefined, fetcher);
  const sharedPlan = sharedResult.plans.find(plan => plan.sharedMeals?.length)!;
  assert.ok(sharedPlan);
  assert.equal(sharedPlan.basket!.find(item => item.productId === sharedProduct.id)!.quantity, 1);
  assert.ok(sharedPlan.allocations.every(member => member.sharedItems!.length > 0));
  console.log('PASS shared meal travels through HTTP with one purchase and complete per-member ownership');
  const shareRevision = await generateLivePlans({ party: sharingParty, revision: { memberId: 1, action: 'hungrier' }, excludePlan: sharedPlan }, undefined, fetcher);
  assert.ok(shareRevision.plans.length === 1);
  assert.deepEqual(shareRevision.plans[0].sharedMeals!.map(meal => meal.components), sharedPlan.sharedMeals!.map(meal => meal.components));
  assert.deepEqual(shareRevision.plans[0].allocations[1].sharedItems, sharedPlan.allocations[1].sharedItems);
  console.log('PASS shared-plan revision accepts empty private baskets and locks shared recipe/ownership');
  const invalidShared = liveRequestBody({ party: sharingParty, revision: { memberId: 1, action: 'hungrier' }, excludePlan: sharedPlan });
  invalidShared.excludePlan!.allocations[0].sharedItems!.pop();
  const badSharedResponse = await fetch(`${base}/api/mediate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(invalidShared) });
  assert.equal(badSharedResponse.status, 400);
  console.log('PASS malformed shared ownership is rejected by the API route with HTTP 400');
} finally {
  Object.assign(mcd, original);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
