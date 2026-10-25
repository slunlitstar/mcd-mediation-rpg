import assert from 'node:assert/strict';
import test from 'node:test';
import { getBudgetUsage } from './budget-usage';

test('budget visualization reconciles yuan, cents, proportion and remainder', () => {
  assert.deepEqual(getBudgetUsage(2200, 25), { spentCents: 2200, budgetCents: 2500, remainingCents: 300, percent: 88, overBudget: false });
  assert.equal(getBudgetUsage(1000, 12.5)?.percent, 80);
});
test('full and exceeded budgets remain distinguishable without drawing beyond the track', () => {
  assert.equal(getBudgetUsage(2500, 25)?.remainingCents, 0);
  const over = getBudgetUsage(2800, 25)!;
  assert.equal(over.percent, 100);
  assert.equal(over.overBudget, true);
  assert.equal(over.remainingCents, -300);
});
test('missing or invalid money never produces a false budget confirmation or NaN width', () => {
  for (const budget of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.001]) assert.equal(getBudgetUsage(2200, budget), null);
  for (const spent of [-1, Number.NaN, Number.POSITIVE_INFINITY, 22.5]) assert.equal(getBudgetUsage(spent, 25), null);
  assert.equal(getBudgetUsage(0, 25)?.percent, 0);
});
