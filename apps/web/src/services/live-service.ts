import { validateSharedPlan, sharedSignature } from './shared-meals';
import type { MediationRequest, MediationResult, Party, Plan, Product, RecoverySuggestion, Store, Strategy } from '../types/demo';

type Fetcher = typeof fetch;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const categories = ['burger', 'fries', 'snack', 'drink', 'dessert'];
const strategies = ['peace', 'saving', 'happy'];

export class ApiError extends Error {
  constructor(message: string, readonly kind = 'unavailable') { super(message); this.name = 'ApiError'; }
}

async function request(path: string, init: RequestInit, signal?: AbortSignal, fetcher: Fetcher = fetch, timeoutMs = 90000): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetcher(`/api${path}`, { ...init, signal: controller.signal });
    let envelope: unknown;
    try { envelope = await response.json(); }
    catch { throw new ApiError('服务未返回有效数据，请确认后端已启动后重试。'); }
    if (!record(envelope)) throw new ApiError('服务返回格式有误，请重试。');
    if (!response.ok || envelope.ok !== true) {
      const error = record(envelope.error) ? envelope.error : {};
      const kind = typeof error.kind === 'string' ? error.kind : 'unavailable';
      const message = kind === 'mcp_auth_failed' || typeof error.message === 'string' && /MCD_MCP_(TOKEN|URL).*未配置/.test(error.message) ? '门店服务尚未配置好，请联系维护者检查服务端配置。'
        : kind === 'bad_request' && typeof error.message === 'string' ? error.message
        : '门店服务暂时不可用，请稍后重试。';
      throw new ApiError(message, kind);
    }
    return envelope.data;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? '这次核对用时较长，请保留设置后重试。' : '暂时连接不上服务，请确认后端已启动并检查网络。');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function loadStores(city: string, keyword: string, signal?: AbortSignal, fetcher?: Fetcher): Promise<Store[]> {
  const data = await request(`/stores?${new URLSearchParams({ city: city.trim(), keyword: keyword.trim() || '麦当劳' })}`, {}, signal, fetcher, 20000);
  if (!Array.isArray(data) || data.some(item => !record(item) || typeof item.id !== 'string' || typeof item.name !== 'string')) throw new ApiError('门店数据格式有误，请重试。');
  return data as Store[];
}

export function liveRequestBody(request: MediationRequest) {
  const previous = request.excludePlan;
  if (request.revision && (!previous?.planId || previous.payableCents === undefined || previous.productSubtotalCents === undefined || previous.discountCents === undefined)) {
    throw new ApiError('上一份方案信息不完整，请重新生成后再复议。', 'bad_request');
  }
  return {
    storeId: request.party.storeId,
    // Hidden custom text is saved on the card but only applies while "other" is active.
    members: request.party.members.map(member => ({ ...member, customRequirement: member.requirement === 'other' ? member.customRequirement : '' })),
    orderType: 1, beType: 1,
    options: { maxPlans: 3, includeProducts: true },
    ...(request.revision ? { revision: request.revision, excludePlan: {
      planId: previous!.planId, strategy: previous!.strategy, allocations: previous!.allocations,
      sharedMeals: previous!.sharedMeals,
      productSubtotalCents: previous!.productSubtotalCents, discountCents: previous!.discountCents, payableCents: previous!.payableCents,
    } } : {}),
  };
}

/** Reject broken catalogs and money at the boundary; never invent a replacement product or total. */
export function parseLiveResult(data: unknown, party: Party): MediationResult {
  const invalid = () => { throw new ApiError('方案数据未通过核对，请重新生成。'); };
  if (!record(data) || data.source !== 'live' || !Array.isArray(data.plans) || !Array.isArray(data.issues)) return invalid();
  const rawProducts = data.products ?? [];
  if (!Array.isArray(rawProducts)) return invalid();
  const products: Product[] = [];
  const catalog = new Set<string>();
  for (const raw of rawProducts) {
    if (!record(raw) || typeof raw.id !== 'string' || catalog.has(raw.id) || typeof raw.name !== 'string' || !cents(raw.priceCents) || !categories.includes(String(raw.category))) return invalid();
    catalog.add(raw.id);
    if (raw.components !== undefined && (!Array.isArray(raw.components) || raw.components.some(item => !record(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || !Number.isSafeInteger(item.quantity) || Number(item.quantity) < 1 || !categories.includes(String(item.category))))) return invalid();
    products.push({ ...raw, fullness: null, emoji: '' } as Product);
  }
  const seenStrategies = new Set<string>();
  for (const raw of data.plans) {
    if (!record(raw) || !strategies.includes(String(raw.strategy)) || seenStrategies.has(String(raw.strategy)) || typeof raw.planId !== 'string' || !Array.isArray(raw.allocations) || !cents(raw.payableCents) || !cents(raw.totalCents) || !cents(raw.productSubtotalCents) || !cents(raw.discountCents) || !Array.isArray(raw.explanations) || raw.explanations.some(text => typeof text !== 'string')) return invalid();
    seenStrategies.add(String(raw.strategy));
    if (!record(data.meta) || data.meta.pricingVerified !== true || raw.totalCents !== raw.payableCents || raw.productSubtotalCents - raw.discountCents !== raw.payableCents) return invalid();
    const memberIds = new Set<number>();
    let total = 0;
    for (const allocation of raw.allocations) {
      if (!record(allocation) || typeof allocation.memberId !== 'number' || memberIds.has(allocation.memberId) || !cents(allocation.totalCents) || !Array.isArray(allocation.items) || allocation.items.length === 0 && (!Array.isArray(allocation.sharedItems) || allocation.sharedItems.length === 0)) return invalid();
      const member = party.members.find(person => person.id === allocation.memberId);
      if (!member || member.budget === null || allocation.totalCents > member.budget * 100) return invalid();
      memberIds.add(allocation.memberId);
      total += allocation.totalCents;
      for (const item of allocation.items) {
        if (!record(item) || typeof item.productId !== 'string' || !catalog.has(item.productId) || !Number.isSafeInteger(item.quantity) || Number(item.quantity) < 1 || !cents(item.unitPriceCents) || !cents(item.subtotalCents)) return invalid();
      }
    }
    if (memberIds.size !== party.members.length || total !== raw.payableCents) return invalid();
    try { validateSharedPlan(raw as unknown as Plan, products, party); } catch (error) { throw new ApiError(error instanceof Error ? error.message : '共享套餐分配有误，请重试。'); }
  }
  const issues = data.issues.filter(record).filter(issue => typeof issue.message === 'string');
  const hints = Array.isArray(data.hints) ? data.hints.filter(record).filter(hint => typeof hint.message === 'string') : [];
  const result = { ...data, products, issues, hints, plans: data.plans as Plan[], suggestions: [] } as unknown as MediationResult;
  if (Array.isArray(data.suggestions) && !result.plans.length) for (const raw of data.suggestions.slice(0, 2)) {
    try {
      if (!record(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.summary !== 'string' || typeof raw.verifiedAt !== 'string' || !Number.isFinite(Date.parse(raw.verifiedAt))) continue;
      const suggestion = raw as unknown as RecoverySuggestion;
      prepareRecovery(result, party, suggestion);
      result.suggestions!.push(suggestion);
    } catch { /* A malformed suggestion must not hide the original no-solution state. */ }
  }
  return result;
}

/** Validate both explicit input changes and the priced preview before using it. */
export function prepareRecovery(current: MediationResult, party: Party, suggestion: RecoverySuggestion): { party: Party; result: MediationResult } {
  const invalid = () => { throw new ApiError('这条调整建议已失效，请重新生成。'); };
  if (current.source !== 'live' || !Array.isArray(suggestion.changes) || !suggestion.changes.length || !Number.isFinite(Date.parse(suggestion.verifiedAt)) || Date.now() - Date.parse(suggestion.verifiedAt) > 5 * 60 * 1000 || Date.parse(suggestion.verifiedAt) > Date.now() + 60000) return invalid();
  const members = party.members.map(member => ({ ...member }));
  const changedIds = new Set<number>();
  for (const change of suggestion.changes) {
    if (!record(change) || changedIds.has(change.memberId)) return invalid();
    changedIds.add(change.memberId);
    const member = members.find(member => member.id === change.memberId);
    if (!member || Object.keys(change).some(key => !['memberId', 'budget', 'requirement', 'dislikes'].includes(key))) return invalid();
    if (change.budget !== undefined) {
      if (!Number.isInteger(change.budget) || change.budget < Math.max(1, member.budget ?? 0) || change.budget > 200) return invalid();
      member.budget = change.budget;
    }
    if (change.requirement !== undefined) {
      if (change.requirement !== 'none' || !['burger', 'fries', 'drink'].includes(member.requirement)) return invalid();
      member.requirement = 'none';
    }
    if (change.dislikes !== undefined) {
      if (!Array.isArray(change.dislikes) || change.dislikes.length !== member.dislikes.length - 1 || change.dislikes.some(category => !member.dislikes.includes(category))) return invalid();
      member.dislikes = change.dislikes;
    }
  }
  const nextParty = { ...party, members };
  const result = parseLiveResult({ source: 'live', store: current.store, products: current.products, plans: [suggestion.plan], issues: [], hints: [{ level: 'info', message: '已采用你确认的条件调整，按一份主餐起步；价格以实际点餐时为准。' }], meta: { planner: 'rule-based-v2', pricingVerified: true, reasoning: 'rules', degraded: false } }, nextParty);
  return { party: nextParty, result };
}

export async function generateLivePlans(input: MediationRequest, signal?: AbortSignal, fetcher?: Fetcher): Promise<MediationResult> {
  const data = await request('/mediate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(liveRequestBody(input)) }, signal, fetcher);
  const result = parseLiveResult(data, input.party);
  if (input.revision && input.excludePlan) {
    const signature = (items: Plan['allocations'][number]['items']) => items.map(item => `${item.productId}:${item.quantity}`).sort().join('|');
    const previous = input.excludePlan;
    for (const plan of result.plans) {
      const sharedInventory = (plan: Plan) => JSON.stringify((plan.sharedMeals ?? []).map(meal => [meal.sharedMealId, meal.productId, meal.components.map(component => [component.componentId, component.id, component.memberIds]) ]));
      if (sharedInventory(plan) !== sharedInventory(previous)) throw new ApiError('复议改变了共享套餐分配，未采用本次结果，原方案已保留。');
      for (const allocation of plan.allocations) {
        const old = previous.allocations.find(item => item.memberId === allocation.memberId)!;
        if (allocation.memberId !== input.revision.memberId && (signature(allocation.items) !== signature(old.items) || sharedSignature(allocation) !== sharedSignature(old))) throw new ApiError('复议改变了其他成员的餐品，未采用本次结果，原方案已保留。');
        if (allocation.memberId === input.revision.memberId && ((signature(allocation.items) === signature(old.items) && sharedSignature(allocation) === sharedSignature(old)) || input.revision.action === 'cheaper' && allocation.totalCents >= old.totalCents)) throw new ApiError('当前菜单未找到符合本次复议的新搭配，原方案已保留。', 'constraint');
      }
    }
  }
  return result;
}

export function preferredStrategy(plans: Plan[], preferred: Strategy = 'peace'): Strategy {
  return plans.find(plan => plan.strategy === preferred)?.strategy ?? plans[0]?.strategy ?? preferred;
}

export function resultSourceLabel(result: MediationResult | null, live = true, strategy?: Strategy): string {
  if (!live || result?.source === 'demo') return '示例菜单 · 离线演示';
  if (!result) return '真实门店 · 正在核对';
  if (result.plans.length === 0) return '真实门店模式 · 本次未生成方案';
  const attempt = strategy ? result.meta?.llmDetail?.find(item => item.strategy === strategy) : undefined;
  if (attempt?.status === 'accepted') return '真实菜单与试算 · 模型参与推荐';
  if (attempt || result.meta?.reasoning === 'rules' || result.meta?.reasoning === 'rules-fallback') return '真实菜单与试算 · 规则推荐';
  return !strategy && result.meta?.reasoning === 'llm' ? '真实菜单与试算 · 模型参与推荐' : '真实菜单与试算';
}
