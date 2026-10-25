/**
 * HTTP 路由。
 *
 * 项目约定「暂不引入业务框架」，所以用原生 `node:http` 加一层极薄的路由分发。
 *
 * 接口契约（与 `apps/server/fixtures/README.md` 中描述的返回结构一致）：
 *
 *   GET  /api/health                              健康检查
 *   GET  /api/stores?city=北京&keyword=麦当劳       门店列表 → UnifiedStore[]
 *   GET  /api/menu?storeCode=1950059              菜单 → UnifiedMenu
 *   POST /api/plan                                生成方案 → PlanOutcome（ok / no_solution）
 *   POST /api/mediate                             前端适配层 → MediateResult（plans / issues）
 *
 * 成功一律 `{ ok: true, data }`，失败 `{ ok: false, error: { kind, message } }`，
 * 前端只需要判 `ok`。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { describeGatewayError, mcd } from '../services/mcd.js';
import { describeAiConfig, loadAiConfig } from '../services/ai.js';
import { planMeal } from '../services/plan.js';
import type { MemberRequest } from '../services/plan.js';
import { isCategory, isStrategy, mediate } from '../services/mediate.js';
import type { ExcludedPlan, MediateRequest, MemberInput, RevisionAction } from '../services/mediate.js';
import type { SharedMeal } from '../services/shared-meals.js';

const MAX_BODY_BYTES = 64 * 1024;

/** 开发期允许 Vite dev server 跨域；生产同源部署时这段不生效。 */
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
]);

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin !== undefined && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  kind: string,
  message: string,
): void {
  sendJson(response, status, { ok: false, error: { kind, message } });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error(`请求体超过 ${String(MAX_BODY_BYTES)} 字节`);
    chunks.push(buffer);
  }

  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function asString(value: string | null): string | undefined {
  return value !== null && value.trim() !== '' ? value.trim() : undefined;
}

function asInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** 校验 `/api/plan` 的请求体，返回可读的中文错误信息。 */
function parsePlanRequest(body: unknown): {
  storeCode: string;
  orderType?: number;
  beType?: number;
  members: MemberRequest[];
} {
  if (body === null || typeof body !== 'object') throw new Error('请求体必须是 JSON 对象');
  const record = body as Record<string, unknown>;

  const storeCode = typeof record.storeCode === 'string' ? record.storeCode.trim() : '';
  if (storeCode === '') throw new Error('storeCode 必填');

  if (!Array.isArray(record.members) || record.members.length === 0) {
    throw new Error('members 必须是非空数组');
  }
  // 产品规则：2–4 人（与 /api/mediate 保持一致）
  if (record.members.length < 2 || record.members.length > 4) {
    throw new Error('members 人数必须在 2–4 人之间');
  }

  const members: MemberRequest[] = record.members.map((memberRaw, index) => {
    if (memberRaw === null || typeof memberRaw !== 'object') {
      throw new Error(`members[${String(index)}] 必须是对象`);
    }
    const member = memberRaw as Record<string, unknown>;
    const name = typeof member.name === 'string' && member.name.trim() !== '' ? member.name.trim() : '';
    if (name === '') throw new Error(`members[${String(index)}].name 必填`);

    const budget = typeof member.budget === 'number' ? member.budget : Number.NaN;
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(`members[${String(index)}].budget 必须是大于 0 的数字`);
    }

    return {
      id: typeof member.id === 'string' ? member.id : undefined,
      name,
      budget,
      spicy: member.spicy === true,
      lightEater: member.lightEater === true,
      wantChicken: member.wantChicken === true,
      wantVegetable: member.wantVegetable === true,
      note: typeof member.note === 'string' ? member.note : undefined,
    };
  });

  return {
    storeCode,
    orderType: typeof record.orderType === 'number' ? record.orderType : undefined,
    beType: typeof record.beType === 'number' ? record.beType : undefined,
    members,
  };
}

/**
 * 校验 `/api/mediate` 的请求体。
 *
 * 按 `docs/mediate-contract.md` 的硬规则执行，**不静默纠正**：
 * 人数 2–4、budget 为 1–200 元整数或 null、excludePlan 必须带完整上一份方案。
 * 任何一条不过就 400，并在 message 里指明缺什么。
 */
function parseMediateRequest(body: unknown): MediateRequest {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  const record = body as Record<string, unknown>;

  const storeId = typeof record.storeId === 'string' ? record.storeId.trim() : '';
  if (storeId === '') throw new Error('storeId 必填');

  if (!Array.isArray(record.members)) throw new Error('members 必须是数组');
  if (record.members.length < 2 || record.members.length > 4) {
    throw new Error('members 人数必须在 2–4 人之间');
  }

  const members: MemberInput[] = record.members.map((raw, index) => {
    if (raw === null || typeof raw !== 'object') throw new Error(`members[${String(index)}] 必须是对象`);
    const member = raw as Record<string, unknown>;

    const id = typeof member.id === 'number' ? member.id : Number.NaN;
    if (!Number.isInteger(id)) throw new Error(`members[${String(index)}].id 必须是整数`);

    // null 表示未填写，不能当不限预算，也不能套默认值。
    let budget: number | null = null;
    if (member.budget === null || member.budget === undefined) {
      budget = null;
    } else if (typeof member.budget === 'number') {
      if (!Number.isInteger(member.budget)) {
        throw new Error(`members[${String(index)}].budget 必须是整数元`);
      }
      if (member.budget < 1 || member.budget > 200) {
        throw new Error(`members[${String(index)}].budget 必须在 1–200 元之间`);
      }
      budget = member.budget;
    } else {
      throw new Error(`members[${String(index)}].budget 必须是整数或 null`);
    }

    const toCategoryList = (value: unknown, field: string): MemberInput['likes'] => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) throw new Error(`members[${String(index)}].${field} 必须是数组`);
      return value.map((entry) => {
        if (!isCategory(entry)) {
          throw new Error(`members[${String(index)}].${field} 含非法类别：${String(entry)}`);
        }
        return entry;
      });
    };

    const hunger = member.hunger;
    if (hunger !== undefined && hunger !== 'little' && hunger !== 'hungry' && hunger !== 'faint') {
      throw new Error(`members[${String(index)}].hunger 非法`);
    }

    const requirement = member.requirement;
    const validRequirements = ['none', 'burger', 'fries', 'drink', 'no-spicy', 'no-beef', 'other'];
    if (requirement !== undefined && !validRequirements.includes(String(requirement))) {
      throw new Error(`members[${String(index)}].requirement 非法`);
    }

    return {
      id,
      roleId: typeof member.roleId === 'string' ? member.roleId : null,
      budget,
      hunger: hunger as MemberInput['hunger'],
      likes: toCategoryList(member.likes, 'likes'),
      dislikes: toCategoryList(member.dislikes, 'dislikes'),
      requirement: requirement as MemberInput['requirement'],
      customRequirement: typeof member.customRequirement === 'string' ? member.customRequirement : '',
      configured: member.configured === true,
    };
  });

  const ids = new Set(members.map((member) => member.id));
  if (ids.size !== members.length) throw new Error('members[].id 不能重复');

  // ---- revision ----
  let revision: MediateRequest['revision'];
  if (record.revision !== undefined && record.revision !== null) {
    if (typeof record.revision !== 'object') throw new Error('revision 必须是对象');
    const raw = record.revision as Record<string, unknown>;

    const memberId = typeof raw.memberId === 'number' ? raw.memberId : Number.NaN;
    if (!Number.isInteger(memberId)) throw new Error('revision.memberId 必须是整数');
    if (!ids.has(memberId)) throw new Error(`revision.memberId=${String(memberId)} 不在 members 里`);

    const actions: RevisionAction[] = ['cheaper', 'hungrier', 'fries', 'burger', 'drink'];
    const action = raw.action;
    if (typeof action !== 'string' || !(actions as string[]).includes(action)) {
      throw new Error(`revision.action 必须是 ${actions.join(' / ')} 之一`);
    }

    revision = { memberId, action: action as RevisionAction };
  }

  // ---- excludePlan：必须带完整方案，逐项校验 ----
  let excludePlan: ExcludedPlan | undefined;
  if (record.excludePlan !== undefined && record.excludePlan !== null) {
    if (typeof record.excludePlan !== 'object') throw new Error('excludePlan 必须是对象');
    const raw = record.excludePlan as Record<string, unknown>;

    const planId = typeof raw.planId === 'string' ? raw.planId.trim() : '';
    if (planId === '') throw new Error('excludePlan.planId 必填（只传 strategy 不够）');

    if (!isStrategy(raw.strategy)) throw new Error('excludePlan.strategy 非法');

    if (!Array.isArray(raw.allocations) || raw.allocations.length === 0) {
      throw new Error('excludePlan.allocations 必填');
    }

    const allocations = raw.allocations.map((entryRaw, index) => {
      if (entryRaw === null || typeof entryRaw !== 'object') {
        throw new Error(`excludePlan.allocations[${String(index)}] 必须是对象`);
      }
      const entry = entryRaw as Record<string, unknown>;

      const memberId = typeof entry.memberId === 'number' ? entry.memberId : Number.NaN;
      if (!Number.isInteger(memberId)) {
        throw new Error(`excludePlan.allocations[${String(index)}].memberId 必须是整数`);
      }

      if (!Array.isArray(entry.items)) {
        throw new Error(`excludePlan.allocations[${String(index)}].items 必填`);
      }
      const sharedItems = entry.sharedItems;
      if (sharedItems !== undefined && (!Array.isArray(sharedItems) || sharedItems.length > 24 || sharedItems.some(ref => !ref || typeof ref !== 'object' || typeof ref.sharedMealId !== 'string' || typeof ref.componentId !== 'string'))) throw new Error('excludePlan.sharedItems 非法');
      if (entry.items.length === 0 && (!Array.isArray(sharedItems) || sharedItems.length === 0)) throw new Error('excludePlan 成员餐品不能为空');

      const items = entry.items.map((itemRaw, itemIndex) => {
        if (itemRaw === null || typeof itemRaw !== 'object') {
          throw new Error(`excludePlan.allocations[${String(index)}].items[${String(itemIndex)}] 必须是对象`);
        }
        const item = itemRaw as Record<string, unknown>;
        const productId = typeof item.productId === 'string' ? item.productId.trim() : '';
        if (productId === '') {
          throw new Error(`excludePlan.allocations[${String(index)}].items[${String(itemIndex)}].productId 必填`);
        }
        const quantity = typeof item.quantity === 'number' ? item.quantity : Number.NaN;
        if (!Number.isInteger(quantity) || quantity < 1) {
          throw new Error(`excludePlan.allocations[${String(index)}].items[${String(itemIndex)}].quantity 必须是正整数`);
        }
        return { productId, quantity };
      });

      const totalCents = typeof entry.totalCents === 'number' ? entry.totalCents : Number.NaN;
      if (!Number.isInteger(totalCents) || totalCents < 0) {
        throw new Error(`excludePlan.allocations[${String(index)}].totalCents 必须是非负整数分`);
      }

      return { memberId, items, totalCents, sharedItems: Array.isArray(sharedItems) ? sharedItems.map(ref => ({ sharedMealId: String(ref.sharedMealId), componentId: String(ref.componentId) })) : undefined };
    });

    const covered = new Set(allocations.map((entry) => entry.memberId));
    if (covered.size !== ids.size || [...ids].some((id) => !covered.has(id))) {
      throw new Error('excludePlan.allocations 必须覆盖全部成员');
    }

    const intField = (key: string): number => {
      const value = raw[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`excludePlan.${key} 必须是非负整数分`);
      }
      return value;
    };

    const productSubtotalCents = intField('productSubtotalCents');
    const discountCents = intField('discountCents');
    const payableCents = intField('payableCents');
    let sharedMeals: SharedMeal[] | undefined;
    if (raw.sharedMeals !== undefined) {
      if (!Array.isArray(raw.sharedMeals) || raw.sharedMeals.length > 2) throw new Error('excludePlan.sharedMeals 非法');
      sharedMeals = raw.sharedMeals as SharedMeal[];
      const seen = new Set<string>(); const expectedRefs = new Set<string>();
      for (const meal of sharedMeals) {
        if (!meal || typeof meal !== 'object' || typeof meal.sharedMealId !== 'string' || seen.has(meal.sharedMealId) || typeof meal.productId !== 'string' || meal.quantity !== 1 || !Array.isArray(meal.memberIds) || meal.memberIds.length < 2 || meal.memberIds.length > 4 || new Set(meal.memberIds).size !== meal.memberIds.length || meal.memberIds.some(id => !ids.has(id)) || !Array.isArray(meal.components) || !meal.components.length || meal.components.length > 24) throw new Error('excludePlan.sharedMeals 套餐或成员非法');
        seen.add(meal.sharedMealId);
        for (const part of meal.components) {
          if (!part || typeof part !== 'object' || typeof part.componentId !== 'string' || typeof part.id !== 'string' || part.quantity !== 1 || !Array.isArray(part.memberIds) || !part.memberIds.length || new Set(part.memberIds).size !== part.memberIds.length || part.memberIds.some(id => !meal.memberIds.includes(id))) throw new Error('excludePlan.sharedMeals 分配非法');
          for (const id of part.memberIds) { const key = `${id}/${meal.sharedMealId}/${part.componentId}`; if (expectedRefs.has(key)) throw new Error('excludePlan.sharedMeals 餐品重复'); expectedRefs.add(key); }
        }
      }
      const refs = allocations.flatMap(allocation => (allocation.sharedItems ?? []).map(ref => `${allocation.memberId}/${ref.sharedMealId}/${ref.componentId}`));
      if (refs.length !== expectedRefs.size || new Set(refs).size !== refs.length || refs.some(ref => !expectedRefs.has(ref))) throw new Error('excludePlan.sharedItems 数量或归属不一致');
    } else if (allocations.some(allocation => allocation.sharedItems?.length)) throw new Error('excludePlan.sharedMeals 必填');

    const allocatedSum = allocations.reduce((sum, entry) => sum + entry.totalCents, 0);
    if (allocatedSum !== payableCents) {
      throw new Error(
        `excludePlan 分摊合计 ${String(allocatedSum)} 与 payableCents ${String(payableCents)} 不一致`,
      );
    }
    if (productSubtotalCents - discountCents !== payableCents) {
      throw new Error(
        `excludePlan 商品合计 ${String(productSubtotalCents)} − 优惠 ${String(discountCents)} ≠ 应付 ${String(payableCents)}`,
      );
    }

    excludePlan = {
      planId,
      strategy: raw.strategy,
      allocations,
      productSubtotalCents,
      discountCents,
      payableCents,
      sharedMeals,
    };
  }

  if (revision !== undefined && excludePlan === undefined) {
    throw new Error('复议（revision）必须同时提供 excludePlan 上一份完整方案');
  }

  const optionsRaw = record.options;
  let options: MediateRequest['options'];
  if (optionsRaw !== undefined && optionsRaw !== null) {
    if (typeof optionsRaw !== 'object') throw new Error('options 必须是对象');
    const raw = optionsRaw as Record<string, unknown>;
    const maxPlans = raw.maxPlans;
    if (maxPlans !== undefined && (typeof maxPlans !== 'number' || !Number.isInteger(maxPlans) || maxPlans < 1 || maxPlans > 3)) {
      throw new Error('options.maxPlans 必须是 1–3 的整数');
    }
    options = {
      maxPlans: typeof maxPlans === 'number' ? maxPlans : undefined,
      includeProducts: raw.includeProducts !== false,
    };
  }

  return {
    storeId,
    orderType: typeof record.orderType === 'number' ? record.orderType : undefined,
    beType: typeof record.beType === 'number' ? record.beType : undefined,
    members,
    revision,
    excludePlan,
    options,
  };
}

/**
 * 返回 `true` 表示已处理；`false` 表示不归它管，交给上层出 404。
 */
export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false;

  applyCors(request, response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return true;
  }

  try {
    if (url.pathname === '/api/health' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        data: {
          service: 'mcd-mediation-rpg-server',
          time: new Date().toISOString(),
          mcpConfigured: (process.env.MCD_MCP_TOKEN ?? '') !== '',
          planner: 'rule-based-v2',
          // 三项齐全才算模型可用；只填 key 时这里是 not_configured，和 meta.llm 口径一致。
          llm: describeAiConfig(loadAiConfig()),
        },
      });
      return true;
    }

    if (url.pathname === '/api/stores' && request.method === 'GET') {
      const city = asString(url.searchParams.get('city')) ?? '北京';
      const keyword = asString(url.searchParams.get('keyword')) ?? '麦当劳';
      const stores = await mcd.stores(city, keyword);
      sendJson(response, 200, { ok: true, data: stores });
      return true;
    }

    if (url.pathname === '/api/menu' && request.method === 'GET') {
      const storeCode = asString(url.searchParams.get('storeCode'));
      if (storeCode === undefined) {
        sendError(response, 400, 'bad_request', 'storeCode 必填');
        return true;
      }

      const menu = await mcd.menu({
        storeCode,
        orderType: asInt(url.searchParams.get('orderType')),
        beType: asInt(url.searchParams.get('beType')),
      });
      sendJson(response, 200, { ok: true, data: menu });
      return true;
    }

    if (url.pathname === '/api/plan' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const parsed = parsePlanRequest(body);
      // 返回的是 PlanOutcome：`status: 'ok'` 带方案，`status: 'no_solution'` 带阻塞原因。
      // 无解是正常的业务结论，不是 HTTP 错误，所以仍然 200。
      const outcome = await planMeal(parsed);
      sendJson(response, 200, { ok: true, data: outcome });
      return true;
    }

    if (url.pathname === '/api/mediate' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const parsed = parseMediateRequest(body);
      const result = await mediate(parsed);
      sendJson(response, 200, { ok: true, data: result });
      return true;
    }

    sendError(response, 404, 'not_found', `未知接口：${request.method ?? ''} ${url.pathname}`);
    return true;
  } catch (error: unknown) {
    const described = describeGatewayError(error);

    // 参数类错误是调用方的问题，MCP 侧问题才归 5xx。
    const isBadRequest =
      described.kind === 'internal' &&
      /必填|必须|超过|至少|最多|JSON|^excludePlan/.test(described.message);

    if (isBadRequest) {
      sendError(response, 400, 'bad_request', described.message);
    } else if (described.kind === 'mcp_http_401' || described.kind === 'mcp_http_403') {
      sendError(response, 502, 'mcp_auth_failed', '麦当劳 MCP 鉴权失败，请检查 .env 里的 MCD_MCP_TOKEN');
    } else {
      sendError(response, 502, described.kind, described.message);
    }
    return true;
  }
}
