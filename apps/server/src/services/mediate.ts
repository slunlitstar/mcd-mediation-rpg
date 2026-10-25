/**
 * `/api/mediate` 的实现：给现有前端 Demo 形状用的适配层，`rule-based-v2`。
 *
 * 契约见 `docs/mediate-contract.md`，实现不得自行放宽。几条硬规则在这里落地：
 *
 * - **人数 2–4，预算 1–200 元整数**；`budget: null` = 未填写，**不是不限预算**，
 *   遇到就只回 `input` 非阻塞提示，不产出方案；
 * - **`dislikes` 是硬排除**（与 `requirement` 同级），`likes` 只影响排序；
 * - **人工核对永不带 `blocking: true`**，只走 `requiresManualReview` + `hints`；
 * - **食材推导带来源与不确定性**：`dietary.{spicy,beef}` 有 `inferred/source/confidence`，
 *   「名字里没有『辣』」不等于官方确认不含；
 * - **金额一律整数分**，且 `Σ allocations.totalCents === payableCents`，每人 ≤ 预算；
 * - **复议只动指定成员**，其他人餐品保持不变，整单重算，**不挪用别人预算**。
 */

import { createProposalProvider, validateProposal } from './ai.js';
import type { ProposalCandidate, ProposalProvider, ValidatableProduct } from './ai.js';
import { mcd } from './mcd.js';
import { sharedDrafts, sharedWeights, restoreSharedDrafts } from './shared-meals.js';
import type { SharedDraft, SharedMeal, SharedReference } from './shared-meals.js';
import type { PriceItem } from './mcd.js';
import { allocateCents } from './plan.js';
import { fenToYuan } from '../mcp/normalize.js';
import type { UnifiedMenu, UnifiedMenuItem, UnifiedPricing } from '../mcp/normalize.js';

// ---------------------------------------------------------------- 枚举

export type Category = 'burger' | 'fries' | 'snack' | 'drink' | 'dessert';
export type Hunger = 'little' | 'hungry' | 'faint';
export type Requirement = 'none' | 'burger' | 'fries' | 'drink' | 'no-spicy' | 'no-beef' | 'other';
export type Strategy = 'peace' | 'saving' | 'happy';
export type RevisionAction = 'cheaper' | 'hungrier' | 'fries' | 'burger' | 'drink';

const CATEGORIES: Category[] = ['burger', 'fries', 'snack', 'drink', 'dessert'];
const STRATEGIES: Strategy[] = ['saving', 'peace', 'happy'];

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as string[]).includes(value);
}

export function isStrategy(value: unknown): value is Strategy {
  return typeof value === 'string' && (STRATEGIES as string[]).includes(value);
}

// ---------------------------------------------------------------- 入参

export interface MemberInput {
  id: number;
  roleId?: string | null;
  /** 元；`null` 表示未填写。服务端按契约不做「不限预算」解释。 */
  budget: number | null;
  hunger?: Hunger;
  likes?: Category[];
  /** 硬性排除。 */
  dislikes?: Category[];
  requirement?: Requirement;
  customRequirement?: string;
  configured?: boolean;
}

export interface ExcludedPlan {
  sharedMeals?: SharedMeal[];
  planId: string;
  strategy: Strategy;
  allocations: Array<{
    memberId: number;
    items: Array<{ productId: string; quantity: number }>;
    sharedItems?: SharedReference[];
    totalCents: number;
  }>;
  productSubtotalCents: number;
  discountCents: number;
  payableCents: number;
}

export interface MediateRequest {
  storeId: string;
  orderType?: number;
  beType?: number;
  members: MemberInput[];
  revision?: { memberId: number; action: RevisionAction };
  excludePlan?: ExcludedPlan;
  options?: { maxPlans?: number; includeProducts?: boolean };
}

// ---------------------------------------------------------------- 出参

export interface DietaryField {
  inferred: boolean;
  source: 'name' | 'tag' | 'official' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
}

export interface MediateProduct {
  id: string;
  name: string;
  category: Category;
  priceCents: number;
  image: string | null;
  isCombo?: boolean;
  hasMain?: boolean;
  includedCategories?: Category[];
  components?: { id: string; name: string; quantity: number; category: Category; hasMain: boolean; referencePriceCents: number | null; dietary: { spicy: DietaryField; beef: DietaryField } }[];
  /** 真实数据恒为 null —— MCP 不提供饱腹数据。 */
  fullness: null;
  fullnessSource: 'unknown';
  dietary: {
    spicy: DietaryField;
    beef: DietaryField;
    note: string;
  };
}

export interface MediateAllocationItem {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
}

export interface MediateAllocation {
  sharedItems?: SharedReference[];
  memberId: number;
  items: MediateAllocationItem[];
  subtotalCents: number;
  totalCents: number;
  budgetCents: number;
  budgetOverCents: number;
  matchedLikes: Category[];
  missingLikes: Category[];
  reason: string;
  requiresManualReview: boolean;
}

export interface MediatePlan {
  basket?: { productId: string; quantity: number }[];
  sharedMeals?: SharedMeal[];
  planId: string;
  strategy: Strategy;
  allocations: MediateAllocation[];
  productSubtotalCents: number;
  discountCents: number;
  payableCents: number;
  totalCents: number;
  explanations: string[];
  allocationAudit: {
    method: 'proportional-largest-remainder';
    payableCents: number;
    allocatedCentsSum: number;
    roundingAdjustmentCents: number;
    budgetCheck: 'passed';
  };
  tradeoffs: Array<{
    memberId: number;
    issue: string;
    chosen: string;
    reason: string;
    costDeltaCents: number;
  }>;
  requiresManualReview: boolean;
}

export interface MediateIssue {
  memberId?: number;
  code: string;
  kind: 'input' | 'constraint' | 'unavailable';
  blocking: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

export interface MediateHint {
  memberId?: number;
  level: 'info' | 'warn';
  message: string;
}

/**
 * 一份方案到底是谁出的。前端可以据此显示「AI 推荐」还是「规则兜底」，
 * 也必须能在模型被拒时如实说明——不能把规则结果冒充成 AI 结果。
 */
export type PlannerKind = 'rule-based-v2' | 'llm-validated-v1';

export interface LlmAttempt {
  strategy: Strategy;
  /** accepted = 模型方案通过校验且完成真实计价；rejected = 被拦下；skipped = 本轮不适用。 */
  status: 'accepted' | 'rejected' | 'skipped';
  model: string;
  code?: string;
  message?: string;
  latencyMs?: number;
}

export interface RecoverySuggestion {
  id: string;
  title: string;
  summary: string;
  verifiedAt: string;
  changes: Array<{ memberId: number; budget?: number; requirement?: Requirement; dislikes?: Category[] }>;
  plan: MediatePlan;
}

export interface MediateResult {
  source: 'live';
  traceId: string;
  store: { id: string; name: string; businessStatus?: boolean };
  products?: MediateProduct[];
  plans: MediatePlan[];
  issues: MediateIssue[];
  hints: MediateHint[];
  suggestions?: RecoverySuggestion[];
  meta: {
    planner: PlannerKind;
    pricingVerified: boolean;
    menuCapturedAt: string;
    couponCount: number;
    degraded: boolean;
    reasoning: 'rules' | 'llm' | 'rules-fallback';
    strategiesReturned: Strategy[];
    strategiesDeduplicated: Strategy[];
    llm: string;
    /** 逐策略的模型调用记录，便于排查「为什么这次没用 AI」。可选，前端忽略也不影响。 */
    llmDetail?: LlmAttempt[];
  };
}

export interface MediateDependencies {
  menu: (query: { storeCode: string; orderType?: number; beType?: number }) => Promise<UnifiedMenu>;
  price: (
    storeCode: string,
    items: PriceItem[],
    orderType?: number,
    beType?: number,
  ) => Promise<UnifiedPricing>;
  couponCount: (storeCode: string, orderType: number, beType: number) => Promise<number>;
  /** 模型方案来源。`null` 表示未配置模型，直接走规则版。测试里必须显式注入。 */
  proposals?: ProposalProvider | null;
}

const defaultDependencies: MediateDependencies = {
  menu: (query) => mcd.menu(query),
  price: (storeCode, items, orderType, beType) => mcd.price(storeCode, items, orderType, beType),
  couponCount: async (storeCode, orderType, beType) => {
    try {
      const coupons = await mcd.call('query-store-coupons', { storeCode, orderType, beType });
      return coupons.ok && Array.isArray(coupons.data) ? coupons.data.length : 0;
    } catch {
      return 0;
    }
  },
  proposals: createProposalProvider(),
};

// ---------------------------------------------------------------- 商品分类与食材推导

const FRIES_RE = /薯条|薯饼/;
const DRINK_RE = /饮品|可乐|雪碧|红茶|咖啡|牛奶|果汁|苹果汁|矿泉水|茶|汁/;
const DESSERT_RE = /冰淇淋|麦旋风|圆筒|派|甜点|圣代|新地|奥利奥/;
const BURGER_RE = /堡|卷|巨无霸|麦香鱼|麦香鸡/;
const SNACK_RE = /炸鸡|鸡翅|鸡块|麦乐鸡|小食|拼盘|薯条|薯饼/;

/**
 * 中文分类 + 商品名 → 五类枚举。
 * 薯条优先判定（名称含「薯条/薯饼」直接 `fries`），其余按名称再按分类名。
 */
export function toCategory(item: UnifiedMenuItem): Category {
  if (FRIES_RE.test(item.name)) return 'fries';
  if (DRINK_RE.test(item.name)) return 'drink';
  if (DESSERT_RE.test(item.name)) return 'dessert';
  if (BURGER_RE.test(item.name)) return 'burger';
  if (SNACK_RE.test(item.name)) return 'snack';

  const categoryName = item.category;
  if (/饮品|咖啡/.test(categoryName)) return 'drink';
  if (/堡|卷|单人餐|牛鱼肉/.test(categoryName)) return 'burger';
  if (/炸鸡|小食|拼盘/.test(categoryName)) return 'snack';
  if (/甜|冰/.test(categoryName)) return 'dessert';

  return 'snack';
}

const SPICY_RE = /辣/;
const BEEF_NAME_RE = /牛肉|牛排|牛扒|牛堡|巨无霸|双层吉士|吉士汉堡包/;
const BEEF_TAG_RE = /牛肉|纯牛/;
/**
 * 不是餐品的东西不能占「主食/配餐」名额。实测踩到两次：
 * 一是「北美招牌牧场酱 ¥3」被选成配餐（只有调料没有食物），
 * 二是「旋旋星愿贴 ¥3.9」这种**周边贴纸**被选成配餐。
 * 它们仍保留在 `products` 里供前端展示，只是不参与组餐。
 */
const NON_MEAL_RE = /周边|贴纸|星愿贴|盲盒|玩具|玩偶|卡片|徽章|会员卡|麦金卡/;

function isNonMeal(candidate: Candidate): boolean {
  const haystack = `${candidate.product.name} ${candidate.item.tags.join(' ')}`;
  return NON_MEAL_RE.test(haystack) || /(?:酱|蘸料|调料|糖包|奶精)$/.test(candidate.product.name) || candidate.item.isCombo && !candidate.item.combo?.verified;
}

function included(candidate: Candidate): Category[] { return candidate.product.includedCategories ?? [candidate.product.category]; }
function isMain(candidate: Candidate): boolean { return candidate.product.hasMain ?? candidate.product.category === 'burger'; }

const DIETARY_NOTE =
  '由名称/标签推导，不代表官方成分确认；未出现关键词 ≠ 确认不含';

/**
 * 推导辣与牛肉属性。**必须保留来源与置信度**：
 * 命中标签/名称为 true，但「没命中」只能是 `inferred: false` + `low`，不能宣称官方确认不含。
 */
export function inferDietary(item: UnifiedMenuItem): { spicy: DietaryField; beef: DietaryField } {
  const tagSpicy = item.tags.some((tag) => SPICY_RE.test(tag));
  const nameSpicy = SPICY_RE.test(item.name);

  const spicy: DietaryField = tagSpicy
    ? { inferred: true, source: 'tag', confidence: 'high' }
    : nameSpicy
      ? { inferred: true, source: 'name', confidence: 'medium' }
      : { inferred: false, source: 'name', confidence: 'low' };

  const tagBeef = item.tags.some((tag) => BEEF_TAG_RE.test(tag));
  const nameBeef = BEEF_NAME_RE.test(item.name);

  const beef: DietaryField = tagBeef
    ? { inferred: true, source: 'tag', confidence: 'high' }
    : nameBeef
      ? { inferred: true, source: 'name', confidence: 'medium' }
      : { inferred: false, source: 'name', confidence: 'low' };

  return { spicy, beef };
}

function toProduct(item: UnifiedMenuItem, catalog: UnifiedMenuItem[] = []): MediateProduct {
  const dietary = inferDietary(item);
  const components = item.combo?.verified ? item.combo.components.map(component => {
    const known = catalog.find(entry => entry.id === component.id);
    const componentItem = known ?? { ...item, name: component.name, category: '', tags: [], isCombo: false, combo: undefined };
    const inferred = inferDietary(componentItem);
    if (inferred.spicy.inferred) dietary.spicy = inferred.spicy;
    if (inferred.beef.inferred) dietary.beef = inferred.beef;
    const category = toCategory(componentItem);
    return { ...component, category, hasMain: category === 'burger' || /饭|粥|松饼|整鸡|鸡腿|鸡排/.test(component.name), referencePriceCents: known?.priceFen && known.priceFen > 0 ? known.priceFen : null, dietary: inferred };
  }) : undefined;
  const category = toCategory(item);
  const hasMain = item.isCombo ? Boolean(components?.some(component => component.category === 'burger' || /饭|粥|松饼|整鸡|鸡腿|鸡排/.test(component.name))) : category === 'burger' || /饭|粥|松饼|整鸡|鸡腿|鸡排/.test(item.name);
  return {
    id: item.id,
    name: item.name,
    category,
    isCombo: item.isCombo,
    hasMain,
    includedCategories: components ? [...new Set(components.map(component => component.category))] : [category],
    components,
    priceCents: item.priceFen,
    image: item.image ?? null,
    fullness: null,
    fullnessSource: 'unknown',
    dietary: { ...dietary, note: DIETARY_NOTE },
  };
}

// ---------------------------------------------------------------- 硬约束

interface Candidate {
  item: UnifiedMenuItem;
  product: MediateProduct;
}

/** 对外暴露别名，供模型校验层与测试复用，避免结构漂移。 */
export type MediateCandidate = Candidate;

function violatesDislikes(candidate: Candidate, member: MemberInput): boolean {
  const dislikes = member.dislikes ?? [];
  return included(candidate).some(category => dislikes.includes(category));
}

function violatesRequirement(candidate: Candidate, member: MemberInput): boolean {
  const requirement = member.requirement ?? 'none';
  if (requirement === 'no-spicy' && candidate.product.dietary.spicy.inferred) return true;
  if (requirement === 'no-beef' && candidate.product.dietary.beef.inferred) return true;
  return false;
}

/** 硬约束过滤后的候选池；不涉及预算。 */
export function hardFilter(pool: Candidate[], member: MemberInput): Candidate[] {
  return pool.filter(
    (candidate) => !violatesDislikes(candidate, member) && !violatesRequirement(candidate, member),
  );
}

function requiredCategory(member: MemberInput): Category | undefined {
  const requirement = member.requirement ?? 'none';
  if (requirement === 'burger' || requirement === 'fries' || requirement === 'drink') return requirement;
  return undefined;
}

// ---------------------------------------------------------------- 选品

interface SlotPlan {
  main: boolean;
  side: boolean;
  drink: boolean;
}

/** 份量规则：饥饿程度只决定「要不要加餐」，不承诺吃饱。 */
function slotsFor(member: MemberInput): SlotPlan {
  const hunger = member.hunger ?? 'hungry';
  if (hunger === 'little') return { main: true, side: false, drink: false };
  if (hunger === 'faint') return { main: true, side: true, drink: true };
  return { main: true, side: true, drink: false };
}

function matchScore(candidate: Candidate, member: MemberInput): number {
  const likes = member.likes ?? [];
  return included(candidate).filter(category => likes.includes(category)).length;
}

/**
 * 三策略不设预算阈值，只在同一批硬约束可行解里换排序目标：
 * - saving：价格最低优先
 * - peace：偏好与价格折中，尽量不让任何成员吃亏
 * - happy：偏好命中优先
 */
function rankScore(candidate: Candidate, member: MemberInput, strategy: Strategy, budgetCents: number): number {
  const match = matchScore(candidate, member);
  const priceRatio = budgetCents > 0 ? candidate.product.priceCents / budgetCents : 1;
  const isRequired = requiredCategory(member);

  let score = 0;
  if (isRequired !== undefined && candidate.product.category === isRequired) score += 5;
  if (candidate.product.category === 'burger') score += 1;

  if (strategy === 'saving') score += match * 1 - priceRatio * 10;
  else if (strategy === 'peace') score += match * 3 - priceRatio * 5;
  else score += match * 6 - priceRatio * 1;

  return score;
}

function pickCandidate(
  pool: Candidate[],
  member: MemberInput,
  strategy: Strategy,
  budgetCents: number,
  accept: (candidate: Candidate) => boolean,
): Candidate | undefined {
  const ranked = pool
    .filter(accept)
    .map((candidate) => ({ candidate, score: rankScore(candidate, member, strategy, budgetCents) }))
    .sort((a, b) => b.score - a.score || a.candidate.product.priceCents - b.candidate.product.priceCents);

  return ranked[0]?.candidate;
}

interface MemberSelection {
  sharedItems?: Array<SharedReference & { candidate: Candidate; shareCount: number }>;
  sharedBudgetCents?: number;
  memberId: number;
  items: Array<{ candidate: Candidate; quantity: number }>;
  matchedLikes: Category[];
  missingLikes: Category[];
  requiresManualReview: boolean;
  reasons: string[];
}

function selectForMember(
  pool: Candidate[],
  member: MemberInput,
  strategy: Strategy,
  _requireMain: boolean,
): MemberSelection {
  const budgetCents = Math.round((member.budget ?? 0) * 100);
  // 硬约束之后再剔除蘸酱/周边等非餐品：它们仍在 products 里供前端展示，但不参与组餐。
  const hard = hardFilter(pool, member).filter((candidate) => !isNonMeal(candidate));
  const slots = slotsFor(member);
  const required = requiredCategory(member);

  // Search main and required food together; greedy selection can miss feasible pairs.
  const cores: Candidate[][] = [];
  for (const main of hard.filter(entry => isMain(entry) && entry.product.priceCents <= budgetCents)) {
    if (required === undefined || included(main).includes(required)) cores.push([main]);
    else for (const extra of hard) {
      if (extra !== main && included(extra).includes(required) && main.product.priceCents + extra.product.priceCents <= budgetCents) cores.push([main, extra]);
    }
  }
  let best: Candidate[] = [];
  let bestScore = -Infinity;
  for (const core of cores) {
    const basket = [...core];
    let spent = basket.reduce((sum, item) => sum + item.product.priceCents, 0);
    const covered = () => basket.flatMap(included);
    for (const wanted of [slots.side ? ['fries', 'snack', 'dessert'] : [], slots.drink ? ['drink'] : []]) {
      if (!wanted.length || covered().some(category => wanted.includes(category))) continue;
      const extra = pickCandidate(hard, member, strategy, budgetCents, entry =>
        !basket.includes(entry) && included(entry).some(category => wanted.includes(category)) && spent + entry.product.priceCents <= budgetCents);
      if (extra) { basket.push(extra); spent += extra.product.priceCents; }
    }
    const coverage = new Set(covered());
    const portions = Number(slots.side && ['fries', 'snack', 'dessert'].some(category => coverage.has(category as Category))) + Number(slots.drink && coverage.has('drink'));
    const matches = (member.likes ?? []).filter(category => coverage.has(category)).length;
    const ratio = spent / Math.max(1, budgetCents);
    const score = portions * 20 + matches * (strategy === 'happy' ? 6 : strategy === 'peace' ? 3 : 1) - ratio * (strategy === 'saving' ? 10 : strategy === 'peace' ? 5 : 1);
    if (score > bestScore) { bestScore = score; best = basket; }
  }
  // Retain an affordable main solely for an accurate missing-required-food error;
  // buildPlan rejects this incomplete selection before calling the price tool.
  if (!best.length) {
    const main = pickCandidate(hard, member, 'saving', budgetCents, entry => isMain(entry) && entry.product.priceCents <= budgetCents);
    if (main) best = [main];
  }
  const selected = best.map(candidate => ({ candidate, quantity: 1 }));
  const reasons = best.map(candidate => `${candidate.item.isCombo ? '默认套餐' : '餐品'}「${candidate.product.name}」¥${String(fenToYuan(candidate.product.priceCents))}`);

  const liked = member.likes ?? [];
  const matchedLikes = liked.filter((category) =>
    selected.some((entry) => included(entry.candidate).includes(category)),
  );
  const missingLikes = liked.filter((category) => !matchedLikes.includes(category));

  return {
    memberId: member.id,
    items: selected,
    matchedLikes,
    missingLikes,
    requiresManualReview: (member.customRequirement ?? '').trim() !== '',
    reasons,
  };
}

function selectionCandidates(selection: MemberSelection): Candidate[] {
  return [...selection.items.map(entry => entry.candidate), ...(selection.sharedItems ?? []).map(entry => entry.candidate)];
}

function attachSharedSelections(pool: Candidate[], members: MemberInput[], shared: SharedDraft[], privateSelections?: Map<number, MemberSelection>): MemberSelection[] {
  return members.map(member => {
    const groups = shared.filter(meal => meal.memberIds.includes(member.id));
    if (!groups.length) return privateSelections?.get(member.id) ?? selectForMember(pool, member, 'saving', true);
    const sharedItems: NonNullable<MemberSelection['sharedItems']> = [];
    let sharedBudgetCents = 0;
    for (const meal of groups) {
      const parent = pool.find(candidate => candidate.product.id === meal.productId)!;
      sharedBudgetCents += allocateCents(sharedWeights(meal), parent.product.priceCents).allocatedFen.get(member.id) ?? 0;
      for (const component of meal.components.filter(component => component.memberIds.includes(member.id))) {
        const item: UnifiedMenuItem = { ...parent.item, id: component.id, name: component.name, category: component.category, tags: [], isCombo: false, combo: undefined, priceFen: component.referencePriceCents ?? 0, price: (component.referencePriceCents ?? 0) / 100 };
        const product: MediateProduct = { id: component.id, name: component.name, category: component.category, priceCents: item.priceFen, image: pool.find(candidate => candidate.product.id === component.id)?.product.image ?? null, hasMain: component.hasMain, includedCategories: [component.category], fullness: null, fullnessSource: 'unknown', dietary: { ...component.dietary, note: DIETARY_NOTE } };
        sharedItems.push({ sharedMealId: meal.sharedMealId, componentId: component.componentId, candidate: { item, product }, shareCount: component.memberIds.length });
      }
    }
    const selection: MemberSelection = { memberId: member.id, items: privateSelections?.get(member.id)?.items ?? [], sharedItems, sharedBudgetCents, matchedLikes: [], missingLikes: [], requiresManualReview: Boolean(member.customRequirement?.trim()), reasons: [] };
    if (!privateSelections) {
      const hard = hardFilter(pool, member).filter(candidate => !isNonMeal(candidate) && !candidate.item.isCombo);
      const slots = slotsFor(member); const required = requiredCategory(member);
      for (const wanted of [required ? [required] : [], slots.side ? ['fries', 'snack', 'dessert'] : [], slots.drink ? ['drink'] : []]) {
        if (!wanted.length || selectionCandidates(selection).some(candidate => included(candidate).some(category => wanted.includes(category)))) continue;
        const remaining = (member.budget ?? 0) * 100 - sharedBudgetCents - basketPrice(selection.items);
        const candidate = pickCandidate(hard, member, 'saving', (member.budget ?? 0) * 100, entry => entry.product.priceCents <= remaining && included(entry).some(category => wanted.includes(category)) && !selection.items.some(item => item.candidate === entry));
        if (candidate) selection.items.push({ candidate, quantity: 1 });
      }
    }
    selection.matchedLikes = (member.likes ?? []).filter(category => selectionCandidates(selection).some(candidate => included(candidate).includes(category)));
    selection.missingLikes = (member.likes ?? []).filter(category => !selection.matchedLikes.includes(category));
    selection.reasons = [...selection.items.map(entry => `${entry.candidate.product.name} ×${entry.quantity}`), ...groups.map(meal => `参与共享「${pool.find(candidate => candidate.product.id === meal.productId)!.product.name}」`)];
    return selection;
  });
}

/** One shared group, or two disjoint pairs for a four-person party. */
function sharedCombinations(drafts: SharedDraft[], pool: Candidate[], members: MemberInput[]): SharedDraft[][] {
  const options = drafts.map(draft => [draft]);
  if (members.length === 4) for (let a = 0; a < drafts.length; a++) for (let b = a + 1; b < drafts.length; b++) {
    if (drafts[a].memberIds.length === 2 && drafts[b].memberIds.length === 2 && !drafts[a].memberIds.some(id => drafts[b].memberIds.includes(id))) options.push([drafts[a], drafts[b]]);
  }
  const estimated = (groups: SharedDraft[]) => {
    const selections = attachSharedSelections(pool, members, groups);
    return selections.reduce((sum, selection) => sum + basketPrice(selection.items) + (selection.sharedBudgetCents ?? 0), 0);
  };
  return options.filter(groups => attachSharedSelections(pool, members, groups).every(selection => { const member = members.find(member => member.id === selection.memberId)!; const required = requiredCategory(member); return selectionCandidates(selection).some(isMain) && (required === undefined || selectionCandidates(selection).some(candidate => included(candidate).includes(required))); })).map(groups => ({ groups, cost: estimated(groups) })).sort((a, b) => a.cost - b.cost).slice(0, 18).map(entry => entry.groups);
}

function planPreference(plan: MediatePlan, members: MemberInput[], pool: Candidate[]): number {
  let appetite = 0; let likes = 0; let leastMatches = Infinity; let variety = 0;
  for (const allocation of plan.allocations) {
    const member = members.find(member => member.id === allocation.memberId)!;
    const categories = new Set(allocation.items.flatMap(item => included(pool.find(candidate => candidate.product.id === item.productId)!)));
    const foodIds = new Set(allocation.items.flatMap(item => {
      const product = pool.find(candidate => candidate.product.id === item.productId)!.product;
      return product.components?.filter(part => part.category !== 'drink').map(part => part.id) ?? (product.category !== 'drink' ? [product.id] : []);
    }));
    for (const ref of allocation.sharedItems ?? []) {
      const component = plan.sharedMeals?.find(meal => meal.sharedMealId === ref.sharedMealId)?.components.find(component => component.componentId === ref.componentId);
      if (component) { categories.add(component.category); if (component.category !== 'drink') foodIds.add(component.id); }
    }
    const slots = slotsFor(member);
    appetite += Number(slots.side && ['fries', 'snack', 'dessert'].some(category => categories.has(category as Category))) + Number(slots.drink && categories.has('drink'));
    const matches = (member.likes ?? []).filter(category => categories.has(category)).length;
    likes += matches; leastMatches = Math.min(leastMatches, matches);
    variety += foodIds.size;
  }
  const ratio = plan.totalCents / Math.max(1, members.reduce((sum, member) => sum + (member.budget ?? 0) * 100, 0));
  return appetite * 20 + likes * (plan.strategy === 'happy' ? 6 : 3) + (plan.strategy === 'peace' ? leastMatches * 3 : variety * .5) - ratio * (plan.strategy === 'happy' ? 1 : 5);
}

// ---------------------------------------------------------------- 模型方案（只提议，不决定金额）

/** 候选上限：96 个商品全给也就 2k 左右 token，超过这个数才截断，按价格升序保留。 */
const MAX_MODEL_CANDIDATES = 120;

function toValidatable(candidate: Candidate): ValidatableProduct {
  return {
    id: candidate.product.id,
    name: candidate.product.name,
    category: candidate.product.category,
    priceCents: candidate.product.priceCents,
    spicy: candidate.product.dietary.spicy.inferred,
    beef: candidate.product.dietary.beef.inferred,
    nonMeal: isNonMeal(candidate),
    hasMain: isMain(candidate),
    includedCategories: included(candidate),
    isCombo: candidate.item.isCombo,
  };
}

function modelCandidates(pool: Candidate[]): ProposalCandidate[] {
  return pool
    .filter((candidate) => !isNonMeal(candidate))
    .slice()
    .sort((a, b) => a.product.priceCents - b.product.priceCents)
    .slice(0, MAX_MODEL_CANDIDATES)
    .map((candidate) => ({
      id: candidate.product.id,
      name: candidate.product.name,
      category: candidate.product.category,
      priceCents: candidate.product.priceCents,
      hasMain: isMain(candidate),
      includedCategories: included(candidate),
      isCombo: candidate.item.isCombo,
    }));
}
/** 一次请求覆盖全部策略：通过校验的进 `selections`，被拦的进 `failures`。 */
interface ModelRun {
  selections: Map<Strategy, MemberSelection[]>;
  failures: Map<Strategy, { code: string; message: string }>;
  latencyMs?: number;
}

/**
 * 只发**一次**请求，让模型同时给出全部策略，然后逐份校验。
 *
 * 为什么不按策略各发一次：一是三次调用直接撞上免费额度的每分钟限流，
 * 二是三种策略本来就该在同一批硬约束下比较，分开问反而容易得到三套互相矛盾的假设。
 *
 * 这里不产出任何金额：即使模型返回了 `price` 字段也会被 `parseProposal` 丢掉，
 * 最终金额一律由调用方走 `calculate-price` 计算。
 */
async function planWithModel(
  provider: ProposalProvider,
  pool: Candidate[],
  members: MemberInput[],
  strategies: Strategy[],
  storeName: string,
): Promise<ModelRun> {
  const selections = new Map<Strategy, MemberSelection[]>();
  const failures = new Map<Strategy, { code: string; message: string }>();

  const failAll = (code: string, message: string): ModelRun => {
    for (const strategy of strategies) failures.set(strategy, { code, message });
    return { selections, failures };
  };

  if (strategies.length === 0) return { selections, failures };

  const candidates = modelCandidates(pool);
  if (candidates.length === 0) {
    return failAll('model_no_candidates', '该门店没有可交给模型的候选商品');
  }

  const memberViews = members.map((member) => ({
    id: member.id,
    budgetCents: Math.round((member.budget ?? 0) * 100),
    hunger: member.hunger ?? 'hungry',
    likes: [...(member.likes ?? [])],
    dislikes: [...(member.dislikes ?? [])],
    requirement: member.requirement ?? 'none',
    customRequirement: member.customRequirement ?? '',
  }));

  let result;
  try {
    result = await provider.propose({
      storeName,
      strategies,
      members: memberViews,
      candidates,
      lockedMemberIds: [],
    });
  } catch (error) {
    const code =
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'model_failed';
    const message = error instanceof Error ? error.message : '模型调用失败';
    return failAll(code, message);
  }

  const byId = new Map(pool.map((candidate) => [candidate.product.id, candidate]));
  const products = pool.map(toValidatable);
  const handled = new Set<Strategy>();

  for (const plan of result.proposal.plans) {
    const strategy = plan.strategy as Strategy;

    // 模型可能多给（未知策略）或重复给（同一策略两份）：前者忽略，后者取第一份。
    if (!isStrategy(strategy) || !strategies.includes(strategy)) continue;
    if (handled.has(strategy)) continue;
    handled.add(strategy);

    const validation = validateProposal(plan.allocations, memberViews, products);
    if (!validation.ok) {
      failures.set(strategy, {
        code: validation.violation.code,
        message: validation.violation.message,
      });
      continue;
    }

    const mapped: MemberSelection[] = [];
    let broken: { code: string; message: string } | undefined;

    for (const selection of validation.selections) {
      const items = selection.items.flatMap((item) => {
        const candidate = byId.get(item.product.id);
        return candidate === undefined ? [] : [{ candidate, quantity: item.quantity }];
      });

      if (items.length !== selection.items.length) {
        broken = { code: 'model_unknown_product', message: '模型给出的商品无法映射回菜单' };
        break;
      }

      mapped.push({
        memberId: selection.memberId,
        items,
        matchedLikes: selection.matchedLikes as Category[],
        missingLikes: selection.missingLikes as Category[],
        requiresManualReview: selection.requiresManualReview,
        reasons: [selection.reason],
      });
    }

    if (broken !== undefined) failures.set(strategy, broken);
    else selections.set(strategy, mapped);
  }

  for (const strategy of strategies) {
    if (!handled.has(strategy)) {
      failures.set(strategy, {
        code: 'model_missing_strategy',
        message: `模型没有给出 ${strategy} 策略的方案`,
      });
    }
  }

  return { selections, failures, latencyMs: result.latencyMs };
}

// ---------------------------------------------------------------- 结果组装

function strategyLabel(strategy: Strategy): string {
  if (strategy === 'saving') return '省钱优先';
  if (strategy === 'peace') return '和平优先';
  return '快乐优先';
}

function signatureOf(selection: MemberSelection[]): string {
  return selection
    .map((entry) => {
      const items = [...entry.items]
        .map((item) => `${item.candidate.product.id}x${String(item.quantity)}`)
        .sort()
        .join(',');
      return `${String(entry.memberId)}:${items}:${(entry.sharedItems ?? []).map(ref => `${ref.sharedMealId}/${ref.componentId}`).sort().join(',')}`;
    })
    .sort()
    .join('|');
}

interface BuiltPlan {
  plan: MediatePlan;
  signature: string;
}

async function buildPlan(
  storeId: string,
  strategy: Strategy,
  members: MemberInput[],
  selections: MemberSelection[],
  orderType: number,
  beType: number,
  deps: MediateDependencies,
  traceId: string,
  sequence: number,
  shared: Array<SharedDraft & { parent: UnifiedMenuItem }> = [],
): Promise<BuiltPlan | { error: MediateIssue }> {
  // A priced basket is not a feasible group meal if someone received no main,
  // or a required food was silently skipped while choosing affordable items.
  for (const selection of selections) {
    const member = members.find(entry => entry.id === selection.memberId);
    if (!member) continue;
    const required = requiredCategory(member);
    if (selectionCandidates(selection).some(candidate => violatesDislikes(candidate, member) || violatesRequirement(candidate, member))) return { error: { code: 'food_constraint_violated', kind: 'constraint', blocking: true, memberId: member.id, message: `成员${member.id}的分餐不符合食物限制。` } };
    const hasMain = selectionCandidates(selection).some(isMain);
    const meetsRequirement = required === undefined || selectionCandidates(selection).some(candidate => included(candidate).includes(required));
    if (!hasMain || !meetsRequirement) {
      return { error: {
        memberId: member.id,
        code: !hasMain ? 'no_main_within_budget' : 'required_food_unavailable',
        kind: 'constraint', blocking: true,
        message: !hasMain ? `成员${member.id}的预算与限制下没有可行主食，请调整设置。` : `成员${member.id}的不可退让要求暂时无法满足，请调整设置。`,
      } };
    }
  }
  const basketMap = new Map<string, PriceItem>();
  for (const selection of selections) {
    for (const entry of selection.items) {
      const existing = basketMap.get(entry.candidate.product.id);
      if (existing !== undefined) existing.quantity += entry.quantity;
      else basketMap.set(entry.candidate.product.id, { productCode: entry.candidate.product.id, quantity: entry.quantity, ...(entry.candidate.item.combo ? { roundList: entry.candidate.item.combo.roundList } : {}) });
    }
  }

  for (const meal of shared) {
    const parent = poolCandidateForShared(meal);
    const existing = basketMap.get(meal.productId);
    if (existing) existing.quantity += 1;
    else basketMap.set(meal.productId, { productCode: meal.productId, quantity: 1, roundList: parent.combo!.roundList });
  }
  function poolCandidateForShared(meal: SharedDraft): UnifiedMenuItem {
    // Parent recipes are reconstructed by callers from this menu, never client prices.
    const parent = shared.find(group => group.sharedMealId === meal.sharedMealId)?.parent;
    if (!parent?.combo?.verified) throw new Error('共享套餐默认组成不可用');
    return parent;
  }

  if (basketMap.size === 0) {
    return {
      error: {
        code: 'no_feasible_combination',
        kind: 'constraint',
        blocking: true,
        message: '在该门店的硬约束条件下无法为成员组出任何商品',
      },
    };
  }

  const pricing = await deps.price(storeId, [...basketMap.values()], orderType, beType);
  const quoteByItem = new Map(pricing.lines.map((line) => [line.itemId, line]));

  const purchases = selections.flatMap(selection => selection.items.map((entry, index) => ({ key: `private:${selection.memberId}:${index}`, productId: entry.candidate.product.id, quantity: entry.quantity })));
  purchases.push(...shared.map(meal => ({ key: meal.sharedMealId, productId: meal.productId, quantity: 1 })));
  const charges = new Map<string, number>();
  for (const [productId, basket] of basketMap) {
    const line = quoteByItem.get(productId);
    if (shared.some(meal => meal.productId === productId) && !line) return { error: { code: 'shared_pricing_missing', kind: 'unavailable', blocking: true, message: '共享套餐未返回可核对的计价明细，请重试。' } };
    const fallback = selections.flatMap(selection => selection.items).find(entry => entry.candidate.product.id === productId)?.candidate.product.priceCents ?? 0;
    const subtotal = line?.subtotalFen ?? fallback * basket.quantity;
    const split = allocateCents(purchases.filter(purchase => purchase.productId === productId).map(purchase => ({ memberId: purchase.key, rawFen: purchase.quantity })), subtotal);
    for (const [key, value] of split.allocatedFen) charges.set(key, value);
  }
  const sharedMeals: SharedMeal[] = shared.map(meal => {
    const subtotalCents = charges.get(meal.sharedMealId) ?? 0;
    const split = allocateCents(sharedWeights(meal), subtotalCents);
    return { sharedMealId: meal.sharedMealId, productId: meal.productId, quantity: 1, memberIds: meal.memberIds, components: meal.components, allocationBasis: meal.allocationBasis, subtotalCents, memberSubtotals: meal.memberIds.map(memberId => ({ memberId, subtotalCents: split.allocatedFen.get(memberId) ?? 0 })) };
  });
  if (shared.length && ([...charges.values()].reduce((sum, value) => sum + value, 0) !== pricing.productPriceFen || pricing.productPriceFen - pricing.discountFen !== pricing.payableFen)) return { error: { code: 'shared_pricing_unreconciled', kind: 'unavailable', blocking: true, message: '共享套餐的计价明细与应付金额暂时无法对齐，请重新试算。' } };
  const rawShares = selections.map(selection => ({ memberId: selection.memberId, rawFen: selection.items.reduce((sum, _, index) => sum + (charges.get(`private:${selection.memberId}:${index}`) ?? 0), 0) + sharedMeals.reduce((sum, meal) => sum + (meal.memberSubtotals.find(entry => entry.memberId === selection.memberId)?.subtotalCents ?? 0), 0) }));

  const allocation = allocateCents(rawShares, pricing.payableFen);

  const allocations: MediateAllocation[] = selections.map((selection) => {
    const member = members.find((entry) => entry.id === selection.memberId);
    const budgetCents = Math.round((member?.budget ?? 0) * 100);
    const totalCents = allocation.allocatedFen.get(selection.memberId) ?? 0;

    const items: MediateAllocationItem[] = selection.items.map((entry, index) => {
      const line = quoteByItem.get(entry.candidate.product.id);
      const unitPriceCents =
        line !== undefined && line.quantity > 0
          ? Math.round(line.subtotalFen / line.quantity)
          : entry.candidate.product.priceCents;

      return {
        productId: entry.candidate.product.id,
        quantity: entry.quantity,
        unitPriceCents,
        subtotalCents: charges.get(`private:${selection.memberId}:${index}`) ?? unitPriceCents * entry.quantity,
      };
    });

    const subtotalCents = items.reduce((sum, item) => sum + item.subtotalCents, 0) + sharedMeals.reduce((sum, meal) => sum + (meal.memberSubtotals.find(entry => entry.memberId === selection.memberId)?.subtotalCents ?? 0), 0);

    return {
      memberId: selection.memberId,
      items,
      sharedItems: selection.sharedItems?.map(({ sharedMealId, componentId }) => ({ sharedMealId, componentId })),
      subtotalCents,
      totalCents,
      budgetCents,
      budgetOverCents: Math.max(0, totalCents - budgetCents),
      matchedLikes: selection.matchedLikes,
      missingLikes: selection.missingLikes,
      reason: selection.reasons.join(' + ') || '未选中任何商品',
      requiresManualReview: selection.requiresManualReview,
    };
  });

  // 分摊后复验预算；只要有一个人超，整个方案不可行。
  const over = allocations.filter((entry) => entry.budgetOverCents > 0);
  if (over.length > 0) {
    return {
      error: {
        code: 'allocation_exceeds_budget',
        kind: 'constraint',
        blocking: true,
        message: `${over.map((entry) => `成员 ${String(entry.memberId)}`).join('、')} 分摊后超出预算`,
        detail: { over: over.map((entry) => ({ memberId: entry.memberId, totalCents: entry.totalCents, budgetCents: entry.budgetCents })) },
      },
    };
  }

  const allocatedSum = [...allocation.allocatedFen.values()].reduce((sum, value) => sum + value, 0);

  const tradeoffs = allocations
    .filter((entry) => entry.missingLikes.length > 0)
    .map((entry) => ({
      memberId: entry.memberId,
      issue: `喜欢 ${entry.missingLikes.join('/')} 但本方案未包含`,
      chosen: '保持当前组合',
      reason: '为满足硬约束与预算，未额外加购；不为了花满预算凑单',
      costDeltaCents: 0,
    }));

  for (const allocationEntry of allocations) {
    if (allocationEntry.requiresManualReview) {
      tradeoffs.push({
        memberId: allocationEntry.memberId,
        issue: '存在自填要求，无法自动验证',
        chosen: '保留当前方案',
        reason: '当前只做人工核对，接入模型后再解析为结构化要求',
        costDeltaCents: 0,
      });
    }
  }

  const plan: MediatePlan = {
    planId: `${traceId}_${String(sequence)}_${strategy}`,
    strategy,
    allocations,
    ...(sharedMeals.length ? { sharedMeals } : {}),
    basket: [...basketMap.values()].map(item => ({ productId: item.productCode, quantity: item.quantity })),
    productSubtotalCents: pricing.productPriceFen,
    discountCents: pricing.discountFen,
    payableCents: pricing.payableFen,
    totalCents: pricing.payableFen,
    explanations: [
      `${String(members.length)} 人预算合计 ¥${String(fenToYuan(members.reduce((sum, member) => sum + Math.round((member.budget ?? 0) * 100), 0)))}，实付 ¥${String(fenToYuan(pricing.payableFen))}，未为了花满预算加购`,
      pricing.discountFen > 0
        ? `优惠 ¥${String(fenToYuan(pricing.discountFen))} 按各成员原值比例分摊；${allocations.map((entry) => String(entry.totalCents)).join('+')} = ${String(allocatedSum)}`
        : `无优惠，按原值分摊；${allocations.map((entry) => String(entry.totalCents)).join('+')} = ${String(allocatedSum)}`,
    ],
    allocationAudit: {
      method: 'proportional-largest-remainder',
      payableCents: pricing.payableFen,
      allocatedCentsSum: allocatedSum,
      roundingAdjustmentCents: allocation.roundingAdjustmentFen,
      budgetCheck: 'passed',
    },
    tradeoffs,
    requiresManualReview: allocations.some((entry) => entry.requiresManualReview),
  };

  return { plan, signature: signatureOf(selections) };
}

// ---------------------------------------------------------------- 复议

/** Re-plan one member's entire basket, leaving every other basket locked. */
function basketKey(items: MemberSelection['items']): string {
  return items.map(entry => `${entry.candidate.product.id}:${entry.quantity}`).sort().join('|');
}

function basketPrice(items: MemberSelection['items']): number {
  return items.reduce((sum, entry) => sum + entry.candidate.product.priceCents * entry.quantity, 0);
}

/** Counts actual main/side portions, not invented calories or fullness scores. */
function mealPortions(items: MemberSelection['items']): { mains: number; food: number } {
  let mains = 0; let food = 0;
  for (const entry of items) {
    const components = entry.candidate.product.components;
    if (components?.length) {
      for (const component of components) {
        const main = component.category === 'burger' || /饭|粥|松饼|整鸡|鸡腿|鸡排/.test(component.name);
        if (main) mains += component.quantity * entry.quantity;
        if (main || ['fries', 'snack'].includes(component.category) && !/(?:酱|蘸料|调料)$/.test(component.name)) food += component.quantity * entry.quantity;
      }
    } else {
      if (isMain(entry.candidate)) mains += entry.quantity;
      if (isMain(entry.candidate) || ['fries', 'snack'].includes(entry.candidate.product.category)) food += entry.quantity;
    }
  }
  return { mains, food };
}

function revisionSelections(seed: MemberSelection, member: MemberInput, action: RevisionAction, pool: Candidate[]): MemberSelection[] {
  const budget = Math.round((member.budget ?? 0) * 100);
  const hard = hardFilter(pool, member).filter(candidate => !isNonMeal(candidate) && candidate.product.priceCents <= budget);
  const required = requiredCategory(member);
  const wanted = ['burger', 'fries', 'drink'].includes(action) ? action as Category : undefined;
  const oldKey = basketKey(seed.items);
  const portionsFor = (items: MemberSelection['items']) => mealPortions([...items, ...(seed.sharedItems ?? []).map(ref => ({ candidate: ref.candidate, quantity: 1 / ref.shareCount }))]);
  const oldPortions = portionsFor(seed.items);
  const original = new Map(seed.items.map(entry => [entry.candidate.product.id, entry.quantity]));
  type Option = { items: MemberSelection['items']; cost: number; key: string; distance: number; matches: number; eligible: boolean };
  const seen = new Map<string, Option>();
  const compare = (a: Option, b: Option): number => Number(b.eligible) - Number(a.eligible) ||
    (action === 'cheaper' ? a.cost - b.cost || a.distance - b.distance : a.distance - b.distance || a.cost - b.cost) || b.matches - a.matches || a.key.localeCompare(b.key);
  const add = (items: MemberSelection['items']): Option | undefined => {
    if (items.length > 4 || items.some(entry => entry.quantity < 1 || entry.quantity > 3)) return;
    const cost = basketPrice(items); if (cost + (seed.sharedBudgetCents ?? 0) > budget) return;
    const key = basketKey(items); if (seen.has(key)) return;
    const covered = new Set([...items.map(entry => entry.candidate), ...(seed.sharedItems ?? []).map(ref => ref.candidate)].flatMap(included));
    const portions = portionsFor(items);
    if (!portions.mains) return;
    // An explicit hungrier request may increase fries already in a combo, but
    // other requests must not accidentally duplicate the default drink/side.
    if (items.some(combo => combo.candidate.item.isCombo && items.some(entry => entry !== combo &&
      (entry.candidate.product.category === 'drink' || action !== 'hungrier' && entry.candidate.product.category === 'fries') && included(combo.candidate).includes(entry.candidate.product.category)))) return;
    const moreFood = portions.food > oldPortions.food || portions.mains > oldPortions.mains && portions.food >= oldPortions.food;
    const eligible = key !== oldKey && (required === undefined || covered.has(required)) &&
      (wanted === undefined || covered.has(wanted)) && (action !== 'hungrier' || moreFood);
    const quantities = new Map(items.map(entry => [entry.candidate.product.id, entry.quantity]));
    const distance = [...new Set([...original.keys(), ...quantities.keys()])].reduce((sum, id) => sum + Math.abs((original.get(id) ?? 0) - (quantities.get(id) ?? 0)), 0);
    const option = { items, cost, key, distance, matches: (member.likes ?? []).filter(category => covered.has(category)).length, eligible };
    seen.set(key, option); return option;
  };
  // Start from the original basket as well as every affordable main (including
  // default combos). Expanding fresh cores allows removing or replacing old items.
  const seeds: Option[] = [];
  if (seed.sharedItems?.length) { const empty = add([]); if (empty) seeds.push(empty); }
  if (seed.items.every(entry => hard.includes(entry.candidate))) { const old = add(seed.items); if (old) seeds.push(old); }
  for (const candidate of hard.filter(isMain)) { const option = add([{ candidate, quantity: 1 }]); if (option) seeds.push(option); }
  let frontier = seeds;
  for (let depth = 0; depth < 3; depth += 1) {
    const next: Option[] = [];
    for (const option of frontier) for (const candidate of hard) {
      const existing = option.items.find(entry => entry.candidate === candidate);
      if (existing && (action !== 'hungrier' || candidate.product.category === 'drink' || candidate.product.category === 'dessert')) continue;
      const items = existing ? option.items.map(entry => entry === existing ? { ...entry, quantity: entry.quantity + 1 } : entry) : [...option.items, { candidate, quantity: 1 }];
      const added = add(items); if (added) next.push(added);
    }
    // Bound CPU and quote count on large menus; retain all discovered eligible
    // options and only use a beam for further expansion. No optimality claim.
    frontier = next.sort(compare).slice(0, 180);
    if (!frontier.length) break;
  }
  return [...seen.values()].filter(option => option.eligible).sort(compare).slice(0, 40).map(option => {
    const liked = member.likes ?? [];
    const matchedLikes = liked.filter(category => [...option.items.map(entry => entry.candidate), ...(seed.sharedItems ?? []).map(ref => ref.candidate)].some(candidate => included(candidate).includes(category)));
    return { memberId: member.id, items: option.items, sharedItems: seed.sharedItems, sharedBudgetCents: seed.sharedBudgetCents, matchedLikes, missingLikes: liked.filter(category => !matchedLikes.includes(category)), requiresManualReview: Boolean(member.customRequirement?.trim()), reasons: option.items.map(entry => `${entry.candidate.product.name} ×${entry.quantity}`) };
  });
}

async function replanRevision(request: MediateRequest, pool: Candidate[], fixed: Map<number, MemberSelection>, deps: MediateDependencies, traceId: string, shared: Array<SharedDraft & { parent: UnifiedMenuItem }> = []): Promise<{ plan?: MediatePlan; issue?: MediateIssue; hint?: MediateHint }> {
  const revision = request.revision!; const member = request.members.find(entry => entry.id === revision.memberId)!;
  const seed = fixed.get(member.id)!; const previous = request.excludePlan!.allocations.find(entry => entry.memberId === member.id)!;
  const fail = (code: string, message: string, kind: MediateIssue['kind'] = 'constraint') => ({ issue: { memberId: member.id, code, kind, blocking: true, message } });
  // Never silently drop a missing original item from any locked basket.
  for (const allocation of request.excludePlan!.allocations) {
    const current = fixed.get(allocation.memberId);
    if (!current || current.items.length !== allocation.items.length) return fail('revision_menu_changed', '原方案的部分餐品已不可用，请重新生成整顿饭的方案；原方案已保留。', 'unavailable');
  }
  const wanted = ['burger', 'fries', 'drink'].includes(revision.action) ? revision.action as Category : undefined;
  const label = wanted === 'burger' ? '汉堡' : wanted === 'fries' ? '薯条' : '饮料';
  if (wanted && (member.dislikes ?? []).includes(wanted)) return fail('revision_food_excluded', `成员${member.id}已排除${label}，请先调整食物限制；原方案已保留。`);
  if (wanted && selectionCandidates(seed).some(candidate => included(candidate).includes(wanted))) return fail('revision_already_included', `原方案已经包含${label}（含套餐默认子项），无需重复添加。想增加主餐或配餐，可以选择“更饿了”；原方案已保留。`);
  const options = revisionSelections(seed, member, revision.action, pool);
  let pricedCount = 0;
  for (const option of options) {
    if (pricedCount++ >= 8) break;
    const selections = request.members.map(entry => entry.id === member.id ? option : fixed.get(entry.id)!);
    const built = await buildPlan(request.storeId, request.excludePlan!.strategy, request.members, selections, request.orderType ?? 1, request.beType ?? 1, deps, traceId, 500 + pricedCount, shared);
    if ('error' in built) continue;
    const allocation = built.plan.allocations.find(entry => entry.memberId === member.id)!;
    if (revision.action === 'cheaper' && allocation.totalCents >= previous.totalCents) continue;
    const changes = (from: MemberSelection['items'], to: MemberSelection['items']) => to.flatMap(entry => {
      const delta = entry.quantity - (from.find(old => old.candidate.product.id === entry.candidate.product.id)?.quantity ?? 0);
      return delta > 0 ? [`${entry.candidate.product.name} ×${delta}`] : [];
    });
    const removed = changes(option.items, seed.items); const added = changes(seed.items, option.items);
    const message = `成员${member.id}已重新搭配：${removed.length ? `移除${removed.join('、')}；` : ''}${added.length ? `加入${added.join('、')}；` : ''}个人实付 ¥${fenToYuan(previous.totalCents)} → ¥${fenToYuan(allocation.totalCents)}。其他成员餐品保留。`;
    built.plan.explanations.unshift(message);
    return { plan: built.plan, hint: { memberId: member.id, level: 'info', message } };
  }
  const budget = `预算 ¥${member.budget}`;
  if (revision.action === 'cheaper' && seed.sharedItems?.length) return fail('revision_shared_locked', '该成员参与共享套餐。为保留其他人的餐品，本轮不拆换共享部分；当前未找到可降低实付的个人加餐调整。需要更换共享套餐时，请重新生成整顿饭的方案，原方案已保留。');
  if (revision.action === 'cheaper') return fail('revision_no_cheaper_plan', `已尝试重新组合单品与默认套餐，暂未找到个人实付低于 ¥${fenToYuan(previous.totalCents)}、同时满足${budget}和食物限制的方案；原方案已保留。`);
  if (revision.action === 'hungrier') return fail('revision_no_larger_meal', `已尝试加餐及替换整份搭配，在${budget}和现有食物限制下，暂未找到能增加主餐或配餐份数的组合；可以提高预算或调整食物限制，原方案已保留。`);
  return fail('revision_no_requested_food', `已尝试替换整份搭配，暂未找到同时包含${label}、保留主餐并满足${budget}和食物限制的组合；原方案已保留。`);
}

/** Bounded recovery search. Every suggestion carries a real priced proof.
 * Changes apply only after a click. Dietary restrictions are never relaxed.
 */
async function recoverySuggestions(request: MediateRequest, pool: Candidate[], deps: MediateDependencies, traceId: string): Promise<RecoverySuggestion[]> {
  const suggestions: RecoverySuggestion[] = [];
  const trial = async (members: MemberInput[], changes: RecoverySuggestion['changes'], title: string): Promise<boolean> => {
    const selections = members.map(member => selectForMember(pool, { ...member, hunger: 'little' }, 'saving', true));
    const built = await buildPlan(request.storeId, 'saving', members, selections, request.orderType ?? 1, request.beType ?? 1, deps, traceId, 100 + suggestions.length);
    if ('error' in built) return false;
    suggestions.push({ id: `${traceId}_adjust_${suggestions.length}`, title, summary: '只改下列条件，其余要求保留；已按一份主餐起步，用当前门店菜单和真实价格试算。', verifiedAt: new Date().toISOString(), changes, plan: built.plan });
    return true;
  };
  // Price the cheapest compatible cores, then verify the proposed budgets again.
  // This is a feasible price, not a claim that no lower price exists.
  const raised = request.members.map(member => ({ ...member, budget: 200 }));
  const cores = raised.map(member => selectForMember(pool, { ...member, hunger: 'little' }, 'saving', true));
  const proof = await buildPlan(request.storeId, 'saving', raised, cores, request.orderType ?? 1, request.beType ?? 1, deps, traceId, 99);
  if (!('error' in proof)) {
    const changes = request.members.flatMap(member => {
      const allocation = proof.plan.allocations.find(entry => entry.memberId === member.id)!;
      const menuCost = cores.find(entry => entry.memberId === member.id)!.items.reduce((sum, entry) => sum + entry.candidate.product.priceCents * entry.quantity, 0);
      const budget = Math.max(member.budget ?? 0, Math.ceil(Math.max(allocation.totalCents, menuCost) / 100));
      return budget > (member.budget ?? 0) && budget <= 200 ? [{ memberId: member.id, budget }] : [];
    });
    if (changes.length) await trial(request.members.map(member => ({ ...member, budget: changes.find(change => change.memberId === member.id)?.budget ?? member.budget })), changes, '调整预算，保留食物要求');
  }
  // At most six one-condition trials; never recurse into model calls.
  let attempts = 0;
  for (const member of request.members) {
    const changes: RecoverySuggestion['changes'] = [];
    if (['burger', 'fries', 'drink'].includes(member.requirement ?? '')) changes.push({ memberId: member.id, requirement: 'none' });
    for (const category of member.dislikes ?? []) changes.push({ memberId: member.id, dislikes: member.dislikes!.filter(entry => entry !== category) });
    for (const change of changes) {
      if (suggestions.length >= 2 || attempts++ >= 6) return suggestions;
      const members = request.members.map(entry => entry.id === member.id ? { ...entry, ...change } : entry);
      if (await trial(members, [change], '放宽一项食物选择')) return suggestions;
    }
  }
  return suggestions;
}

// ---------------------------------------------------------------- meta

interface MetaInput {
  provider: ProposalProvider | null;
  menuCapturedAt: string;
  couponCount: number;
  pricingVerified: boolean;
  strategiesReturned: Strategy[];
  strategiesDeduplicated: Strategy[];
  llmDetail: LlmAttempt[];
}

/**
 * `planner` / `reasoning` / `degraded` 必须能被追责：
 * - 只要有一个方案真由模型提出并通过校验 → `llm-validated-v1` + `reasoning: llm`；
 * - 模型被调用了但全被拦下 → `rule-based-v2` + `rules-fallback` + `degraded: true`；
 * - 模型未配置或本轮不适用（复议）→ `rule-based-v2` + `rules`，**不谎称降级**。
 */
function buildMeta(input: MetaInput): MediateResult['meta'] {
  const accepted = input.llmDetail.some((entry) => entry.status === 'accepted');
  const attempted = input.llmDetail.some((entry) => entry.status === 'rejected');

  return {
    planner: accepted ? 'llm-validated-v1' : 'rule-based-v2',
    pricingVerified: input.pricingVerified,
    menuCapturedAt: input.menuCapturedAt,
    couponCount: input.couponCount,
    degraded: attempted,
    reasoning: accepted ? 'llm' : attempted ? 'rules-fallback' : 'rules',
    strategiesReturned: input.strategiesReturned,
    strategiesDeduplicated: input.strategiesDeduplicated,
    llm: input.provider?.label ?? 'not_configured',
    llmDetail: input.llmDetail,
  };
}

// ---------------------------------------------------------------- 主入口

export async function mediate(
  request: MediateRequest,
  overrides: Partial<MediateDependencies> = {},
): Promise<MediateResult> {
  const base: MediateDependencies = { ...defaultDependencies, ...overrides };
  const quotes = new Map<string, Promise<UnifiedPricing>>();
  const deps: MediateDependencies = { ...base, price: (store, items, orderType, beType) => {
    const key = JSON.stringify([store, [...items].sort((a, b) => a.productCode.localeCompare(b.productCode)), orderType, beType]);
    let quote = quotes.get(key); if (!quote) { quote = base.price(store, items, orderType, beType).catch(error => { quotes.delete(key); throw error; }); quotes.set(key, quote); }
    return quote;
  } };
  const provider = deps.proposals ?? null;
  const llmDetail: LlmAttempt[] = [];
  const orderType = request.orderType ?? 1;
  const beType = request.beType ?? 1;
  const traceId = `med_${String(Date.now())}`;

  const menu = await deps.menu({ storeCode: request.storeId, orderType, beType });
  const pool: Candidate[] = menu.items
    .filter((item) => item.priceFen > 0)
    .map((item) => ({ item, product: toProduct(item, menu.items) }));

  const products = request.options?.includeProducts === false ? undefined : pool.map((entry) => entry.product);
  const issues: MediateIssue[] = [];
  const hints: MediateHint[] = [];

  // 未填写预算：契约要求只给非阻塞提示，不产出方案。
  const missingBudget = request.members.filter((member) => member.budget === null);
  if (missingBudget.length > 0) {
    for (const member of missingBudget) {
      issues.push({
        memberId: member.id,
        code: 'budget_missing',
        kind: 'input',
        blocking: false,
        message: `成员 ${String(member.id)} 未填写预算，无法判断可行性`,
        detail: { budget: null },
      });
      hints.push({
        memberId: member.id,
        level: 'warn',
        message: '请先填写预算（1–200 元整数），未填写不等于不限预算',
      });
    }

    return {
      source: 'live',
      traceId,
      store: { id: menu.store.id, name: menu.store.name },
      products,
      plans: [],
      issues,
      hints,
      meta: buildMeta({
        provider,
        menuCapturedAt: menu.capturedAt,
        couponCount: 0,
        pricingVerified: false,
        strategiesReturned: [],
        strategiesDeduplicated: [],
        llmDetail,
      }),
    };
  }

  // 自填要求：人工核对，永不阻塞。
  for (const member of request.members) {
    const custom = (member.customRequirement ?? '').trim();
    if (custom !== '') {
      issues.push({
        memberId: member.id,
        code: 'custom_requirement_unverified',
        kind: 'input',
        blocking: false,
        message: `自填要求「${custom}」需要人工核对，系统未自动处理`,
        detail: { customRequirement: custom },
      });
      hints.push({
        memberId: member.id,
        level: 'info',
        message: '该成员有自填要求，下单前请自行确认配料',
      });
    }
  }

  // ---- 复议：只用目标成员重新求解，其他人锁定 ----
  const fixedByMember = new Map<number, MemberSelection>();
  let revisionIssue: MediateIssue | undefined;
  let targetMemberId: number | undefined;

  if (request.revision !== undefined) {
    targetMemberId = request.revision.memberId;
    const excluded = request.excludePlan;

    if (excluded === undefined) {
      revisionIssue = {
        memberId: targetMemberId,
        code: 'exclude_plan_required',
        kind: 'input',
        blocking: true,
        message: '复议必须携带上一份完整方案 excludePlan',
      };
    } else {
      for (const allocation of excluded.allocations) {
        const member = request.members.find((entry) => entry.id === allocation.memberId);
        if (member === undefined) continue;

        const items = allocation.items.flatMap((item) => {
          const candidate = pool.find((entry) => entry.product.id === item.productId);
          return candidate === undefined ? [] : [{ candidate, quantity: item.quantity }];
        });

        fixedByMember.set(allocation.memberId, {
          memberId: allocation.memberId,
          items,
          matchedLikes: [],
          missingLikes: [],
          requiresManualReview: (member.customRequirement ?? '').trim() !== '',
          reasons: items.map((entry) => entry.candidate.product.name),
        });
      }
    }
  }

  const builtPlans: BuiltPlan[] = [];
  const strategiesReturned: Strategy[] = [];
  const strategiesDeduplicated: Strategy[] = [];
  const seenSignatures = new Map<string, Strategy>();

  // 复议请求本身不合法（缺 excludePlan）：直接返回，不去猜一份方案。
  if (revisionIssue !== undefined) {
    issues.push(revisionIssue);
    return {
      source: 'live',
      traceId,
      store: { id: menu.store.id, name: menu.store.name },
      products,
      plans: [],
      issues,
      hints,
      meta: buildMeta({
        provider,
        menuCapturedAt: menu.capturedAt,
        couponCount: 0,
        pricingVerified: false,
        strategiesReturned: [],
        strategiesDeduplicated: [],
        llmDetail,
      }),
    };
  }

  if (request.revision) {
    let shared: Array<SharedDraft & { parent: UnifiedMenuItem }> = [];
    try {
      const drafts = restoreSharedDrafts(request.excludePlan!.sharedMeals, pool.map(candidate => candidate.product), request.members);
      shared = drafts.map(group => ({ ...group, parent: pool.find(candidate => candidate.product.id === group.productId)!.item }));
      const rebuilt = attachSharedSelections(pool, request.members, shared, fixedByMember);
      for (const selection of rebuilt) {
        const expected = (selection.sharedItems ?? []).map(ref => `${ref.sharedMealId}/${ref.componentId}`).sort().join('|');
        const actual = (request.excludePlan!.allocations.find(allocation => allocation.memberId === selection.memberId)?.sharedItems ?? []).map(ref => `${ref.sharedMealId}/${ref.componentId}`).sort().join('|');
        if (expected !== actual) throw new Error('共享餐品归属不一致');
        fixedByMember.set(selection.memberId, selection);
      }
    } catch {
      return { source: 'live', traceId, store: { id: menu.store.id, name: menu.store.name }, products, plans: [], issues: [{ code: 'revision_shared_changed', kind: 'unavailable', blocking: true, message: '共享套餐组成或分配已发生变化，请重新生成方案；原方案已保留。' }], hints,
        meta: buildMeta({ provider, menuCapturedAt: menu.capturedAt, couponCount: 0, pricingVerified: false, strategiesReturned: [], strategiesDeduplicated: [], llmDetail }) };
    }
    const outcome = await replanRevision(request, pool, fixedByMember, deps, traceId, shared);
    if (outcome.issue) issues.push(outcome.issue);
    if (outcome.hint) hints.push(outcome.hint);
    const strategy = request.excludePlan!.strategy;
    const couponCount = outcome.plan ? await deps.couponCount(request.storeId, orderType, beType) : 0;
    if (provider) llmDetail.push({ strategy, status: 'skipped', model: provider.label, code: 'revision_uses_rules', message: '复议使用有界组合搜索与真实试算，不调用模型' });
    return { source: 'live', traceId, store: { id: menu.store.id, name: menu.store.name }, products, plans: outcome.plan ? [outcome.plan] : [], issues, hints,
      meta: buildMeta({ provider, menuCapturedAt: menu.capturedAt, couponCount, pricingVerified: Boolean(outcome.plan), strategiesReturned: outcome.plan ? [strategy] : [], strategiesDeduplicated: [], llmDetail }) };
  }

  const sharingOptions = sharedCombinations(sharedDrafts(pool.map(candidate => candidate.product), request.members), pool, request.members);

  const maxPlans = Math.min(3, Math.max(1, request.options?.maxPlans ?? 3));

  // Normal generation requests all strategies once; revision returned above.
  const requestedStrategies: Strategy[] = [];
  for (const strategy of STRATEGIES) {
    if (requestedStrategies.length >= maxPlans) break;
    if (request.excludePlan !== undefined && request.excludePlan.strategy === strategy && request.revision === undefined) {
      continue;
    }
    requestedStrategies.push(strategy);
  }

  let modelRun: ModelRun | undefined;
  if (provider !== null) modelRun = await planWithModel(provider, pool, request.members, requestedStrategies, menu.store.name);

  for (const strategy of STRATEGIES) {
    if (builtPlans.length >= maxPlans) break;
    if (request.excludePlan !== undefined && request.excludePlan.strategy === strategy && request.revision === undefined) {
      strategiesDeduplicated.push(strategy);
      continue;
    }

    /** 规则版选品：模型不可用或被拦下时走这里。 */
    const buildRuleSelections = (): MemberSelection[] => request.members.map(member => selectForMember(pool, member, strategy, true));

    let built: BuiltPlan | { error: MediateIssue } | undefined;

    const modelSelections = modelRun?.selections.get(strategy);
    if (modelSelections !== undefined) {
      built = await buildPlan(
        request.storeId,
        strategy,
        request.members,
        modelSelections,
        orderType,
        beType,
        deps,
        traceId,
        builtPlans.length + 1,
      );

      if ('error' in built) {
        // 校验过了但真实计价/分摊不过（例如优惠后仍超预算）：降级，不硬塞。
        llmDetail.push({
          strategy,
          status: 'rejected',
          model: provider?.label ?? 'unknown',
          code: built.error.code,
          message: built.error.message,
        });
      } else {
        llmDetail.push({
          strategy,
          status: 'accepted',
          model: provider?.label ?? 'unknown',
          latencyMs: modelRun?.latencyMs,
        });
      }
    } else if (modelRun !== undefined) {
      const failure = modelRun.failures.get(strategy);
      llmDetail.push({
        strategy,
        status: 'rejected',
        model: provider?.label ?? 'unknown',
        code: failure?.code ?? 'model_no_plan',
        message: failure?.message ?? '模型没有给出该策略的方案',
      });
    }

    if (built === undefined || 'error' in built) {
      const selections = buildRuleSelections();
        built = await buildPlan(
        request.storeId,
        strategy,
        request.members,
        selections,
        orderType,
        beType,
        deps,
        traceId,
        builtPlans.length + 1,
      );
    }

    let choseSharing = false;
    for (const [index, groups] of sharingOptions.slice(0, 6).entries()) {
      try {
        const selections = attachSharedSelections(pool, request.members, groups);
        const sharedPlan = await buildPlan(request.storeId, strategy, request.members, selections, orderType, beType, deps, traceId, 1000 + index, groups.map(group => ({ ...group, parent: pool.find(candidate => candidate.product.id === group.productId)!.item })));
        if ('error' in sharedPlan) continue;
        const better = 'error' in built || (strategy === 'saving' ? sharedPlan.plan.totalCents < built.plan.totalCents : planPreference(sharedPlan.plan, request.members, pool) > planPreference(built.plan, request.members, pool));
        if (better) { built = sharedPlan; choseSharing = true; }
      } catch {
        if (!hints.some(hint => hint.message.includes('共享套餐试算'))) hints.push({ level: 'warn', message: '部分共享套餐试算暂不可用，保留其他已核对的方案。' });
        break;
      }
    }
    if (choseSharing) {
      const accepted = llmDetail.find(attempt => attempt.strategy === strategy && attempt.status === 'accepted');
      if (accepted) { accepted.status = 'skipped'; accepted.code = 'shared_rule_choice'; accepted.message = '比较后采用规则生成的共享套餐，非模型分餐'; }
      if (!hints.some(hint => hint.message.includes('共享套餐按实际'))) hints.push({ level: 'info', message: '共享套餐按实际分到的餐品分摊，整套仅计价一次；共同配餐的份额在参与成员间均分。' });
    }

    if ('error' in built) {
      issues.push({ ...built.error, memberId: built.error.memberId });
      continue;
    }

    const previous = seenSignatures.get(built.signature);
    if (previous !== undefined) {
      strategiesDeduplicated.push(strategy);
      continue;
    }

    seenSignatures.set(built.signature, strategy);
    builtPlans.push(built);
    strategiesReturned.push(strategy);
  }

  if (builtPlans.length === 0 && issues.every((issue) => issue.blocking === false)) {
    issues.push({
      code: 'no_feasible_plan',
      kind: 'constraint',
      blocking: true,
      message: '当前预算与限制下没有任何可行方案',
    });
  }

  // 模型被拦下是「体验降级」，不是「无解」：只给非阻塞提示，绝不写成 blocking issue。
  const rejected = llmDetail.filter((entry) => entry.status === 'rejected');
  if (rejected.length > 0) {
    hints.push({
      level: 'info',
      message: `模型方案未通过校验（${rejected
        .map((entry) => `${entry.strategy}: ${entry.code ?? 'unknown'}`)
        .join('、')}），已回退规则版生成；金额仍按真实试算`,
    });
  }

  const couponCount = builtPlans.length > 0 ? await deps.couponCount(request.storeId, orderType, beType) : 0;
  let suggestions: RecoverySuggestion[] = [];
  if (builtPlans.length === 0 && !request.revision) {
    try { suggestions = await recoverySuggestions(request, pool, deps, traceId); }
    catch { hints.push({ level: 'warn', message: '暂时未能完成调整建议的价格核对，请稍后重新生成或换一家门店。' }); }
  }
  const uniqueIssues = issues.filter((issue, index) => issues.findIndex(other => other.code === issue.code && other.memberId === issue.memberId) === index);

  return {
    source: 'live',
    traceId,
    store: { id: menu.store.id, name: menu.store.name },
    products,
    plans: builtPlans.map((entry) => entry.plan),
    issues: uniqueIssues,
    hints,
    suggestions,
    meta: buildMeta({
      provider,
      menuCapturedAt: menu.capturedAt,
      couponCount,
      pricingVerified: builtPlans.length > 0,
      strategiesReturned,
      strategiesDeduplicated,
      llmDetail,
    }),
  };
}

export function describeStrategies(result: MediateResult): string {
  return result.meta.strategiesReturned.map(strategyLabel).join('、');
}
