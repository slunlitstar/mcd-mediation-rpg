import type { Member, Party, Store } from '../types/demo';

export const DRAFT_KEY = 'mcd-mediation:party-draft:v1';
const MAX_AGE = 24 * 60 * 60 * 1000;
export interface PartyDraft { version: 1; savedAt: number; mode: 'live' | 'demo'; party: Party; store: Store | null; activeMember: number }
const choices = ['burger', 'fries', 'snack', 'drink', 'dessert'];
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseDraft(text: string | null, now = Date.now()): PartyDraft | null {
  if (!text || text.length > 30000) return null;
  try {
    const draft: unknown = JSON.parse(text);
    if (!isRecord(draft) || draft.version !== 1 || typeof draft.savedAt !== 'number' || now - draft.savedAt > MAX_AGE || draft.savedAt > now + 60000 || !['live', 'demo'].includes(String(draft.mode)) || !isRecord(draft.party)) return null;
    const party = draft.party;
    if (typeof party.storeId !== 'string' || !Array.isArray(party.members) || party.members.length < 2 || party.members.length > 4) return null;
    for (const [index, member] of party.members.entries()) {
      if (!isRecord(member) || member.id !== index + 1 || ![null, 'saver', 'hungry', 'fries', 'cheese'].includes(member.roleId as string) || !['little', 'hungry', 'faint'].includes(String(member.hunger)) || !['none', 'burger', 'fries', 'drink', 'no-spicy', 'no-beef', 'other'].includes(String(member.requirement))) return null;
      if (member.budget !== null && (!Number.isInteger(member.budget) || Number(member.budget) < 1 || Number(member.budget) > 200)) return null;
      if (!Array.isArray(member.likes) || !Array.isArray(member.dislikes) || [...member.likes, ...member.dislikes].some(value => !choices.includes(String(value))) || typeof member.customRequirement !== 'string' || member.customRequirement.length > 120 || typeof member.configured !== 'boolean') return null;
    }
    const store = isRecord(draft.store) && draft.store.id === party.storeId && typeof draft.store.name === 'string'
      ? { id: party.storeId, name: draft.store.name, address: typeof draft.store.address === 'string' ? draft.store.address : undefined } : null;
    return { version: 1, savedAt: draft.savedAt, mode: draft.mode as PartyDraft['mode'], party: { storeId: party.storeId, members: party.members as Member[] }, store, activeMember: Math.max(0, Math.min(party.members.length - 1, Number.isInteger(draft.activeMember) ? Number(draft.activeMember) : 0)) };
  } catch { return null; }
}

export function loadDraft(): PartyDraft | null {
  try { return typeof window === 'undefined' ? null : parseDraft(window.localStorage.getItem(DRAFT_KEY)); } catch { return null; }
}

/** Only input settings are persisted: no keys, live quotes, accepted state or pending requests. */
export function saveDraft(draft: Omit<PartyDraft, 'version' | 'savedAt'>): PartyDraft | null {
  const value: PartyDraft = { version: 1, savedAt: Date.now(), ...draft, party: { ...draft.party, members: draft.party.members.map(member => Number.isInteger(member.budget) && Number(member.budget) >= 1 && Number(member.budget) <= 200 ? member : { ...member, budget: null, configured: false }) } };
  try {
    if (!parseDraft(JSON.stringify(value))) return null;
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(value)); return value;
  } catch { return null; }
}
