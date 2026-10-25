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

import { mcd } from './mcd.js';
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
  planId: string;
  strategy: Strategy;
  allocations: Array<{
    memberId: number;
    items: Array<{ productId: string; quantity: number }>;
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

export interface MediateResult {
  source: 'live';
  traceId: string;
  store: { id: string; name: string; businessStatus?: boolean };
  products?: MediateProduct[];
  plans: MediatePlan[];
  issues: MediateIssue[];
  hints: MediateHint[];
  meta: {
    planner: 'rule-based-v2';
    pricingVerified: boolean;
    menuCapturedAt: string;
    couponCount: number;
    degraded: boolean;
    reasoning: 'rules';
    strategiesReturned: Strategy[];
    strategiesDeduplicated: Strategy[];
    llm: string;
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
};

// ---------------------------------------------------------------- 商品分类与食材推导

const FRIES_RE = /薯条|薯饼/;
const DRINK_RE = /饮品|可乐|雪碧|红茶|咖啡|牛奶|果汁|苹果汁|矿泉水|茶|汁/;
const DESSERT_RE = /冰淇淋|麦旋风|圆筒|派|甜点|圣代|新地|奥利奥/;
const BURGER_RE = /堡|卷/;
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
const BEEF_NAME_RE = /牛/;
const BEEF_TAG_RE = /牛肉|纯牛/;
/**
 * 不是餐品的东西不能占「主食/配餐」名额。实测踩到两次：
 * 一是「北美招牌牧场酱 ¥3」被选成配餐（只有调料没有食物），
 * 二是「旋旋星愿贴 ¥3.9」这种**周边贴纸**被选成配餐。
 * 它们仍保留在 `products` 里供前端展示，只是不参与组餐。
 */
const NON_MEAL_RE = /酱|蘸料|调料|糖包|奶精|周边|限量|贴纸|盲盒|玩具|玩偶|卡片|徽章/;

function isNonMeal(candidate: Candidate): boolean {
  const haystack = `${candidate.product.name} ${candidate.item.tags.join(' ')}`;
  return NON_MEAL_RE.test(haystack);
}

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
  const nameBeef = BEEF_NAME_RE.test(item.name) || BEEF_NAME_RE.test(item.category);

  const beef: DietaryField = tagBeef
    ? { inferred: true, source: 'tag', confidence: 'high' }
    : nameBeef
      ? { inferred: true, source: 'name', confidence: 'medium' }
      : { inferred: false, source: 'name', confidence: 'low' };

  return { spicy, beef };
}

function toProduct(item: UnifiedMenuItem): MediateProduct {
  const dietary = inferDietary(item);
  return {
    id: item.id,
    name: item.name,
    category: toCategory(item),
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

function violatesDislikes(candidate: Candidate, member: MemberInput): boolean {
  const dislikes = member.dislikes ?? [];
  return dislikes.includes(candidate.product.category);
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
  return likes.includes(candidate.product.category) ? 1 : 0;
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
  requireMain: boolean,
): MemberSelection {
  const budgetCents = Math.round((member.budget ?? 0) * 100);
  // 硬约束之后再剔除蘸酱/周边等非餐品：它们仍在 products 里供前端展示，但不参与组餐。
  const hard = hardFilter(pool, member).filter((candidate) => !isNonMeal(candidate));
  const slots = slotsFor(member);
  const required = requiredCategory(member);

  const selected: Array<{ candidate: Candidate; quantity: number }> = [];
  const reasons: string[] = [];
  let spent = 0;

  const take = (candidate: Candidate | undefined, label: string): void => {
    if (candidate === undefined) return;
    if (spent + candidate.product.priceCents > budgetCents) return;
    selected.push({ candidate, quantity: 1 });
    spent += candidate.product.priceCents;
    reasons.push(`${label}「${candidate.product.name}」¥${String(fenToYuan(candidate.product.priceCents))}`);
  };

  const picked = new Set<string>();
  const remaining = (): number => budgetCents - spent;

  // 1) 必须满足的类别（requirement 指定）优先。
  if (required !== undefined) {
    const candidate = pickCandidate(
      hard,
      member,
      strategy,
      budgetCents,
      (entry) => entry.product.category === required && entry.product.priceCents <= budgetCents,
    );
    if (candidate !== undefined) {
      take(candidate, `${required} 需求`);
      picked.add(candidate.product.id);
    }
  }

  // 2) 主食。
  if (slots.main && (requireMain || required === undefined)) {
    const alreadyBurger = selected.some((entry) => entry.candidate.product.category === 'burger');
    if (!alreadyBurger) {
      const candidate = pickCandidate(
        hard,
        member,
        strategy,
        budgetCents,
        (entry) => entry.product.category === 'burger' && entry.product.priceCents <= remaining(),
      );
      if (candidate !== undefined) {
        take(candidate, '主食');
        picked.add(candidate.product.id);
      }
    }
  }

  // 3) 配餐（薯条/小食/甜点）。
  if (slots.side) {
    const hasSide = selected.some((entry) =>
      ['fries', 'snack', 'dessert'].includes(entry.candidate.product.category),
    );
    if (!hasSide) {
      const candidate = pickCandidate(
        hard,
        member,
        strategy,
        budgetCents,
        (entry) =>
          ['fries', 'snack', 'dessert'].includes(entry.product.category) &&
          entry.product.priceCents <= remaining(),
      );
      if (candidate !== undefined) take(candidate, '配餐');
    }
  }

  // 4) 饮料。
  if (slots.drink) {
    const hasDrink = selected.some((entry) => entry.candidate.product.category === 'drink');
    if (!hasDrink) {
      const candidate = pickCandidate(
        hard,
        member,
        strategy,
        budgetCents,
        (entry) => entry.product.category === 'drink' && entry.product.priceCents <= remaining(),
      );
      if (candidate !== undefined) take(candidate, '饮料');
    }
  }

  const liked = member.likes ?? [];
  const matchedLikes = liked.filter((category) =>
    selected.some((entry) => entry.candidate.product.category === category),
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
      return `${String(entry.memberId)}:${items}`;
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
): Promise<BuiltPlan | { error: MediateIssue }> {
  // A priced basket is not a feasible group meal if someone received no main,
  // or a required food was silently skipped while choosing affordable items.
  for (const selection of selections) {
    const member = members.find(entry => entry.id === selection.memberId);
    if (!member) continue;
    const required = requiredCategory(member);
    const hasMain = selection.items.some(entry => entry.candidate.product.category === 'burger');
    const meetsRequirement = required === undefined || selection.items.some(entry => entry.candidate.product.category === required);
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
      else basketMap.set(entry.candidate.product.id, { productCode: entry.candidate.product.id, quantity: entry.quantity });
    }
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

  // 各成员权重来自试算明细，而不是菜单价累加。
  const rawShares = selections.map((selection) => {
    let raw = 0;
    for (const entry of selection.items) {
      const line = quoteByItem.get(entry.candidate.product.id);
      const totalQuantity = basketMap.get(entry.candidate.product.id)?.quantity ?? entry.quantity;
      const lineSubtotal = line?.subtotalFen ?? entry.candidate.product.priceCents * entry.quantity;
      raw += (lineSubtotal * entry.quantity) / Math.max(1, totalQuantity);
    }
    return { memberId: selection.memberId, rawFen: raw };
  });

  const allocation = allocateCents(rawShares, pricing.payableFen);

  const allocations: MediateAllocation[] = selections.map((selection) => {
    const member = members.find((entry) => entry.id === selection.memberId);
    const budgetCents = Math.round((member?.budget ?? 0) * 100);
    const totalCents = allocation.allocatedFen.get(selection.memberId) ?? 0;

    const items: MediateAllocationItem[] = selection.items.map((entry) => {
      const line = quoteByItem.get(entry.candidate.product.id);
      const unitPriceCents =
        line !== undefined && line.quantity > 0
          ? Math.round(line.subtotalFen / line.quantity)
          : entry.candidate.product.priceCents;

      return {
        productId: entry.candidate.product.id,
        quantity: entry.quantity,
        unitPriceCents,
        subtotalCents: unitPriceCents * entry.quantity,
      };
    });

    const subtotalCents = items.reduce((sum, item) => sum + item.subtotalCents, 0);

    return {
      memberId: selection.memberId,
      items,
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

/**
 * 复议：保住其他成员原来的餐品，只改目标成员。
 * 返回目标成员新的选择；找不到更便宜的替代就原样返回并给 `constraint`。
 */
function applyRevision(
  selection: MemberSelection,
  member: MemberInput,
  action: RevisionAction,
  pool: Candidate[],
): { selection: MemberSelection; note?: MediateIssue } {
  const hard = hardFilter(pool, member).filter(candidate => !isNonMeal(candidate));
  const currentIds = new Set(selection.items.map((entry) => entry.candidate.product.id));
  const currentTotal = selection.items.reduce((sum, entry) => sum + entry.candidate.product.priceCents, 0);
  const budgetCents = Math.round((member.budget ?? 0) * 100);

  const nextItems = [...selection.items];

  if (action === 'cheaper') {
    // 逐项替换成同类别更便宜的替代，总价必须严格下降。
    for (let index = 0; index < nextItems.length; index += 1) {
      const current = nextItems[index];
      if (current === undefined) continue;
      const cheaper = hard
        .filter(
          (candidate) =>
            candidate.product.category === current.candidate.product.category &&
            candidate.product.priceCents < current.candidate.product.priceCents &&
            !currentIds.has(candidate.product.id),
        )
        .sort((a, b) => a.product.priceCents - b.product.priceCents)[0];

      if (cheaper !== undefined) {
        nextItems[index] = { candidate: cheaper, quantity: current.quantity };
        currentIds.delete(current.candidate.product.id);
        currentIds.add(cheaper.product.id);
      }
    }
  } else {
    const wanted: Category =
      action === 'hungrier' ? 'burger' : action === 'fries' ? 'fries' : action === 'burger' ? 'burger' : 'drink';

    const extra = hard
      .filter(
        (candidate) =>
          candidate.product.category === wanted &&
          !currentIds.has(candidate.product.id) &&
          currentTotal + candidate.product.priceCents <= budgetCents,
      )
      .sort((a, b) => a.product.priceCents - b.product.priceCents)[0];

    if (extra !== undefined) {
      nextItems.push({ candidate: extra, quantity: 1 });
      currentIds.add(extra.product.id);
    }
  }

  const liked = member.likes ?? [];
  const matchedLikes = liked.filter((category) =>
    nextItems.some((entry) => entry.candidate.product.category === category),
  );

  const revised: MemberSelection = {
    memberId: selection.memberId,
    items: nextItems,
    matchedLikes,
    missingLikes: liked.filter((category) => !matchedLikes.includes(category)),
    requiresManualReview: (member.customRequirement ?? '').trim() !== '',
    reasons: nextItems.map(
      (entry) => `${entry.candidate.product.name} ¥${String(fenToYuan(entry.candidate.product.priceCents))}`,
    ),
  };

  const revisedTotal = nextItems.reduce((sum, entry) => sum + entry.candidate.product.priceCents, 0);
  if (action === 'cheaper' && revisedTotal >= currentTotal) {
    return {
      selection: revised,
      note: {
        memberId: member.id,
        code: 'no_cheaper_alternative',
        kind: 'constraint',
        blocking: true,
        message: `成员 ${String(member.id)} 已无可替换的更便宜同类商品`,
      },
    };
  }

  return { selection: revised };
}

// ---------------------------------------------------------------- 主入口

export async function mediate(
  request: MediateRequest,
  overrides: Partial<MediateDependencies> = {},
): Promise<MediateResult> {
  const deps: MediateDependencies = { ...defaultDependencies, ...overrides };
  const orderType = request.orderType ?? 1;
  const beType = request.beType ?? 1;
  const traceId = `med_${String(Date.now())}`;

  const menu = await deps.menu({ storeCode: request.storeId, orderType, beType });
  const pool: Candidate[] = menu.items
    .filter((item) => item.priceFen > 0)
    .map((item) => ({ item, product: toProduct(item) }));

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
      meta: {
        planner: 'rule-based-v2',
        pricingVerified: false,
        menuCapturedAt: menu.capturedAt,
        couponCount: 0,
        degraded: false,
        reasoning: 'rules',
        strategiesReturned: [],
        strategiesDeduplicated: [],
        llm: 'not_configured',
      },
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
  let fixedByMember = new Map<number, MemberSelection>();
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
      meta: {
        planner: 'rule-based-v2',
        pricingVerified: false,
        menuCapturedAt: menu.capturedAt,
        couponCount: 0,
        degraded: false,
        reasoning: 'rules',
        strategiesReturned: [],
        strategiesDeduplicated: [],
        llm: 'not_configured',
      },
    };
  }

  const maxPlans = Math.min(3, Math.max(1, request.options?.maxPlans ?? 3));

  for (const strategy of STRATEGIES) {
    if (builtPlans.length >= maxPlans) break;
    if (request.excludePlan !== undefined && request.excludePlan.strategy === strategy && request.revision === undefined) {
      strategiesDeduplicated.push(strategy);
      continue;
    }

    const selections: MemberSelection[] = [];
    for (const member of request.members) {
      const fixed = fixedByMember.get(member.id);

      if (request.revision !== undefined && member.id === targetMemberId) {
        const base = fixedByMember.get(member.id);
        const seed =
          base ??
          selectForMember(pool, member, strategy, true);

        const { selection, note } = applyRevision(seed, member, request.revision.action, pool);
        // 不要覆盖更早、更根本的错误（例如 excludePlan 缺失）。
        if (note !== undefined && revisionIssue === undefined) revisionIssue = note;
        selections.push(selection);
        continue;
      }

      if (fixed !== undefined) {
        selections.push(fixed);
        continue;
      }

      selections.push(selectForMember(pool, member, strategy, true));
    }

    if (revisionIssue !== undefined) break;

    const built = await buildPlan(
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

  // 复议过程中发现目标成员做不到（例如已无更便宜替代）：按契约返回空方案，
  // 不用旧方案充数。
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
      meta: {
        planner: 'rule-based-v2',
        pricingVerified: false,
        menuCapturedAt: menu.capturedAt,
        couponCount: 0,
        degraded: false,
        reasoning: 'rules',
        strategiesReturned: [],
        strategiesDeduplicated: [],
        llm: 'not_configured',
      },
    };
  }

  if (builtPlans.length === 0 && issues.every((issue) => issue.blocking === false)) {
    issues.push({
      code: 'no_feasible_plan',
      kind: 'constraint',
      blocking: true,
      message: '当前预算与限制下没有任何可行方案',
    });
  }

  const couponCount = builtPlans.length > 0 ? await deps.couponCount(request.storeId, orderType, beType) : 0;

  return {
    source: 'live',
    traceId,
    store: { id: menu.store.id, name: menu.store.name },
    products,
    plans: builtPlans.map((entry) => entry.plan),
    issues,
    hints,
    meta: {
      planner: 'rule-based-v2',
      pricingVerified: builtPlans.length > 0,
      menuCapturedAt: menu.capturedAt,
      couponCount,
      degraded: false,
      reasoning: 'rules',
      strategiesReturned,
      strategiesDeduplicated,
      llm: 'not_configured',
    },
  };
}

export function describeStrategies(result: MediateResult): string {
  return result.meta.strategiesReturned.map(strategyLabel).join('、');
}
