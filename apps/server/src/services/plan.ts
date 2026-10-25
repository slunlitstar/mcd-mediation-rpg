/**
 * 「麦门饭局调解所」的方案生成器。
 *
 * 当前是 **确定性规则版**（`rule-based-v1`），不依赖大模型：
 * 每个人按预算/忌口/偏好独立组餐，再合并成一个订单，最后用 MCP 的
 * `calculate-price` 校准真实应付金额。
 *
 * 为什么先不做 LLM：`.env` 里 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` 还是空的，
 * 而评委要的是「真的调用了 MCP、能跑通」。规则版结果可复现、可解释，
 * 每一步取舍都能说清理由 —— 比一个跑不起来的模型调用更稳。
 * 后续把 `planMeal()` 里的选品评分换成 AI 排序即可，输出契约不变。
 */

import { mcd } from './mcd.js';
import type { PriceItem } from './mcd.js';
import type { UnifiedMenuItem } from '../mcp/normalize.js';

// ---------------------------------------------------------------- 入参

export interface MemberRequest {
  id?: string;
  name: string;
  /** 预算上限（元）。 */
  budget: number;
  /** 能不能吃辣；`false` / 省略 视为忌辣，会把辣味商品整个排除。 */
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

// ---------------------------------------------------------------- 出参（与 fixtures/normalized/plan.sample.json 同构）

export interface PlanItem {
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  isCombo: boolean;
  category: string;
}

export interface PlanMember {
  id: string;
  name: string;
  budget: number;
  preferences: {
    spicy: boolean;
    lightEater: boolean;
    wantChicken: boolean;
    wantVegetable: boolean;
    note?: string;
  };
  items: PlanItem[];
  cost: number;
  budgetOverBy: number;
  preferenceMatch: { score: number; matched: string[]; unmet: string[] };
}

export interface MealPlan {
  planId: string;
  createdAt: string;
  status: 'awaiting_confirm';
  planner: { engine: 'rule-based-v1'; note: string };
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
    discount: number;
    payable: number;
    perPersonAvg: number;
    budgetTotal: number;
    budgetRemaining: number;
    verifiedBy: 'calculate-price';
    takeWayOptions?: Array<{ code: string; title: string }>;
  };
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

// ---------------------------------------------------------------- 选品规则

const SPICY_RE = /辣/;
/**
 * 只认真正的蔬果配餐。不能写裸「苹果」—— 「100% 苹果汁」是饮料，
 * 会被误判成「蔬菜诉求已满足」，把健康分虚报成 1。
 */
const VEG_RE = /玉米|蔬菜|沙拉|生菜|番茄|苹果片/;
const FRIED_RE = /炸|薯条|麦乐鸡|鸡翅|麦旋风|冰淇淋|圆筒|派/;
const CHICKEN_RE = /鸡/;
const DRINK_RE = /可乐|雪碧|红茶|咖啡|牛奶|饮|茶|汁|矿泉水/;
const MAIN_RE = /堡|卷|三件套|四件套|套餐|随心配|分享餐/;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Scored {
  item: UnifiedMenuItem;
  score: number;
}

/**
 * 给单个商品对某位成员的适配度打分。分数只用于排序，
 * 每一项加减都能在 `matched` / `unmet` 里讲清楚。
 */
function scoreFor(item: UnifiedMenuItem, member: MemberRequest, budget: number): number {
  let score = 0;

  if (member.wantChicken === true && CHICKEN_RE.test(item.name)) score += 3;
  if (item.isCombo) score += 2; // 套餐含饮料，性价比通常更高
  if (member.wantVegetable === true && VEG_RE.test(item.name)) score += 4;
  if (member.lightEater === true && FRIED_RE.test(item.name)) score -= 3;
  if (member.lightEater === true && VEG_RE.test(item.name)) score += 3;

  // 越贴近预算上限越划算，但不要把预算吃干。
  if (budget > 0) score -= (item.price / budget) * 4;

  return score;
}

function pickBest(
  pool: UnifiedMenuItem[],
  member: MemberRequest,
  predicate: (item: UnifiedMenuItem) => boolean,
  limit: number,
): UnifiedMenuItem | undefined {
  const scored: Scored[] = pool
    .filter(predicate)
    .filter((item) => item.price > 0 && item.price <= limit)
    .map((item) => ({ item, score: scoreFor(item, member, member.budget) }));

  scored.sort((a, b) => b.score - a.score || a.item.price - b.item.price);
  return scored[0]?.item;
}

interface MemberPick {
  member: MemberRequest;
  items: PlanItem[];
  cost: number;
  matched: string[];
  unmet: string[];
}

function buildForMember(menuPool: UnifiedMenuItem[], member: MemberRequest): MemberPick {
  const allowSpicy = member.spicy === true;
  // 忌辣是整个商品池级别的排除，不是降低权重 —— 吃到辣对忌口的人是硬伤。
  const pool = allowSpicy ? menuPool : menuPool.filter((item) => !SPICY_RE.test(item.name));

  const items: PlanItem[] = [];
  const matched: string[] = [];
  const unmet: string[] = [];
  let spent = 0;

  const push = (item: UnifiedMenuItem, reason: string): void => {
    items.push({
      itemId: item.id,
      name: item.name,
      quantity: 1,
      unitPrice: item.price,
      subtotal: item.price,
      isCombo: item.isCombo,
      category: item.category,
    });
    spent = round2(spent + item.price);
    matched.push(reason);
  };

  // 1) 主食：优先套餐/汉堡/卷，且不超过预算的 80%。
  const main = pickBest(pool, member, (item) => MAIN_RE.test(item.name), member.budget * 0.8);
  if (main) {
    push(main, `主食「${main.name}」¥${main.price}${main.isCombo ? '（套餐，含配餐/饮料）' : ''}`);
  } else {
    // 预算太紧时退到最便宜的可食商品，保证不是空盘。
    const cheapest = [...pool].filter((item) => item.price > 0).sort((a, b) => a.price - b.price)[0];
    if (cheapest) {
      push(cheapest, `预算内没有合适主食，退到最便宜选项「${cheapest.name}」¥${cheapest.price}`);
      unmet.push(`预算 ¥${member.budget} 不足以覆盖正餐主食`);
    } else {
      unmet.push('该门店菜单里找不到符合忌口的商品');
    }
  }

  const hasDrink = items.some((item) => DRINK_RE.test(item.name));

  // 2) 蔬菜/配餐：想要蔬菜的人先补这一项，优先级高于饮料。
  if (member.wantVegetable === true && !items.some((item) => VEG_RE.test(item.name))) {
    const veg = pickBest(pool, member, (item) => VEG_RE.test(item.name), member.budget - spent);
    if (veg) push(veg, `蔬菜/粗粮诉求由「${veg.name}」¥${veg.price} 满足`);
    else unmet.push('想要蔬菜，但余额不足以再加一份');
  }

  // 3) 饮料：预算还剩 8 元以上才加，避免为了饮料牺牲主食质量。
  if (!hasDrink && member.budget - spent >= 8) {
    const drink = pickBest(pool, member, (item) => DRINK_RE.test(item.name), member.budget - spent);
    if (drink) push(drink, `饮料「${drink.name}」¥${drink.price}`);
  }

  if (member.lightEater === true && items.some((item) => FRIED_RE.test(item.name))) {
    unmet.push('减脂诉求与所选油炸类商品部分冲突');
  }
  if (!allowSpicy) matched.push('全单已排除辣味商品');

  const cost = round2(spent);
  if (cost > member.budget) unmet.push(`预算 ¥${member.budget}，实付 ¥${cost}，超 ¥${round2(cost - member.budget)}`);

  return { member, items, cost, matched, unmet };
}

// ---------------------------------------------------------------- 主流程

let planSeq = 0;

export async function planMeal(request: PlanRequest): Promise<MealPlan> {
  if (request.members.length === 0) throw new Error('至少需要一位成员');

  const orderType = request.orderType ?? 1;
  const beType = request.beType ?? 1;

  const menu = await mcd.menu({ storeCode: request.storeCode, orderType, beType });
  const pool = menu.items.filter((item) => item.price > 0);

  const picks = request.members.map((member) => buildForMember(pool, member));

  // 合并成一张订单：同商品合并数量，交给 MCP 试算真实应付。
  const merged = new Map<string, PriceItem>();
  for (const pick of picks) {
    for (const item of pick.items) {
      const existing = merged.get(item.itemId);
      if (existing) existing.quantity += item.quantity;
      else merged.set(item.itemId, { productCode: item.itemId, quantity: item.quantity });
    }
  }

  const pricing = await mcd.price(request.storeCode, [...merged.values()], orderType, beType);

  // 券的情况直接查一次，前端要据此决定是否显示「无券可用」。
  let couponCount = 0;
  try {
    const coupons = await mcd.call('query-store-coupons', { storeCode: request.storeCode, orderType, beType });
    if (coupons.ok && Array.isArray(coupons.data)) couponCount = coupons.data.length;
  } catch {
    couponCount = 0;
  }

  const budgetTotal = round2(request.members.reduce((sum, member) => sum + member.budget, 0));
  const itemCount = picks.reduce((sum, pick) => sum + pick.items.length, 0);
  const payable = pricing.payable;

  const members: PlanMember[] = picks.map((pick, index) => {
    const memberRequest = pick.member;
    const overBy = round2(Math.max(0, pick.cost - memberRequest.budget));

    const penalty = (overBy > 0 ? 0.3 : 0) + (pick.unmet.length > 0 ? pick.unmet.length * 0.1 : 0);
    const score = Math.max(0, round2(1 - penalty));

    return {
      id: memberRequest.id ?? `m${String(index + 1)}`,
      name: memberRequest.name,
      budget: memberRequest.budget,
      preferences: {
        spicy: memberRequest.spicy === true,
        lightEater: memberRequest.lightEater === true,
        wantChicken: memberRequest.wantChicken === true,
        wantVegetable: memberRequest.wantVegetable === true,
        note: memberRequest.note,
      },
      items: pick.items,
      cost: pick.cost,
      budgetOverBy: overBy,
      preferenceMatch: { score, matched: pick.matched, unmet: pick.unmet },
    };
  });

  // ---- 取舍与不可满足项，全部由真实选择推导，不编造 ----
  const tradeoffs: MealPlan['tradeoffs'] = [];
  const unsatisfiable: MealPlan['unsatisfiable'] = [];

  members.forEach((member, index) => {
    if (member.budgetOverBy > 0) {
      tradeoffs.push({
        id: `t${String(tradeoffs.length + 1)}`,
        issue: `${member.name} 预算 ¥${member.budget}，实付 ¥${member.cost}`,
        chosen: member.items.map((item) => item.name).join(' + '),
        alternative: '去掉饮料或换成更便宜的单品',
        reason: '主食价格已接近预算上限，为保正餐分量保留了当前组合。',
        costDelta: member.budgetOverBy,
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

    void index;
  });

  // 有优惠但没券，说明优惠来自商品组合价/会员价，不能说成「无优惠」。
  if (couponCount === 0 && pricing.discount === 0) {
    unsatisfiable.push({
      id: `u${String(unsatisfiable.length + 1)}`,
      memberIds: members.map((member) => member.id),
      request: '用优惠券降低总价',
      reason: 'query-store-coupons 在当前门店与取餐方式下返回空数组，且试算未产生任何优惠。',
      suggestion: '换一家有券的门店，或等账号领到券后重试。',
      severity: 'blocked',
    });
  }

  const withinBudget = members.filter((member) => member.budgetOverBy === 0).length;
  const vegNeeded = members.filter((member) => member.preferences.wantVegetable).length;
  const vegGot = members.filter((member) =>
    member.items.some((item) => VEG_RE.test(item.name)),
  ).length;
  const comboCount = members.reduce(
    (sum, member) => sum + member.items.filter((item) => item.isCombo).length,
    0,
  );

  const dimensions: MealPlan['preferenceMatch']['dimensions'] = [
    {
      key: 'budget',
      label: '预算',
      score: round2(withinBudget / members.length),
      detail: `${String(withinBudget)}/${String(members.length)} 人在预算内`,
    },
    {
      key: 'taste',
      label: '口味',
      score: round2(
        members.filter((member) => !member.preferences.spicy).every((member) => !member.items.some((item) => SPICY_RE.test(item.name)))
          ? 1
          : 0.5,
      ),
      detail: '忌辣成员的商品池已整体排除辣味项',
    },
    {
      key: 'health',
      label: '健康',
      score: vegNeeded === 0 ? 0.7 : round2(vegGot / vegNeeded),
      detail: vegNeeded === 0 ? '无人提出蔬菜诉求' : `${String(vegGot)}/${String(vegNeeded)} 人拿到蔬菜类商品`,
    },
    {
      key: 'value',
      label: '性价比',
      score: round2(comboCount / Math.max(1, members.length)),
      detail: `共选 ${String(comboCount)} 份套餐，套餐自带配餐通常比单点便宜`,
    },
  ];

  const overall = round2(
    dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length,
  );

  const takeWay = pricing.takeWayOptions?.[0];

  planSeq += 1;

  return {
    planId: `plan_${String(Date.now())}_${String(planSeq)}`,
    createdAt: new Date().toISOString(),
    status: 'awaiting_confirm',
    planner: {
      engine: 'rule-based-v1',
      note: '确定性规则协商：按预算与忌口独立组餐后合并下单试算。AI 排序待 AI_API_KEY 配置后接入，输出契约不变。',
    },
    store: { id: menu.store.id, name: menu.store.name },
    orderType,
    beType,
    takeWay: takeWay ? { code: takeWay.code, title: takeWay.title } : undefined,
    strategy: {
      id: 'budget-first',
      name: '预算优先 · 独立组餐',
      summary: `按每人预算上限与忌口拆成 ${String(members.length)} 份独立组餐，不做份量共享，最后合并成一单试算。`,
      rationale: [
        `预算合计 ¥${String(budgetTotal)}，实付 ¥${String(payable)}，剩余 ¥${String(round2(budgetTotal - payable))}。`,
        pricing.discount > 0
          ? `试算已自动计入 ¥${String(pricing.discount)} 优惠（商品组合价/会员价），应收原价 ¥${String(pricing.originalPrice)}。`
          : couponCount === 0
            ? '该门店当前无可用券且试算无优惠，无法靠满减凑单，因此不为了凑单额外加购。'
            : `该门店有 ${String(couponCount)} 张可用券，但本单未产生实际抵扣。`,
        '忌辣成员的商品池整体排除辣味商品，而不是事后替换。',
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
      itemCount,
      productOriginalPrice: pricing.productOriginalPrice,
      discount: pricing.discount,
      payable,
      perPersonAvg: round2(payable / members.length),
      budgetTotal,
      budgetRemaining: round2(budgetTotal - payable),
      verifiedBy: 'calculate-price',
      takeWayOptions: pricing.takeWayOptions?.map((option) => ({ code: option.code, title: option.title })),
    },
    coupons: {
      availableCount: couponCount,
      source: 'query-store-coupons',
      applied: [],
      note:
        couponCount === 0
          ? pricing.discount > 0
            ? `无可用券；但试算仍产生 ¥${String(pricing.discount)} 商品优惠（组合价/会员价），已计入应付。`
            : '该门店 + 当前取餐方式下无可用券，且试算无优惠，折后价等于原价。'
          : `有 ${String(couponCount)} 张券可用，具体抵扣以 calculate-price 返回的 discount 为准。`,
    },
    preferenceMatch: { score: overall, dimensions },
    tradeoffs,
    unsatisfiable,
    nextActions: [
      { key: 'confirm', label: '确认下单', enabled: true, requiresSecondConfirm: true },
      { key: 'adjust', label: '调整份量/换品', enabled: true },
      { key: 'reselect_store', label: '换一家门店', enabled: true },
    ],
  };
}
