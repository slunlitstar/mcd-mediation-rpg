import type { UnifiedMenuItem } from './normalize.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Resolve only defaults actually marked by MCP. Missing/ambiguous defaults are not guessed. */
export function defaultCombo(data: unknown): UnifiedMenuItem['combo'] {
  if (!record(data) || !Array.isArray(data.rounds) || data.rounds.length === 0) return undefined;
  const components: NonNullable<UnifiedMenuItem['combo']>['components'] = [];
  const roundList: NonNullable<UnifiedMenuItem['combo']>['roundList'] = [];
  for (const raw of data.rounds) {
    if (!record(raw) || !Array.isArray(raw.choices) || !['string', 'number'].includes(typeof raw.id)) return undefined;
    const defaults = raw.choices.filter(record).filter(choice => choice.isDefault === 1 || choice.isDefault === true);
    const required = typeof raw.quantity === 'number' && raw.quantity > 0 ? raw.quantity : typeof raw.minQuantity === 'number' ? raw.minQuantity : 0;
    if (!defaults.length && required === 0) continue;
    if (!defaults.length) return undefined;
    const selected: { code: string; quantity: number }[] = [];
    for (const choice of defaults) {
      if (typeof choice.code !== 'string' || !choice.code || typeof choice.name !== 'string') return undefined;
      const quantity = choice.quantity ?? 1;
      if (!Number.isSafeInteger(quantity) || Number(quantity) < 1) return undefined;
      selected.push({ code: choice.code, quantity: Number(quantity) });
      components.push({ id: choice.code, name: choice.name, quantity: Number(quantity) });
    }
    const count = selected.reduce((sum, item) => sum + item.quantity, 0);
    if (required > 0 && count !== required || typeof raw.maxQuantity === 'number' && raw.maxQuantity >= 0 && count > raw.maxQuantity) return undefined;
    roundList.push({ round: String(raw.id), comboItemList: selected });
  }
  return components.length && roundList.length ? { verified: true, components, roundList } : undefined;
}
