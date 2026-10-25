import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultCombo } from './default-combo.js';

test('real detail fixture resolves explicit default rounds and quantities', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../fixtures/raw/meal-detail.json', import.meta.url), 'utf8'));
  const recipe = defaultCombo(fixture.details['9900005460']);
  assert.deepEqual(recipe?.components.map(item => item.name), ['麦香鱼', '中薯条', '可乐中杯']);
  assert.equal(recipe?.roundList.length, 3);
  assert.ok(recipe?.roundList.every(round => round.round && round.comboItemList.every(item => item.quantity === 1)));
});

test('missing or conflicting defaults are unavailable, never guessed', () => {
  const round = { id: 1, quantity: 1, maxQuantity: 1, choices: [{ code: 'a', name: '汉堡', quantity: 1, isDefault: 0 }] };
  assert.equal(defaultCombo({ rounds: [round] }), undefined);
  assert.equal(defaultCombo({ rounds: [{ ...round, choices: [{ ...round.choices[0], isDefault: 1, quantity: 2 }] }] }), undefined);
  assert.equal(defaultCombo({ rounds: [] }), undefined);
});
