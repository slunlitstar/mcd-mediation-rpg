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
 *
 * 成功一律 `{ ok: true, data }`，失败 `{ ok: false, error: { kind, message } }`，
 * 前端只需要判 `ok`。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { describeGatewayError, mcd } from '../services/mcd.js';
import { planMeal } from '../services/plan.js';
import type { MemberRequest } from '../services/plan.js';

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
  if (record.members.length > 10) throw new Error('一次最多 10 位成员');

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

    sendError(response, 404, 'not_found', `未知接口：${request.method ?? ''} ${url.pathname}`);
    return true;
  } catch (error: unknown) {
    const described = describeGatewayError(error);

    // 参数类错误是调用方的问题，MCP 侧问题才归 5xx。
    const isBadRequest =
      described.kind === 'internal' &&
      /必填|必须|超过|至少|最多|JSON/.test(described.message);

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
