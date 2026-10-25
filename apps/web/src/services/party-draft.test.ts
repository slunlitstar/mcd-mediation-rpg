import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleParty } from './demo-data';
import { DRAFT_KEY, loadDraft, parseDraft, saveDraft } from './party-draft';

const now = 1000000000;
const draft = () => ({ version: 1, savedAt: now, mode: 'demo', party: exampleParty(), store: { id: 'demo-campus', name: '示例门店' }, activeMember: 1 });
test('draft restores settings and custom text without an accepted result or pending request', () => {
  const saved = draft(); saved.party.members[0].customRequirement = '不要洋葱';
  const restored = parseDraft(JSON.stringify(saved), now);
  assert.deepEqual(restored?.party, saved.party); assert.equal(restored?.activeMember, 1);
  assert.equal('result' in restored!, false); assert.equal('accepted' in restored!, false);
});
test('invalid, expired or incompatible local storage is ignored', () => {
  assert.equal(parseDraft('{broken', now), null);
  assert.equal(parseDraft(JSON.stringify(draft()), now + 25 * 60 * 60 * 1000), null);
  const invalid = draft(); invalid.party.members[0].budget = 999;
  assert.equal(parseDraft(JSON.stringify(invalid), now), null);
  assert.equal(parseDraft(JSON.stringify({ ...draft(), version: 2 }), now), null);
});

test('storage round trip keeps a partially entered party and handles blocked browser storage', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } } });
    const party = exampleParty(); party.members[0].budget = 201;
    const saved = saveDraft({ mode: 'demo', party, store: null, activeMember: 2 });
    assert.ok(saved);
    assert.equal(saved.party.members[0].budget, null, 'incomplete input is saved as unfinished, never clamped to a false valid budget');
    assert.equal(party.members[0].budget, 201, 'saving does not alter the form');
    assert.equal(loadDraft()?.activeMember, 2);
    assert.ok(storage.has(DRAFT_KEY));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw new Error('denied'); } } });
    assert.equal(loadDraft(), null);
    assert.equal(saveDraft({ mode: 'demo', party, store: null, activeMember: 0 }), null);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior); else Reflect.deleteProperty(globalThis, 'window');
  }
});
