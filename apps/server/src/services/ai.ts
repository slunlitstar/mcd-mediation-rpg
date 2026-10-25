/**
 * 真实模型接入层：**模型只提方案，不碰钱**。
 *
 * 这一层刻意做得「不聪明」——它唯一的职责是把真实菜单和真实成员需求发给模型，
 * 拿回一份结构化选择，然后**逐条校验**。所有金额、优惠、分摊都不从这里出：
 * 那些必须走 `calculate-price` 真实试算（见 `mediate.ts` 的 `buildPlan`）。
 *
 * 四道门，缺一不可：
 *
 * 1. **配置**：`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` 三个都填了才算配置，
 *    只填 key 不算接入（`llm: not_configured`）。
 * 2. **结构**：模型必须返回 `{ allocations: [{ memberId, items: [{ productId, quantity }] }] }`，
 *    任何 free-form 文本都算失败。
 * 3. **语义**：商品 ID 必须真实存在、不是蘸酱/周边、不违反 `dislikes` 与食材要求、
 *    数量为 1–3 的整数、按菜单价预检不超预算。**模型返回的价格一律丢弃**。
 * 4. **金额**：校验通过也不代表能下单，还要回 `mediate.ts` 走真实计价 + 整数分摊 + 预算复验。
 *
 * 任何一道门失败都返回带 code 的错误，由调用方降级到 `rule-based-v2`，
 * 绝不把模型的猜测当结果交给前端。
 */

// ---------------------------------------------------------------- 配置

export interface AiConfig {
  /** 已归一化到 `/chat/completions` 的完整地址。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** 把 `https://host/v1` 和 `https://host/v1/chat/completions` 都归一化到后者。 */
export function normalizeChatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

/**
 * 读模型配置。三项齐全才返回配置，否则 `null`。
 *
 * 刻意不做「有 key 就认为接入了」的判断：缺 base URL 时会静默打到官方端点，
 * 缺 model 时会拿到网关默认模型，两种都会让「模型已接入」变成假话。
 */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig | null {
  const baseUrl = (env.AI_BASE_URL ?? '').trim();
  const apiKey = (env.AI_API_KEY ?? '').trim();
  const model = (env.AI_MODEL ?? '').trim();

  if (baseUrl === '' || apiKey === '' || model === '') return null;

  const rawTimeout = Number.parseInt((env.AI_TIMEOUT_MS ?? '').trim(), 10);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;

  return { baseUrl: normalizeChatEndpoint(baseUrl), apiKey, model, timeoutMs };
}

/** 日志/接口里显示模型标识时用它，永远不要输出 key。 */
export function describeAiConfig(config: AiConfig | null): string {
  return config === null ? 'not_configured' : config.model;
}

// ---------------------------------------------------------------- 错误

export type AiErrorCode =
  | 'model_not_configured'
  | 'model_http_error'
  | 'model_timeout'
  | 'model_invalid_json'
  | 'model_invalid_shape';

export class AiError extends Error {
  public readonly code: AiErrorCode;

  public readonly detail?: Record<string, unknown>;

  public constructor(code: AiErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- 模型输入

export interface ProposalMember {
  id: number;
  budgetCents: number;
  hunger: string;
  likes: string[];
  dislikes: string[];
  requirement: string;
  customRequirement?: string;
}

export interface ProposalCandidate {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  hasMain?: boolean;
  includedCategories?: string[];
  isCombo?: boolean;
}

export interface ProposalRequest {
  storeName: string;
  /** 本次要模型同时给出的策略，一次请求返回全部，避免三倍调用量撞限流。 */
  strategies: string[];
  members: ProposalMember[];
  candidates: ProposalCandidate[];
  /** 这一份方案里不能动的成员（复议时锁定），模型不得改动。 */
  lockedMemberIds?: number[];
}

// ---------------------------------------------------------------- 模型输出

export interface ProposalItem {
  productId: string;
  quantity: number;
}

export interface ProposalAllocation {
  memberId: number;
  items: ProposalItem[];
  reason?: string;
}

/** 一个策略对应的一份提议。`strategy` 只做路由，最终以服务端枚举为准。 */
export interface ProposalPlan {
  strategy: string;
  allocations: ProposalAllocation[];
  notes?: string;
}

export interface Proposal {
  plans: ProposalPlan[];
}

// ---------------------------------------------------------------- 提示词

const SYSTEM_PROMPT = [
  '你是麦当劳多人点餐协商助手。你的任务是为一组人各选一份餐，让每个人都在自己的预算内。',
  '',
  '硬性规则：',
  '1. 只能从下面给出的 candidates 里选商品，productId 必须原样照抄，禁止编造。',
  '2. 每个成员的商品按菜单价合计不得超过该成员 budgetCents（单位：分）。',
  '3. dislikes 是排除条件，命中类别的商品绝对不能选。',
  '4. requirement 为 no-spicy 时不能选辣味商品；no-beef 时不能选牛肉商品；',
  '   burger/fries/drink 表示该成员明确想吃这一类，必须包含至少一个该类商品。',
  '5. 每个成员必须至少有一个主食（hasMain 为 true；未提供时 category 为 burger）；每人 1 到 4 件商品，每件数量是 1 到 3 的整数。',
  '套餐 includedCategories 是实际默认组成的类别；dislikes 和必点类别同时检查子项，套餐已有饮品或配餐时不要重复加购。',
  '6. 模型不负责算钱：不要返回任何价格、总价、优惠或分摊金额，这些由程序试算。',
  '7. 不为了花满预算而加购，也不要为了凑单重复同一种商品。',
  '8. 每个成员在每个策略里都必须有且只有一条 allocation。',
  '',
  '策略差异（同一批硬约束下换排序目标）：',
  '- saving：在满足规则前提下，尽量选实际花费最低的组合。',
  '- peace：照顾到每个人的偏好，尽量不让任何一个人觉得被牺牲。',
  '- happy：优先命中每个人的 likes，预算内尽量满足。',
  '三个策略结果允许相同；不要为了显得不同而牺牲任何人的硬约束。',
  '',
  '只输出一个 JSON 对象，不要 markdown、不要解释性前后缀。格式：',
  '{"plans":[{"strategy":"saving","allocations":[{"memberId":1,"items":[{"productId":"1100","quantity":1}],"reason":"一句话说明"}],"notes":"可选"}]}',
].join('\n');

function buildUserPrompt(request: ProposalRequest): string {
  return JSON.stringify(
    {
      store: request.storeName,
      strategies: request.strategies,
      members: request.members.map((member) => ({
        ...member,
        locked: (request.lockedMemberIds ?? []).includes(member.id),
      })),
      candidates: request.candidates,
      output: {
        plans: '为 strategies 里每个策略各给一份，strategy 原样照抄，memberId 用输入里的数字 id',
      },
    },
    null,
    0,
  );
}

// ---------------------------------------------------------------- 解析

/** 去掉 ``` 包裹，再截取第一个 `{` 到最后一个 `}`，容忍模型的寒暄。 */
export function extractJsonObject(content: string): string {
  const withoutFence = content
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return withoutFence;
  return withoutFence.slice(start, end + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 结构校验：只认 `plans[].allocations[].items[].{productId,quantity}`。
 * 其余字段（包括模型自作主张返回的 `price` / `priceCents`）一律丢弃。
 *
 * 兼容两种形状：标准的多策略 `{ plans: [...] }`，以及个别模型只回
 * `{ allocations: [...] }` 的退化写法（按 `defaultStrategy` 归位）。
 */
export function parseProposal(content: string, defaultStrategy = 'peace'): Proposal {
  const json = extractJsonObject(content);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AiError('model_invalid_json', '模型返回的内容不是合法 JSON');
  }

  if (!isRecord(parsed)) {
    throw new AiError('model_invalid_shape', '模型返回不是对象');
  }

  const rawPlans: unknown[] = Array.isArray(parsed.plans)
    ? parsed.plans
    : Array.isArray(parsed.allocations)
      ? [{ strategy: defaultStrategy, allocations: parsed.allocations }]
      : [];

  if (rawPlans.length === 0) {
    throw new AiError('model_invalid_shape', '模型返回缺少 plans 数组');
  }

  const plans: ProposalPlan[] = rawPlans.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new AiError('model_invalid_shape', `plans[${String(index)}] 不是对象`);
    }

    if (!Array.isArray(entry.allocations)) {
      throw new AiError('model_invalid_shape', `plans[${String(index)}].allocations 必须是数组`);
    }

    const strategy =
      typeof entry.strategy === 'string' && entry.strategy.trim() !== ''
        ? entry.strategy.trim()
        : defaultStrategy;

    return {
      strategy,
      allocations: parseAllocations(entry.allocations, index),
      notes: typeof entry.notes === 'string' ? entry.notes : undefined,
    };
  });

  return { plans };
}

function parseAllocations(rawAllocations: unknown[], planIndex: number): ProposalAllocation[] {
  return rawAllocations.map((entry, index) => {
    const path = `plans[${String(planIndex)}].allocations[${String(index)}]`;

    if (!isRecord(entry)) {
      throw new AiError('model_invalid_shape', `${path} 不是对象`);
    }

    const memberId = entry.memberId;
    if (typeof memberId !== 'number' || !Number.isInteger(memberId)) {
      throw new AiError('model_invalid_shape', `${path}.memberId 必须是整数`);
    }

    if (!Array.isArray(entry.items)) {
      throw new AiError('model_invalid_shape', `${path}.items 必须是数组`);
    }

    const items: ProposalItem[] = entry.items.map((item, itemIndex) => {
      if (!isRecord(item)) {
        throw new AiError('model_invalid_shape', `${path}.items[${String(itemIndex)}] 不是对象`);
      }

      const productId = typeof item.productId === 'string' ? item.productId.trim() : '';
      if (productId === '') {
        throw new AiError('model_invalid_shape', `${path}.items[${String(itemIndex)}].productId 缺失`);
      }

      // quantity 允许字符串数字（部分网关会这么回），但必须是整数。
      const rawQuantity = item.quantity;
      const quantity =
        typeof rawQuantity === 'number'
          ? rawQuantity
          : typeof rawQuantity === 'string' && rawQuantity.trim() !== ''
            ? Number(rawQuantity)
            : 1;

      return { productId, quantity };
    });

    return {
      memberId,
      items,
      reason: typeof entry.reason === 'string' ? entry.reason : undefined,
    };
  });
}

// ---------------------------------------------------------------- 语义校验

/** 校验用的商品视图：只带校验需要的事实，不带任何模型可见的噪音。 */
export interface ValidatableProduct {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  hasMain?: boolean;
  includedCategories?: string[];
  isCombo?: boolean;
  /** 由名称/标签推导，可能是 false negative。 */
  spicy: boolean;
  beef: boolean;
  /** 蘸酱、周边、贴纸之类，不算餐品。 */
  nonMeal: boolean;
}

export interface ValidatableMember {
  id: number;
  budgetCents: number;
  likes: string[];
  dislikes: string[];
  requirement: string;
  customRequirement?: string;
}

export interface ValidationOptions {
  maxQuantityPerItem?: number;
  maxItemsPerMember?: number;
  /** 必须保留不动的成员，模型给这些成员下单也算越界。 */
  lockedMemberIds?: number[];
  /** 每位成员是否必须有主食（burger）。默认要求，与规则版 `buildPlan` 的可行性判定一致。 */
  requireMain?: boolean;
}

export interface ValidatedItem {
  product: ValidatableProduct;
  quantity: number;
}

export interface ValidatedSelection {
  memberId: number;
  items: ValidatedItem[];
  reason: string;
  matchedLikes: string[];
  missingLikes: string[];
  requiresManualReview: boolean;
}

export type ProposalViolationCode =
  | 'model_unknown_member'
  | 'model_locked_member'
  | 'model_duplicate_member'
  | 'model_missing_member'
  | 'model_unknown_product'
  | 'model_non_meal_product'
  | 'model_invalid_quantity'
  | 'model_empty_items'
  | 'model_too_many_items'
  | 'model_dislike_violation'
  | 'model_requirement_violation'
  | 'model_missing_required_category'
  | 'model_missing_main'
  | 'model_duplicate_combo_side'
  | 'model_budget_exceeded';

export interface ProposalViolation {
  code: ProposalViolationCode;
  memberId?: number;
  message: string;
}

export type ProposalValidation =
  | { ok: true; selections: ValidatedSelection[] }
  | { ok: false; violation: ProposalViolation };

const DEFAULT_MAX_QUANTITY = 3;
const DEFAULT_MAX_ITEMS = 4;

const REQUIRED_CATEGORIES = new Set(['burger', 'fries', 'drink']);

/**
 * 语义校验。**纯函数**，不碰网络、不碰环境变量，方便单测覆盖每一条拦截。
 *
 * 只要有一条不通过就整体拒绝——不做「部分采纳」。原因是部分采纳会让
 * 理由链对不上（模型说选 A，程序悄悄换成 B），前端展示的取舍说明就变成假话。
 */
export function validateProposal(
  allocations: ProposalAllocation[],
  members: ValidatableMember[],
  products: ValidatableProduct[],
  options: ValidationOptions = {},
): ProposalValidation {
  const maxQuantity = options.maxQuantityPerItem ?? DEFAULT_MAX_QUANTITY;
  const maxItems = options.maxItemsPerMember ?? DEFAULT_MAX_ITEMS;
  const locked = new Set(options.lockedMemberIds ?? []);

  const productById = new Map(products.map((product) => [product.id, product]));
  const memberById = new Map(members.map((member) => [member.id, member]));

  const expected = new Set(members.map((member) => member.id).filter((id) => !locked.has(id)));
  const seen = new Set<number>();
  const selections: ValidatedSelection[] = [];

  for (const allocation of allocations) {
    const member = memberById.get(allocation.memberId);

    if (member === undefined) {
      return {
        ok: false,
        violation: {
          code: 'model_unknown_member',
          memberId: allocation.memberId,
          message: `模型给出了不存在的成员 ${String(allocation.memberId)}`,
        },
      };
    }

    if (locked.has(member.id)) {
      return {
        ok: false,
        violation: {
          code: 'model_locked_member',
          memberId: member.id,
          message: `成员 ${String(member.id)} 的餐品在本轮不允许改动`,
        },
      };
    }

    if (seen.has(member.id)) {
      return {
        ok: false,
        violation: {
          code: 'model_duplicate_member',
          memberId: member.id,
          message: `模型重复为成员 ${String(member.id)} 方案`,
        },
      };
    }
    seen.add(member.id);

    if (allocation.items.length === 0) {
      return {
        ok: false,
        violation: {
          code: 'model_empty_items',
          memberId: member.id,
          message: `模型没有为成员 ${String(member.id)} 选任何商品`,
        },
      };
    }

    if (allocation.items.length > maxItems) {
      return {
        ok: false,
        violation: {
          code: 'model_too_many_items',
          memberId: member.id,
          message: `成员 ${String(member.id)} 的商品件数 ${String(allocation.items.length)} 超过上限 ${String(maxItems)}`,
        },
      };
    }

    const items: ValidatedItem[] = [];
    let memberSubtotal = 0;

    for (const item of allocation.items) {
      const product = productById.get(item.productId);

      if (product === undefined) {
        return {
          ok: false,
          violation: {
            code: 'model_unknown_product',
            memberId: member.id,
            message: `模型给出的商品 ${item.productId} 不在该门店菜单里`,
          },
        };
      }

      if (product.nonMeal) {
        return {
          ok: false,
          violation: {
            code: 'model_non_meal_product',
            memberId: member.id,
            message: `「${product.name}」不是餐品，不能计入成员 ${String(member.id)} 的餐`,
          },
        };
      }

      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > maxQuantity) {
        return {
          ok: false,
          violation: {
            code: 'model_invalid_quantity',
            memberId: member.id,
            message: `「${product.name}」数量 ${String(item.quantity)} 不合法（需 1–${String(maxQuantity)} 的整数）`,
          },
        };
      }

      if ((product.includedCategories ?? [product.category]).some(category => member.dislikes.includes(category))) {
        return {
          ok: false,
          violation: {
            code: 'model_dislike_violation',
            memberId: member.id,
            message: `成员 ${String(member.id)} 不喜欢 ${product.category}，但模型选了「${product.name}」`,
          },
        };
      }

      if (member.requirement === 'no-spicy' && product.spicy) {
        return {
          ok: false,
          violation: {
            code: 'model_requirement_violation',
            memberId: member.id,
            message: `成员 ${String(member.id)} 要求不辣，但模型选了「${product.name}」`,
          },
        };
      }

      if (member.requirement === 'no-beef' && product.beef) {
        return {
          ok: false,
          violation: {
            code: 'model_requirement_violation',
            memberId: member.id,
            message: `成员 ${String(member.id)} 要求不含牛肉，但模型选了「${product.name}」`,
          },
        };
      }

      memberSubtotal += product.priceCents * item.quantity;
      items.push({ product, quantity: item.quantity });
    }

    // A default drink/side already in a combo must not be added again separately.
    for (const combo of items.filter(item => item.product.isCombo)) {
      if (items.some(item => item !== combo && ['fries', 'drink'].includes(item.product.category) && combo.product.includedCategories?.includes(item.product.category))) {
        return { ok: false, violation: { code: 'model_duplicate_combo_side', memberId: member.id, message: '套餐已含配餐或饮料，不能重复加购同类单品' } };
      }
    }
    // 明确要求吃某类（burger/fries/drink）时，方案里必须有。
    if (REQUIRED_CATEGORIES.has(member.requirement)) {
      const has = items.some((item) => (item.product.includedCategories ?? [item.product.category]).includes(member.requirement));
      if (!has) {
        return {
          ok: false,
          violation: {
            code: 'model_missing_required_category',
            memberId: member.id,
            message: `成员 ${String(member.id)} 明确要 ${member.requirement}，但模型给的方案里没有`,
          },
        };
      }
    }

    // 每人必须有主食：这是「一份饭」的下限，规则版的 buildPlan 也是这么判的。
    // 模型只给一份薯条不算一餐，必须在进试算之前就拦掉。
    if ((options.requireMain ?? true) && !items.some((item) => (item.product.hasMain ?? item.product.category === 'burger'))) {
      return {
        ok: false,
        violation: {
          code: 'model_missing_main',
          memberId: member.id,
          message: `成员 ${String(member.id)} 的方案里没有主食（汉堡），不算一顿饭`,
        },
      };
    }

    // 按菜单价预检；真实应付还会在 `buildPlan` 里用 calculate-price 复验。
    if (memberSubtotal > member.budgetCents) {
      return {
        ok: false,
        violation: {
          code: 'model_budget_exceeded',
          memberId: member.id,
          message: `成员 ${String(member.id)} 选品合计 ${String(memberSubtotal)} 分，超出预算 ${String(member.budgetCents)} 分`,
        },
      };
    }

    const matchedLikes = member.likes.filter((category) =>
      items.some((item) => (item.product.includedCategories ?? [item.product.category]).includes(category)),
    );

    selections.push({
      memberId: member.id,
      items,
      reason: allocation.reason ?? items.map((item) => item.product.name).join(' + '),
      matchedLikes,
      missingLikes: member.likes.filter((category) => !matchedLikes.includes(category)),
      requiresManualReview: (member.customRequirement ?? '').trim() !== '',
    });
  }

  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      violation: {
        code: 'model_missing_member',
        memberId: missing[0],
        message: `模型漏掉了成员 ${missing.map(String).join('、')}`,
      },
    };
  }

  selections.sort((a, b) => a.memberId - b.memberId);
  return { ok: true, selections };
}

// ---------------------------------------------------------------- 调用

export interface ProposalCallResult {
  proposal: Proposal;
  /** 原始 content，便于落盘排查（不含 key）。 */
  raw: string;
  latencyMs: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 这些状态码值得再试一次；4xx 里的参数/鉴权错误重试也没用。 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;
const MAX_BACKOFF_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 真正发请求的地方。OpenAI 兼容的 `/chat/completions`，`response_format` 走
 * `json_object`（不支持该参数的网关会忽略它，所以解析层不能只靠它）。
 *
 * 429/5xx 会重试一次：免费额度一般按「每分钟共享配额」限流，隔一两秒再试
 * 往往就过了；**重试失败仍然降级**，不会因为模型不可用让整页无解。
 */
export async function requestProposal(
  config: AiConfig,
  request: ProposalRequest,
  fetchImpl: FetchLike = fetch,
): Promise<ProposalCallResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptProposal(config, request, fetchImpl);
    } catch (error) {
      const status = error instanceof AiError ? (error.detail?.status as number | undefined) : undefined;
      const retryable = status !== undefined && RETRYABLE_STATUS.has(status);

      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;

      const retryAfterSec = Number.parseInt(String((error as AiError).detail?.retryAfter ?? ''), 10);
      const waitMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS)
          : Math.min(1200 * attempt, MAX_BACKOFF_MS);

      await sleep(waitMs);
    }
  }
}

async function attemptProposal(
  config: AiConfig,
  request: ProposalRequest,
  fetchImpl: FetchLike,
): Promise<ProposalCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, config.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(request) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AiError('model_http_error', `模型接口返回 HTTP ${String(response.status)}`, {
        status: response.status,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        body: text.slice(0, 400),
      });
    }

    const payload = (await response.json()) as unknown;
    const content = extractContent(payload);
    const latencyMs = Date.now() - startedAt;

    return { proposal: parseProposal(content, request.strategies[0] ?? 'peace'), raw: content, latencyMs };
  } catch (error) {
    if (error instanceof AiError) throw error;

    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiError('model_timeout', `模型请求超过 ${String(config.timeoutMs)}ms 未返回`);
    }

    throw new AiError('model_http_error', error instanceof Error ? error.message : '模型请求失败');
  } finally {
    clearTimeout(timer);
  }
}

function extractContent(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new AiError('model_invalid_shape', '模型响应不是对象');
  }

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AiError('model_invalid_shape', '模型响应缺少 choices');
  }

  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new AiError('model_invalid_shape', '模型响应缺少 choices[0].message');
  }

  const content = first.message.content;
  if (typeof content === 'string' && content.trim() !== '') return content;

  // 少数网关把 content 拆成 parts 数组。
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
    if (text !== '') return text;
  }

  throw new AiError('model_invalid_shape', '模型响应的 content 为空');
}

/** 供 `mediate.ts` 注入的抽象，测试里可以直接换成假模型。 */
export interface ProposalProvider {
  /** 显示用标识，例如 `gpt-6.1-sol`。 */
  readonly label: string;
  propose(request: ProposalRequest): Promise<ProposalCallResult>;
}

/** 按当前环境构造 provider；未配置时返回 `null`（而不是抛错）。 */
export function createProposalProvider(config: AiConfig | null = loadAiConfig()): ProposalProvider | null {
  if (config === null) return null;

  return {
    label: config.model,
    propose: (request) => requestProposal(config, request),
  };
}
