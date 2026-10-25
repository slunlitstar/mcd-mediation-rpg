/**
 * 麦当劳 MCP 原始返回 → 前端统一格式的转换层。
 *
 * 设计原则（对应 docs/mcp-data-shapes.md 的实测结论）：
 *
 * 1. **前端永远不接触 MCP 的 `structuredContent` 信封**。那层 `{success, code, message,
 *    datetime, traceId, data}` 只在服务端判定成败，出接口前剥掉。
 * 2. **金额双写**：`price` 是元（number，便于展示），`priceFen` 是分（int，便于计算）。
 *    MCP 内部有两套单位 —— `calculate-price` 给分，`query-meals` 给元字符串，
 *    在这里统一，前端不用记这件事。
 * 3. **`query-meals` 的 `categories` 与 `meals` 必须 join**：分类里只有 `{code, tags}`，
 *    名称/价格全在 `meals` 字典里（`Record<string, Meal>`，不是数组）。
 * 4. **`isCombo` 带溯源**：不猜死。优先用 `query-meal-detail` 的 `rounds`（唯一真凭据），
 *    其次看标签/名称关键词，都没有就 `default` + `false`，并且 `isComboSource`
 *    会告诉调用方这个判定有多可靠。
 */

// ---------------------------------------------------------------- 统一格式类型

/** 门店。`id` 即 MCP 的 `storeCode`。 */
export interface UnifiedStore {
  id: string;
  name: string;
  address?: string;
  /** 是否营业中；`false` 时门店相关工具需要带 `reservationDate` 走预约链路。 */
  businessStatus?: boolean;
  /** `06:00-22:00` 形式，缺一边则为 undefined。 */
  businessHours?: string;
  /** 原样透传 MCP 的排序用数值，单位未在文档中明确，不要当米用。 */
  distance?: number;
}

/** `isCombo` 的判定依据，决定前端能不能拿它做「套餐/单点」的分区展示。 */
export type ComboSource = 'detail' | 'tag' | 'name' | 'default';

/** 菜单单品。 */
export interface UnifiedMenuItem {
  id: string;
  name: string;
  /** 现价，单位元。 */
  price: number;
  /** 现价，单位分（int）。计算一律用它，避免浮点误差。 */
  priceFen: number;
  /** 原价，单位元；无划线价时不返回。 */
  originalPrice?: number;
  originalPriceFen?: number;
  /** 主分类名（多分类时取第一个）。 */
  category: string;
  /** 全部分类名，商品可能同时属于早餐/超值两组。 */
  categories: string[];
  isCombo: boolean;
  isComboSource: ComboSource;
  /** 是否随单购（`canWithOrder`），缺省按 false。 */
  canWithOrder: boolean;
  tags: string[];
  image?: string;
  combo?: { verified: boolean; components: { id: string; name: string; quantity: number }[]; roundList: { round: string; comboItemList: { code: string; quantity: number }[] }[] };
}

/** 菜单接口的统一返回。 */
export interface UnifiedMenu {
  store: Pick<UnifiedStore, 'id' | 'name'>;
  /** 固定 'CNY'，前端不需要做币种判断。 */
  currency: 'CNY';
  /** 固定 'yuan'，声明 `price` 的单位是元。 */
  priceUnit: 'yuan';
  orderType: number;
  beType: number;
  capturedAt: string;
  /** 分类名按 MCP 原始顺序保留，前端可直接渲染 tab。 */
  categories: string[];
  items: UnifiedMenuItem[];
  /** 数据质量提示，前端可据此显示「部分商品分类待确认」之类的文案。 */
  meta: {
    itemCount: number;
    comboCount: number;
    /** 被 `query-meal-detail` 证实过是否为套餐的商品数。 */
    comboVerifiedCount: number;
    /** 只出现在 `meals` 字典、未挂任何分类的商品（正常应为空）。 */
    orphanCount: number;
  };
}

/** 计价明细行。 */
export interface UnifiedPriceLine {
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  unitPriceFen: number;
  originalSubtotal: number;
  originalSubtotalFen: number;
  subtotal: number;
  subtotalFen: number;
}

/** `calculate-price` 的统一返回。 */
export interface UnifiedPricing {
  store: Pick<UnifiedStore, 'id' | 'name'>;
  currency: 'CNY';
  priceUnit: 'yuan';
  lines: UnifiedPriceLine[];
  /** 商品原价合计（分 / 元）。 */
  productOriginalPrice: number;
  productOriginalPriceFen: number;
  /** 商品现价合计。 */
  productPrice: number;
  productPriceFen: number;
  /** 优惠前应付。 */
  originalPrice: number;
  originalPriceFen: number;
  /** 优惠金额，正数表示省了多少。 */
  discount: number;
  discountFen: number;
  /** 实付。**这才是要展示的金额**，`productPrice` 不等于它。 */
  payable: number;
  payableFen: number;
  /** 取餐方式；`code` 就是下单时要的 `takeWayCode`。 */
  takeWayOptions?: Array<{ code: string; title: string; subtitle?: string }>;
}

// ---------------------------------------------------------------- 金额工具

const PRICE_RE = /-?\d+(?:\.\d+)?/;

/** `"29.9"` / `29.9` / `"¥29.90"` → 分。无法解析时返回 undefined。 */
export function toFen(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value !== 'string') return undefined;

  const matched = PRICE_RE.exec(value.replace(/,/g, ''));
  if (!matched) return undefined;

  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
}

/** 分 → 元，保留两位小数（用于展示字段，计算请用分）。 */
export function fenToYuan(fen: number): number {
  return Math.round(fen) / 100;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * MCP 的分类名是为「两行显示」设计的，带真实的换行符，例如
 * `巨无霸\n牛鱼肉堡`、`小食拼盘\n/多人餐`、`500\n大卡套餐`。
 * 直接渲染会在前端 UI 里断行，所以这里合成单行：
 *
 * - 后半段以标点/数字开头（`/多人餐`、`1+1`、`大卡套餐` 里的数字场景靠前半段判断）
 *   或前半段纯数字 → 直接拼接，不插分隔符；
 * - 其余（两个词并排）→ 用 `·` 连接，保留语义分隔。
 */
export function joinWrappedLabel(raw: string): string {
  const parts = raw.split(/\s*[\r\n]+\s*/).filter((part) => part.length > 0);
  if (parts.length <= 1) return raw.trim();

  return parts.reduce((acc, part, index) => {
    if (index === 0) return part;
    const before = parts[index - 1] ?? '';
    const glue = /^[/、·,，.]/.test(part) || /^\d/.test(part) || /^\d+$/.test(before) ? '' : '·';
    return `${acc}${glue}${part}`;
  }, '');
}

// ---------------------------------------------------------------- 门店

/** `query-nearby-stores` / `delivery-query-stores` 的 `data` → 门店数组。 */
export function normalizeStores(data: unknown): UnifiedStore[] {
  const stores: UnifiedStore[] = [];

  for (const item of asArray(data)) {
    const record = asRecord(item);
    if (!record) continue;

    const id = asString(record.storeCode);
    if (!id) continue;

    const start = asString(record.businessStartTime);
    const end = asString(record.businessEndTime);

    stores.push({
      id,
      name: asString(record.storeName) ?? id,
      address: asString(record.address),
      businessStatus:
        typeof record.businessStatus === 'boolean' ? record.businessStatus : undefined,
      businessHours: start && end ? `${start}-${end}` : undefined,
      distance: typeof record.distance === 'number' ? record.distance : undefined,
    });
  }

  return stores;
}

// ---------------------------------------------------------------- 菜品分类判定

const COMBO_TAG_RE = /套餐|组合|超值|双人|单人餐|全家|桶/;
const COMBO_NAME_RE = /套餐|组合|超值|双人|单人餐|全家|桶/;

/**
 * 从 `query-meal-detail` 的返回判断是否套餐。
 *
 * 真凭据：`data.rounds` 非空 —— 套餐才需要「选小食 / 选饮料」这类轮次，
 * 单点商品的 `rounds` 为空或缺失。
 */
export function isComboFromDetail(detailData: unknown): boolean | undefined {
  const record = asRecord(detailData);
  if (!record) return undefined;
  if (!Array.isArray(record.rounds)) return undefined;
  return record.rounds.length > 0;
}

/** 没有 detail 时的降级判定：标签优先于名称。 */
export function guessCombo(
  tags: string[],
  name: string,
): { isCombo: boolean; source: ComboSource } {
  if (tags.some((tag) => COMBO_TAG_RE.test(tag))) return { isCombo: true, source: 'tag' };
  if (COMBO_NAME_RE.test(name)) return { isCombo: true, source: 'name' };
  return { isCombo: false, source: 'default' };
}

// ---------------------------------------------------------------- 菜单

export interface NormalizeMenuInput {
  store: Pick<UnifiedStore, 'id' | 'name'>;
  /** `query-meals` 的 `data` 原文。 */
  mealsData: unknown;
  orderType: number;
  beType: number;
  /** 商品编码 → `query-meal-detail` 的 `data`，用于证实 isCombo。 */
  details?: Record<string, unknown>;
  capturedAt?: string;
}

/**
 * `query-meals` 的 `data` → 统一菜单。
 *
 * 原始结构：
 *   { categories: [{ name, meals: [{ code, tags }] }], meals: Record<code, Meal> }
 *
 * 注意 `meals` 是**动态字典**而不是数组；`categories[].meals[]` 里没有名称和价格，
 * 必须按 code join 一次。
 */
export function normalizeMenu(input: NormalizeMenuInput): UnifiedMenu {
  const record = asRecord(input.mealsData);
  const mealDict = asRecord(record?.meals) ?? {};
  const details = input.details ?? {};

  const categories: string[] = [];
  const tagsByCode = new Map<string, string[]>();
  const categoriesByCode = new Map<string, string[]>();

  for (const categoryRaw of asArray(record?.categories)) {
    const category = asRecord(categoryRaw);
    if (!category) continue;

    const rawName = asString(category.name);
    if (!rawName) continue;
    const name = joinWrappedLabel(rawName);

    if (!categories.includes(name)) categories.push(name);

    for (const mealRaw of asArray(category.meals)) {
      const meal = asRecord(mealRaw);
      const code = asString(meal?.code);
      if (!code) continue;

      const tags = asArray(meal?.tags).filter((tag): tag is string => typeof tag === 'string');
      if (tags.length > 0) tagsByCode.set(code, tags);

      const bucket = categoriesByCode.get(code) ?? [];
      if (!bucket.includes(name)) bucket.push(name);
      categoriesByCode.set(code, bucket);
    }
  }

  const items: UnifiedMenuItem[] = [];
  let comboCount = 0;
  let comboVerifiedCount = 0;
  let orphanCount = 0;

  // 以 meals 字典为准遍历：categories 里出现但字典里没有的 code 无法渲染，跳过。
  for (const [code, mealRaw] of Object.entries(mealDict)) {
    const meal = asRecord(mealRaw);
    if (!meal) continue;

    const name = joinWrappedLabel(asString(meal.name) ?? code);
    const priceFen = toFen(meal.currentPrice) ?? 0;
    const originalFen = toFen(meal.originalPrice);

    const tags = tagsByCode.get(code) ?? [];
    const itemCategories = categoriesByCode.get(code) ?? [];
    if (itemCategories.length === 0) orphanCount += 1;

    const verified = isComboFromDetail(details[code]);
    const guess = guessCombo(tags, name);
    const isCombo = verified ?? guess.isCombo;
    const source: ComboSource = verified === undefined ? guess.source : 'detail';

    if (verified !== undefined) comboVerifiedCount += 1;
    if (isCombo) comboCount += 1;

    items.push({
      id: code,
      name,
      price: fenToYuan(priceFen),
      priceFen,
      originalPrice: originalFen === undefined ? undefined : fenToYuan(originalFen),
      originalPriceFen: originalFen,
      category: itemCategories[0] ?? '未分类',
      categories: itemCategories,
      isCombo,
      isComboSource: source,
      canWithOrder: meal.canWithOrder === true,
      tags,
      image: asString(meal.image),
    });
  }

  return {
    store: { id: input.store.id, name: input.store.name },
    currency: 'CNY',
    priceUnit: 'yuan',
    orderType: input.orderType,
    beType: input.beType,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    categories,
    items,
    meta: {
      itemCount: items.length,
      comboCount,
      comboVerifiedCount,
      orphanCount,
    },
  };
}

// ---------------------------------------------------------------- 计价

export interface NormalizePricingInput {
  store: Pick<UnifiedStore, 'id' | 'name'>;
  /** `calculate-price` 的 `data` 原文。金额单位是**分**。 */
  priceData: unknown;
}

/** `calculate-price` 的 `data` → 统一计价。 */
export function normalizePricing(input: NormalizePricingInput): UnifiedPricing {
  const record = asRecord(input.priceData) ?? {};

  const lines: UnifiedPriceLine[] = asArray(record.productList).flatMap((lineRaw) => {
    const line = asRecord(lineRaw);
    const itemId = asString(line?.productCode);
    if (!line || !itemId) return [];

    const subtotalFen = typeof line.subtotal === 'number' ? line.subtotal : 0;
    const originalSubtotalFen =
      typeof line.originalSubtotal === 'number' ? line.originalSubtotal : subtotalFen;
    const quantity = typeof line.quantity === 'number' ? line.quantity : 1;
    const unitFen = quantity > 0 ? Math.round(subtotalFen / quantity) : subtotalFen;

    return [
      {
        itemId,
        name: asString(line.productName) ?? itemId,
        quantity,
        unitPrice: fenToYuan(unitFen),
        unitPriceFen: unitFen,
        originalSubtotal: fenToYuan(originalSubtotalFen),
        originalSubtotalFen,
        subtotal: fenToYuan(subtotalFen),
        subtotalFen,
      },
    ];
  });

  const int = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;

  const productPriceFen = int(record.productPrice, 0);
  const payableFen = int(record.price, productPriceFen);
  const originalPriceFen = int(record.originalPrice, productPriceFen);
  const discountFen = int(record.discount, Math.max(0, originalPriceFen - payableFen));

  const takeWay = asArray(record.takeWayList).flatMap((optionRaw) => {
    const option = asRecord(optionRaw);
    const code = asString(option?.code);
    if (!option || !code) return [];
    return [
      {
        code,
        title: asString(option.title) ?? code,
        subtitle: asString(option.subtitle),
      },
    ];
  });

  return {
    store: { id: input.store.id, name: input.store.name },
    currency: 'CNY',
    priceUnit: 'yuan',
    lines,
    productOriginalPrice: fenToYuan(int(record.productOriginalPrice, 0)),
    productOriginalPriceFen: int(record.productOriginalPrice, 0),
    productPrice: fenToYuan(productPriceFen),
    productPriceFen,
    originalPrice: fenToYuan(originalPriceFen),
    originalPriceFen,
    discount: fenToYuan(discountFen),
    discountFen,
    payable: fenToYuan(payableFen),
    payableFen,
    takeWayOptions: takeWay.length > 0 ? takeWay : undefined,
  };
}
