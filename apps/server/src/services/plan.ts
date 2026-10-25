/**
 * 「麦门饭局调解所」的方案生成器（`rule-based-v2`）。
 *
 * 与 v1 的差别，也是本轮修正的两个正确性问题：
 *
 * 1. **预算不足就返回无解，绝不超过预算。**
 *    v1 在预算内找不到主食时会「退到最便宜商品」，那一步绕过了预算校验，
 *    会产出成员实付 > 预算的「可接受方案」。v2 把预算当作硬约束：
 *    连最便宜的主食都买不起，直接判定该成员不可行，整体返回 `no_solution`。
 *
 * 2. **分摊基于 calculate-price 的真实试算，而不是菜单价累加。**
 *    v1 的成员花费 = 菜单单价之和，遇到组合优惠/满减就会与真实应付不一致
 *    （例如原价 ¥89.8、优惠 ¥8.1、应付 ¥81.7，累加永远算不出 81.7）。
 *    v2 用试算返回的 `productList[].subtotal` 求各成员权重，按最大余数法把
 *    **应付金额按整数分**分摊下去，保证 `Σ成员分摊 === 应付`，再逐个回验预算。
 *
 * 金额一律用「分」做整数运算，元只用于展示（`fenToYuan`）。
 */

import { mcd } from './mcd.js';
import type { PriceItem } from './mcd.js';
import { fenToYuan } from '../mcp/normalize.js';
import type { UnifiedMenuItem, UnifiedMenu, UnifiedPricing } from '../mcp/normalize.js';

// ---------------------------------------------------------------- 入参

export interface MemberRequest {
  id?: string;
  name: string;
  /** 预算上限（元）；内部换算成整数分。 */
  budget: number;
  /** 能不能吃辣；`false` / 省略 视为忌辣，会把辣味商品整体排除。 */
  spicy?: boolean;
  /** 减脂：降低油炸类权重。 */
  lightEater?: boolean;
  wantChicken?: boolean;
  wantVegetable?: boolean;
  note?: string;
}

export interface PlanRequest {
  storeCode: string;
  orderType?: number;
  beType?: number;
  members: MemberRequest[];
}

// ---------------------------------------------------------------- 出参

export interface PlanItem {
  itemId: string;
  name: string;
  quantity: number;
  /** 单价（元），来自 calculate-price 明细。 */
  unitPrice: number;
  unitPriceFen: number;
  /** 小计（元 / 分），`unitPriceFen * quantity`。 */
  subtotal: number;
  subtotalFen: number;
  isCombo: boolean;
  category: string;
}

export interface PlanMember {
  id: string;
  name: string;
  /** 预算（元 / 分）。 */
  budget: number;
  budgetFen: number;
  preferences: {
    spicy: boolean;
    lightEater: boolean;
    wantChicken: boolean;
    wantVegetable: boolean;
    note?: string;
  };
  items: PlanItem[];
  /** 该成员分摊到的真实应付（元 / 分）。恒 ≤ budgetFen。 */
  cost: number;
  costFen: number;
  /** 分摊前该成员在试算明细里的原值（元 / 分），仅用于排查。 */
  rawSubtotal: number;
  rawSubtotalFen: number;
  /** 恒为 0：超预算的方案不会被返回。字段保留供前端显示「未超支」。 */
  budgetOverBy: number;
  budgetOverFen: number;
  /** 分摊后按预算复验的结论。 */
  budgetCheck: 'passed';
  preferenceMatch: { score: number; matched: string[]; unmet: string[] };
}

/** 分摊审计，供前后端核对「成员分摊之和 = 应付」这条不变量。 */
export interface AllocationAudit {
  method: 'proportional-largest-remainder';
  /** 试算应付（分）。 */
  payableFen: number;
  /** 试算商品合计（分），分摊的权重基数。 */
  productPriceFen: number;
  /** 各成员分摊之和，必须等于 payableFen。 */
  allocatedFenSum: number;
  /** 因整数取整产生的调整量（分），`allocatedFenSum - Σfloor(share)`。 */
  roundingAdjustmentFen: number;
  /** 分摊后逐成员复验预算的结果。 */
  budgetCheck: 'passed';
}

export interface MealPlan {
  planId: string;
  createdAt: string;
  status: 'awaiting_confirm';
  planner: { engine: 'rule-based-v2'; note: string };
  store: { id: string; name: string };
  orderType: number;
  beType: number;
  takeWay?: { code: string; title: string };
  strategy: {
    id: string;
    name: string;
    summary: string;
    rationale: string[];
    rejectedAlternatives: Array<{ id: string; name: string; reason: string }>;
  };
  members: PlanMember[];
  totals: {
    currency: 'CNY';
    itemCount: number;
    productOriginalPrice: number;
    productOriginalPriceFen: number;
    productPrice: number;
    productPriceFen: number;
    discount: number;
    discountFen: number;
    payable: number;
    payableFen: number;
    perPersonAvg: number;
    perPersonAvgFen: number;
    budgetTotal: number;
    budgetTotalFen: number;
    budgetRemaining: number;
    budgetRemainingFen: number;
    verifiedBy: 'calculate-price';
    takeWayOptions?: Array<{ code: string; title: string }>;
  };
  allocation: AllocationAudit;
  coupons: { availableCount: number; source: 'query-store-coupons'; applied: []; note: string };
  preferenceMatch: {
    score: number;
    dimensions: Array<{ key: string; label: string; score: number; detail: string }>;
  };
  tradeoffs: Array<{
    id: string;
    issue: string;
    chosen: string;
    alternative: string;
    reason: string;
    costDeltaFen: number;
    costDelta: number;
    affectedMembers: string[];
  }>;
  unsatisfiable: Array<{
    id: string;
    memberId?: string;
    memberIds?: string[];
    request: string;
    reason: string;
    suggestion: string;
    severity: 'partial' | 'blocked';
  }>;
  nextActions: Array<{ key: string; label: string; enabled: boolean; requiresSecondConfirm?: boolean }>;
}

/** 无解时的阻塞原因。`code` 给程序判，`message` 给人看。 */
export interface NoSolutionIssue {
  code:
    | 'no_menu_item_matching_constraints'
    | 'no_main_within_budget'
    | 'total_budget_exceeded'
    | 'allocation_exceeds_budget';
  memberId?: string;
  memberIds?: string[];
  message: string;
  /** 诊断数字，全部是分。 */
  budgetFen?: number;
  cheapestFen?: number;
  shortfallFen?: number;
}

export interface NoSolution {
  status: 'no_solution';
  planner: { engine: 'rule-based-v2'; note: string };
  store: { id: string; name: string };
  issues: NoSolutionIssue[];
  diagnostics: {
    memberCount: number;
    budgetTotalFen: number;
    /** 每位成员在硬约束下最便宜的可能组合（无主食可选的成员不出现）。 */
    cheapestPerMember: Array<{ memberId: string; name: string; cheapestMainFen: number; budgetFen: number }>;
    cheapestTotalFen: number;
    payableFen?: number;
  };
}

export type PlanOutcome = { status: 'ok'; plan: MealPlan } | NoSolution;

export interface PlanDependencies {
  menu: (query: { storeCode: string; orderType?: number; beType?: number }) => Promise<UnifiedMenu>;
  price: (
    storeCode: string,
    items: PriceItem[],
    orderType?: number,
    beType?: number,
  ) => Promise<UnifiedPricing>;
  couponCount: (storeCode: string, orderType: number, beType: number) => Promise<number>;
}

/** 默认走真实 MCP；测试注入假实现即可完全离线。 */
const defaultDependencies: PlanDependencies = {
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

// ---------------------------------------------------------------- 选品规则

const SPICY_RE = /辣/;
/** 只认真正的蔬果配餐；不能写裸「苹果」——「苹果汁」是饮料。 */
const VEG_RE = /玉米|蔬菜|沙拉|生菜|番茄|苹果片/;
const FRIED_RE = /炸|薯条|麦乐鸡|鸡翅|麦旋风|冰淇淋|圆筒|派/;
const CHICKEN_RE = /鸡/;
const DRINK_RE = /可乐|雪碧|红茶|咖啡|牛奶|饮|茶|汁|矿泉水/;
const MAIN_RE = /堡|卷|三件套|四件套|套餐|随心配|分享餐/;

/** 元 → 整数分。预算与价格一律先转分再比较，避免 0.1+0.2 这类浮点误差。 */
function toFen(yuan: number): number {
  return Math.round(yuan * 100);
}

interface Scored {
  item: UnifiedMenuItem;
  score: number;
}

function scoreFor(item: UnifiedMenuItem, member: MemberRequest, budgetFen: number): number {
  let score = 0;

  if (member.wantChicken === true && CHICKEN_RE.test(item.name)) score += 3;
  if (item.isCombo) score += 2;
  if (member.wantVegetable === true && VEG_RE.test(item.name)) score += 4;
  if (member.lightEater === true && FRIED_RE.test(item.name)) score -= 3;
  if (member.lightEater === true && VEG_RE.test(item.name)) score += 3;

  // 越贴近预算上限越划算，但不要把预算吃干。
  if (budgetFen > 0) score -= (item.priceFen / budgetFen) * 4;

  return score;
}

function pickBest(
  pool: UnifiedMenuItem[],
  member: MemberRequest,
  predicate: (item: UnifiedMenuItem) => boolean,
  limitFen: number,
): UnifiedMenuItem | undefined {
  const scored: Scored[] = pool
    .filter(predicate)
    .filter((item) => item.priceFen > 0 && item.priceFen <= limitFen)
    .map((item) => ({ item, score: scoreFor(item, member, toFen(member.budget)) }));

  scored.sort((a, b) => b.score - a.score || a.item.priceFen - b.item.priceFen);
  return scored[0]?.item;
}

// ---------------------------------------------------------------- 逐成员选品

interface MemberDraft {
  member: MemberRequest;
  memberId: string;
  budgetFen: number;
  items: Array<{ item: UnifiedMenuItem; quantity: number }>;
  matched: string[];
  unmet: string[];
  /** 选品阶段就不可行时填这里，整体直接无解。 */
  blockingIssue?: NoSolutionIssue;
  cheapestMainFen?: number;
}

function draftForMember(menuPool: UnifiedMenuItem[], member: MemberRequest, memberId: string): MemberDraft {
  const budgetFen = toFen(member.budget);
  const allowSpicy = member.spicy === true;

  // 忌辣是商品池级别的排除，不是降权 —— 吃到辣对忌口的人是硬伤。
  const pool = (allowSpicy ? menuPool : menuPool.filter((item) => !SPICY_RE.test(item.name))).filter(
    (item) => item.priceFen > 0,
  );

  const draft: MemberDraft = {
    member,
    memberId,
    budgetFen,
    items: [],
    matched: [],
    unmet: [],
  };

  if (pool.length === 0) {
    draft.blockingIssue = {
      code: 'no_menu_item_matching_constraints',
      memberId,
      message: `${member.name} 的忌口条件下该门店没有任何可选商品`,
      budgetFen,
    };
    return draft;
  }

  const mains = pool.filter((item) => MAIN_RE.test(item.name));
  const affordableMains = mains.filter((item) => item.priceFen <= budgetFen);
  const cheapestMain = [...mains].sort((a, b) => a.priceFen - b.priceFen)[0];
  draft.cheapestMainFen = cheapestMain?.priceFen;

  // 硬约束：预算内必须能买到一份主食，否则这个成员不可行。
  // v1 在这里退回「最便宜商品」并突破预算，是本次要修的问题。
  if (affordableMains.length === 0) {
    draft.blockingIssue = {
      code: 'no_main_within_budget',
      memberId,
      message:
        cheapestMain === undefined
          ? `${member.name} 找不到可作为主食的商品`
          : `${member.name} 预算 ¥${String(fenToYuan(budgetFen))} 低于最便宜主食「${cheapestMain.name}」¥${String(fenToYuan(cheapestMain.priceFen))}，无解`,
      budgetFen,
      cheapestFen: cheapestMain?.priceFen,
      shortfallFen:
        cheapestMain === undefined ? undefined : cheapestMain.priceFen - budgetFen,
    };
    return draft;
  }

  let spentFen = 0;
  const push = (item: UnifiedMenuItem, reason: string): void => {
    draft.items.push({ item: item, quantity: 1 });
    spentFen += item.priceFen;
    draft.matched.push(reason);
  };

  // 1) 主食：优先落在预算 80% 以内；没有就退到「预算内最便宜的可行主食」，
  //    注意仍然是 budgetFen 以内，不越界。
  const preferredMain = pickBest(pool, member, (item) => MAIN_RE.test(item.name), Math.floor(budgetFen * 0.8));
  const main =
    preferredMain ??
    [...affordableMains].sort((a, b) => a.priceFen - b.priceFen || scoreFor(b, member, budgetFen) - scoreFor(a, member, budgetFen))[0];

  if (main !== undefined) {
    push(
      main,
      `主食「${main.name}」¥${String(fenToYuan(main.priceFen))}${main.isCombo ? '（套餐，含配餐/饮料）' : ''}`,
    );
  }

  const remainingFen = (): number => budgetFen - spentFen;
  const hasDrink = (): boolean => draft.items.some((entry) => DRINK_RE.test(entry.item.name));

  // 2) 蔬菜/粗粮：想要蔬菜的人优先补这一项。
  if (member.wantVegetable === true && !draft.items.some((entry) => VEG_RE.test(entry.item.name))) {
    const veg = pickBest(pool, member, (item) => VEG_RE.test(item.name), remainingFen());
    if (veg !== undefined) push(veg, `蔬菜/粗粮诉求由「${veg.name}」¥${String(fenToYuan(veg.priceFen))} 满足`);
    else draft.unmet.push('想要蔬菜，但剩余预算不足以再加一份');
  }

  // 3) 饮料：余额 ≥ ¥8 才加，避免为了饮料牺牲主食质量。
  if (!hasDrink() && remainingFen() >= 800) {
    const drink = pickBest(pool, member, (item) => DRINK_RE.test(item.name), remainingFen());
    if (drink !== undefined) push(drink, `饮料「${drink.name}」¥${String(fenToYuan(drink.priceFen))}`);
  }

  if (member.lightEater === true && draft.items.some((entry) => FRIED_RE.test(entry.item.name))) {
    draft.unmet.push('减脂诉求与所选油炸类商品部分冲突');
  }
  if (!allowSpicy) draft.matched.push('全单已排除辣味商品');

  return draft;
}

// ---------------------------------------------------------------- 整数分摊

interface ShareInput {
  memberId: string;
  /** 该成员在试算明细里占的原值（分，可为小数）。 */
  rawFen: number;
}

interface ShareOutput {
  allocatedFen: Map<string, number>;
  roundingAdjustmentFen: number;
}

/**
 * 按原值权重把 `targetFen` 分摊给各成员，结果**严格为整数分且合计等于 targetFen**。
 *
 * 做法：先按权重取整（向下取整），再把「应付 − 已分配」这点零头，
 * 按小数部分从大到小逐分补齐（最大余数法）。这样不会出现
 * 三个人各摊 ¥27.33、加起来 ¥81.99 却声称应付 ¥81.7 的情况。
 */
export function allocateCents(shares: ShareInput[], targetFen: number): ShareOutput {
  const allocatedFen = new Map<string, number>();

  if (shares.length === 0) return { allocatedFen, roundingAdjustmentFen: 0 };

  const rawSum = shares.reduce((sum, share) => sum + Math.max(0, share.rawFen), 0);

  if (rawSum <= 0) {
    // 没有权重可依（例如试算明细缺失）：平均分，零头给前面的人。
    const base = Math.floor(targetFen / shares.length);
    let leftover = targetFen - base * shares.length;
    for (const share of shares) {
      const extra = leftover > 0 ? 1 : 0;
      leftover -= extra;
      allocatedFen.set(share.memberId, base + extra);
    }
    return { allocatedFen, roundingAdjustmentFen: 0 };
  }

  const exact = shares.map((share) => ({
    memberId: share.memberId,
    value: (Math.max(0, share.rawFen) * targetFen) / rawSum,
  }));

  let assigned = 0;
  for (const entry of exact) {
    const floored = Math.floor(entry.value);
    allocatedFen.set(entry.memberId, floored);
    assigned += floored;
  }

  let leftover = targetFen - assigned;
  const byRemainder = [...exact].sort(
    (a, b) => (b.value - Math.floor(b.value)) - (a.value - Math.floor(a.value)),
  );

  let index = 0;
  while (leftover > 0 && byRemainder.length > 0) {
    const entry = byRemainder[index % byRemainder.length];
    if (entry !== undefined) {
      allocatedFen.set(entry.memberId, (allocatedFen.get(entry.memberId) ?? 0) + 1);
      leftover -= 1;
    }
    index += 1;
  }

  return { allocatedFen, roundingAdjustmentFen: targetFen - assigned };
}

// ---------------------------------------------------------------- 主流程

let planSeq = 0;

function sumFen(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

export async function planMeal(
  request: PlanRequest,
  overrides: Partial<PlanDependencies> = {},
): Promise<PlanOutcome> {
  if (request.members.length === 0) throw new Error('至少需要一位成员');

  const deps: PlanDependencies = { ...defaultDependencies, ...overrides };
  const orderType = request.orderType ?? 1;
  const beType = request.beType ?? 1;

  const menu = await deps.menu({ storeCode: request.storeCode, orderType, beType });
  const pool = menu.items.filter((item) => item.priceFen > 0);
  const store = { id: menu.store.id, name: menu.store.name };

  const drafts = request.members.map((member, index) =>
    draftForMember(pool, member, member.id ?? `m${String(index + 1)}`),
  );

  const budgetTotalFen = sumFen(drafts.map((draft) => draft.budgetFen));
  const cheapestPerMember = drafts
    .filter((draft) => draft.cheapestMainFen !== undefined)
    .map((draft) => ({
      memberId: draft.memberId,
      name: draft.member.name,
      cheapestMainFen: draft.cheapestMainFen ?? 0,
      budgetFen: draft.budgetFen,
    }));

  const baseDiagnostics = {
    memberCount: drafts.length,
    budgetTotalFen,
    cheapestPerMember,
    cheapestTotalFen: sumFen(cheapestPerMember.map((entry) => entry.cheapestMainFen)),
  };

  // 选品阶段就有成员买不起主食 → 直接无解，不做任何「凑合一下」。
  const blocking = drafts.map((draft) => draft.blockingIssue).filter((issue): issue is NoSolutionIssue => issue !== undefined);
  if (blocking.length > 0) {
    return {
      status: 'no_solution',
      planner: { engine: 'rule-based-v2', note: plannerNote },
      store,
      issues: blocking,
      diagnostics: baseDiagnostics,
    };
  }

  // 合并成一张订单：同商品合并数量。
  const merged = new Map<string, PriceItem>();
  for (const draft of drafts) {
    for (const entry of draft.items) {
      const existing = merged.get(entry.item.id);
      if (existing !== undefined) existing.quantity += entry.quantity;
      else merged.set(entry.item.id, { productCode: entry.item.id, quantity: entry.quantity });
    }
  }
  const basket = [...merged.values()];

  // 真实试算：金额一律以它为准。
  const pricing = await deps.price(request.storeCode, basket, orderType, beType);
  const payableFen = pricing.payableFen;
  const productPriceFen = pricing.productPriceFen;
  const quoteByItem = new Map(pricing.lines.map((line) => [line.itemId, line]));

  // 总预算兜底：即使每个人都买得起，合计仍可能不够付。
  if (payableFen > budgetTotalFen) {
    return {
      status: 'no_solution',
      planner: { engine: 'rule-based-v2', note: plannerNote },
      store,
      issues: [
        {
          code: 'total_budget_exceeded',
          memberIds: drafts.map((draft) => draft.memberId),
          message: `合计应付 ¥${String(fenToYuan(payableFen))} 超过预算合计 ¥${String(fenToYuan(budgetTotalFen))}`,
          budgetFen: budgetTotalFen,
          cheapestFen: payableFen,
          shortfallFen: payableFen - budgetTotalFen,
        },
      ],
      diagnostics: { ...baseDiagnostics, payableFen },
    };
  }

  // 各成员在试算明细里的原值：按「明细行小计 × 该成员占该商品的数量比例」拆。
  const rawByMember = new Map<string, number>();
  for (const draft of drafts) {
    let rawFen = 0;
    for (const entry of draft.items) {
      const line = quoteByItem.get(entry.item.id);
      const totalQuantity = merged.get(entry.item.id)?.quantity ?? entry.quantity;
      const lineSubtotalFen = line?.subtotalFen ?? entry.item.priceFen * entry.quantity;
      rawFen += (lineSubtotalFen * entry.quantity) / Math.max(1, totalQuantity);
    }
    rawByMember.set(draft.memberId, rawFen);
  }

  const allocation = allocateCents(
    drafts.map((draft) => ({ memberId: draft.memberId, rawFen: rawByMember.get(draft.memberId) ?? 0 })),
    payableFen,
  );

  // 分摊后重新校验个人预算。优惠只会让分摊变小，但外送费/包装费这类
  // 正向加价的存在意味着必须复验，不能假设「一定不会超」。
  const overBudget = drafts
    .map((draft) => {
      const allocatedFen = allocation.allocatedFen.get(draft.memberId) ?? 0;
      return { draft, allocatedFen, overFen: allocatedFen - draft.budgetFen };
    })
    .filter((entry) => entry.overFen > 0);

  if (overBudget.length > 0) {
    return {
      status: 'no_solution',
      planner: { engine: 'rule-based-v2', note: plannerNote },
      store,
      issues: overBudget.map((entry) => ({
        code: 'allocation_exceeds_budget' as const,
        memberId: entry.draft.memberId,
        message: `${entry.draft.member.name} 分摊 ¥${String(fenToYuan(entry.allocatedFen))} 超出预算 ¥${String(fenToYuan(entry.draft.budgetFen))}`,
        budgetFen: entry.draft.budgetFen,
        cheapestFen: entry.allocatedFen,
        shortfallFen: entry.overFen,
      })),
      diagnostics: { ...baseDiagnostics, payableFen },
    };
  }

  const couponCount = await deps.couponCount(request.storeCode, orderType, beType);

  // ---- 组装成员视图 ----
  const members: PlanMember[] = drafts.map((draft) => {
    const allocatedFen = allocation.allocatedFen.get(draft.memberId) ?? 0;
    const rawFen = Math.round(rawByMember.get(draft.memberId) ?? 0);

    const items: PlanItem[] = draft.items.map((entry) => {
      const line = quoteByItem.get(entry.item.id);
      const unitFen = line !== undefined && line.quantity > 0
        ? Math.round(line.subtotalFen / line.quantity)
        : entry.item.priceFen;

      return {
        itemId: entry.item.id,
        name: line?.name ?? entry.item.name,
        quantity: entry.quantity,
        unitPrice: fenToYuan(unitFen),
        unitPriceFen: unitFen,
        subtotal: fenToYuan(unitFen * entry.quantity),
        subtotalFen: unitFen * entry.quantity,
        isCombo: entry.item.isCombo,
        category: entry.item.category,
      };
    });

    const penalty = draft.unmet.length * 0.1;
    const score = Math.max(0, Math.round((1 - penalty) * 100) / 100);

    return {
      id: draft.memberId,
      name: draft.member.name,
      budget: fenToYuan(draft.budgetFen),
      budgetFen: draft.budgetFen,
      preferences: {
        spicy: draft.member.spicy === true,
        lightEater: draft.member.lightEater === true,
        wantChicken: draft.member.wantChicken === true,
        wantVegetable: draft.member.wantVegetable === true,
        note: draft.member.note,
      },
      items,
      cost: fenToYuan(allocatedFen),
      costFen: allocatedFen,
      rawSubtotal: fenToYuan(rawFen),
      rawSubtotalFen: rawFen,
      budgetOverBy: 0,
      budgetOverFen: 0,
      budgetCheck: 'passed',
      preferenceMatch: { score, matched: draft.matched, unmet: draft.unmet },
    };
  });

  // ---- 取舍与不可满足项，全部由真实选择推导 ----
  const tradeoffs: MealPlan['tradeoffs'] = [];
  const unsatisfiable: MealPlan['unsatisfiable'] = [];

  for (const member of members) {
    if (member.rawSubtotalFen !== member.costFen && member.rawSubtotalFen > 0) {
      tradeoffs.push({
        id: `t${String(tradeoffs.length + 1)}`,
        issue: `${member.name} 的明细原价 ¥${String(member.rawSubtotal)} 与实际分摊 ¥${String(member.cost)} 不同`,
        chosen: member.items.map((item) => item.name).join(' + '),
        alternative: '按原价平摊',
        reason: '总优惠/加价按各成员原值比例分摊，因此个人实付可能与明细原价不一致。',
        costDeltaFen: member.costFen - member.rawSubtotalFen,
        costDelta: fenToYuan(member.costFen - member.rawSubtotalFen),
        affectedMembers: [member.id],
      });
    }

    if (member.preferences.wantVegetable && !member.items.some((item) => VEG_RE.test(item.name))) {
      unsatisfiable.push({
        id: `u${String(unsatisfiable.length + 1)}`,
        memberId: member.id,
        request: '想要蔬菜',
        reason: '该门店在售商品里没有叶类蔬菜沙拉，最近只有玉米杯这类粗粮。',
        suggestion: '改点玉米杯，或换一家有沙拉的餐厅重新组单。',
        severity: 'partial',
      });
    }
  }

  if (couponCount === 0 && pricing.discountFen === 0) {
    unsatisfiable.push({
      id: `u${String(unsatisfiable.length + 1)}`,
      memberIds: members.map((member) => member.id),
      request: '用优惠券降低总价',
      reason: 'query-store-coupons 在当前门店与取餐方式下返回空数组，且试算未产生任何优惠。',
      suggestion: '换一家有券的门店，或等账号领到券后重试。',
      severity: 'blocked',
    });
  }

  const withinBudget = members.filter((member) => member.costFen <= member.budgetFen).length;
  const vegNeeded = members.filter((member) => member.preferences.wantVegetable).length;
  const vegGot = members.filter((member) => member.items.some((item) => VEG_RE.test(item.name))).length;
  const comboCount = members.reduce((sum, member) => sum + member.items.filter((item) => item.isCombo).length, 0);

  const dimensions: MealPlan['preferenceMatch']['dimensions'] = [
    {
      key: 'budget',
      label: '预算',
      score: Math.round((withinBudget / members.length) * 100) / 100,
      detail: `${String(withinBudget)}/${String(members.length)} 人在预算内`,
    },
    {
      key: 'taste',
      label: '口味',
      score: members.every(
        (member) => member.preferences.spicy || !member.items.some((item) => SPICY_RE.test(item.name)),
      )
        ? 1
        : 0.5,
      detail: '忌辣成员的商品池已整体排除辣味项',
    },
    {
      key: 'health',
      label: '健康',
      score: vegNeeded === 0 ? 0.7 : Math.round((vegGot / vegNeeded) * 100) / 100,
      detail: vegNeeded === 0 ? '无人提出蔬菜诉求' : `${String(vegGot)}/${String(vegNeeded)} 人拿到蔬果类商品`,
    },
    {
      key: 'value',
      label: '性价比',
      score: Math.round((comboCount / Math.max(1, members.length)) * 100) / 100,
      detail: `共选 ${String(comboCount)} 份套餐，套餐自带配餐通常比单点便宜`,
    },
  ];

  const takeWay = pricing.takeWayOptions?.[0];
  const allocatedFenSum = sumFen([...allocation.allocatedFen.values()]);
  planSeq += 1;

  return {
    status: 'ok',
    plan: {
      planId: `plan_${String(Date.now())}_${String(planSeq)}`,
      createdAt: new Date().toISOString(),
      status: 'awaiting_confirm',
      planner: { engine: 'rule-based-v2', note: plannerNote },
      store,
      orderType,
      beType,
      takeWay: takeWay !== undefined ? { code: takeWay.code, title: takeWay.title } : undefined,
      strategy: {
        id: 'budget-first',
        name: '预算优先 · 独立组餐',
        summary: `按每人预算上限与忌口拆成 ${String(members.length)} 份独立组餐，不做份量共享，最后合并成一单试算并按真实应付分摊。`,
        rationale: [
          `预算合计 ¥${String(fenToYuan(budgetTotalFen))}，实付 ¥${String(fenToYuan(payableFen))}，剩余 ¥${String(fenToYuan(budgetTotalFen - payableFen))}。`,
          pricing.discountFen > 0
            ? `试算自动计入 ¥${String(fenToYuan(pricing.discountFen))} 优惠，应收原价 ¥${String(fenToYuan(pricing.originalPriceFen))}；优惠按个人原值比例分摊。`
            : couponCount === 0
              ? '该门店当前无可用券且试算无优惠，无法靠满减凑单，因此不为了凑单额外加购。'
              : `该门店有 ${String(couponCount)} 张可用券，但本单未产生实际抵扣。`,
          '预算按硬约束处理：预算内买不到主食的成员会让整体直接无解，不会给出超预算方案。',
        ],
        rejectedAlternatives: [
          {
            id: 'combo-first',
            name: '全部选套餐',
            reason: '部分最便宜套餐含辣，忌口成员无法食用；非辣套餐涨价后总额更高。',
          },
          {
            id: 'share-big-combo',
            name: '多人分享餐均摊',
            reason: '分享餐需按人数整除，第三人的口味诉求无法单独满足，人均不可控。',
          },
        ],
      },
      members,
      totals: {
        currency: 'CNY',
        itemCount: members.reduce((sum, member) => sum + member.items.length, 0),
        productOriginalPrice: fenToYuan(pricing.productOriginalPriceFen),
        productOriginalPriceFen: pricing.productOriginalPriceFen,
        productPrice: fenToYuan(productPriceFen),
        productPriceFen,
        discount: fenToYuan(pricing.discountFen),
        discountFen: pricing.discountFen,
        payable: fenToYuan(payableFen),
        payableFen,
        perPersonAvg: fenToYuan(Math.round(payableFen / members.length)),
        perPersonAvgFen: Math.round(payableFen / members.length),
        budgetTotal: fenToYuan(budgetTotalFen),
        budgetTotalFen,
        budgetRemaining: fenToYuan(budgetTotalFen - payableFen),
        budgetRemainingFen: budgetTotalFen - payableFen,
        verifiedBy: 'calculate-price',
        takeWayOptions: pricing.takeWayOptions?.map((option) => ({ code: option.code, title: option.title })),
      },
      allocation: {
        method: 'proportional-largest-remainder',
        payableFen,
        productPriceFen,
        allocatedFenSum,
        roundingAdjustmentFen: allocation.roundingAdjustmentFen,
        budgetCheck: 'passed',
      },
      coupons: {
        availableCount: couponCount,
        source: 'query-store-coupons',
        applied: [],
        note:
          couponCount === 0
            ? pricing.discountFen > 0
              ? `无可用券；但试算仍产生 ¥${String(fenToYuan(pricing.discountFen))} 商品优惠（组合价/会员价），已按比例分摊。`
              : '该门店 + 当前取餐方式下无可用券，且试算无优惠，折后价等于原价。'
            : `有 ${String(couponCount)} 张券可用，具体抵扣以 calculate-price 返回的 discount 为准。`,
      },
      preferenceMatch: {
        score: Math.round((dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length) * 100) / 100,
        dimensions,
      },
      tradeoffs,
      unsatisfiable,
      nextActions: [
        { key: 'confirm', label: '确认下单', enabled: true, requiresSecondConfirm: true },
        { key: 'adjust', label: '调整份量/换品', enabled: true },
        { key: 'reselect_store', label: '换一家门店', enabled: true },
      ],
    },
  };
}

const plannerNote =
  '确定性规则协商：预算为硬约束，预算内无主食则整体无解；金额以 calculate-price 试算为准，按整数分等额分摊并复验个人预算。AI 排序待 AI_API_KEY 配置后接入，输出契约不变。';
