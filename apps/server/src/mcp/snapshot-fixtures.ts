/**
 * 独立 MCP 取样 → 前端可直接使用的 fixtures。
 *
 * 与 `probe-data.ts` 的区别：
 * - `probe-data.ts` 关心「**结构对不对**」（形状 / outputSchema drift），产出 docs/；
 * - 本脚本关心「**能不能直接用**」（统一格式 / 真实价格 / 套餐判定），产出 fixtures/。
 *
 * 运行（仓库根目录）：
 *   npm run mcp:fixtures -w @mcd/server
 *
 * 产物：
 *   apps/server/fixtures/raw/*.json         MCP 原始返回（脱敏后原样保存，可对照排查）
 *   apps/server/fixtures/normalized/*.json  转换层输出（前端直接吃这层）
 *
 * 安全约束：
 * - 只调只读工具，绝不下单、不领券、不抽奖；
 * - token 不落盘、不打印；手机号/券码/带签名图片 URL 写盘前统一脱敏；
 * - 门店未营业时自动切 `reservationDate` 预约链路（否则报 600057）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMcpConfig, maskToken } from '../config/env.js';
import { McpClient } from './client.js';
import type { McpToolCallResult } from './client.js';
import { McpHttpError, McpRpcError, McpTransportError } from './errors.js';
import { normalizePricing, normalizeStores, normalizeMenu } from './normalize.js';
import type { UnifiedMenuItem } from './normalize.js';

const here = dirname(fileURLToPath(import.meta.url));
/** apps/server */
const serverRoot = resolve(here, '../..');
const fixturesRoot = resolve(serverRoot, 'fixtures');
const rawRoot = resolve(fixturesRoot, 'raw');
const normalizedRoot = resolve(fixturesRoot, 'normalized');

/** 取样城市；`searchType=1`（收藏）对新账号必然 `600050 收藏餐厅列表为空`，只能用关键词搜。 */
const CITY = '北京';
const STORE_KEYWORD = '麦当劳';
/** 逐个验证 isCombo 的商品上限，避免把 96 个商品全打一遍。 */
const DETAIL_VERIFY_LIMIT = 12;

// ---------------------------------------------------------------- 脱敏

const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const SIGNED_KEYS = /image|img|url|icon|qr/i;
const SENSITIVE_KEYS = /token|authoriz|secret|password|cookie|session/i;
const COUPON_ID_KEYS = /^(code|id|couponCode)$/i;
const STRING_LIMIT = 400;

/**
 * 写盘专用脱敏：比 `payload.ts` 的 `redact` 温和 —— 保留完整数组（菜单 96 个商品都要），
 * 只处理真正敏感的部分。
 */
function sanitize(value: unknown, path: string[] = []): unknown {
  const key = path[path.length - 1] ?? '';

  if (typeof value === 'string') {
    let text = value;
    if (SENSITIVE_KEYS.test(key)) return '***';
    if (/pay.*url/i.test(key)) return '<payment-url-hidden>';

    text = text.replace(PHONE_RE, (match) => `${match.slice(0, 3)}****${match.slice(7)}`);
    if (SIGNED_KEYS.test(key)) text = text.replace(/\?.*$/, '?<signed>');

    // 全大写长串基本是券码 / 内部 id，不是展示文案。
    if (/^[A-Z0-9]{16,}$/.test(text)) return `${text.slice(0, 4)}<masked>`;
    if (path.includes('coupons') && COUPON_ID_KEYS.test(key) && text.length > 8) {
      return `${text.slice(0, 4)}<masked>`;
    }

    return text.length <= STRING_LIMIT ? text : `${text.slice(0, STRING_LIMIT)}…`;
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) return value.map((item) => sanitize(item, path));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitize(childValue, [...path, childKey]);
    }
    return out;
  }

  return value;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------- 小工具

interface Unwrapped {
  /** MCP 传输层成功且业务码 200。 */
  ok: boolean;
  code?: number;
  message?: string;
  data?: unknown;
  /** `content[0].text` 长度，用于说明「这份文本不该进前端」。 */
  contentChars: number;
}

function unwrap(result: McpToolCallResult): Unwrapped {
  const text = result.content?.find((block) => block.type === 'text')?.text ?? '';
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const code = typeof structured?.code === 'number' ? structured.code : undefined;

  return {
    ok: structured !== undefined && code === 200,
    code,
    message: typeof structured?.message === 'string' ? structured.message : undefined,
    data: structured?.data,
    contentChars: text.length,
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** 服务器时间之后的最近一个 12:00，格式 `yyyy-MM-dd HH:mm`。 */
function nextNoon(serverDatetime: string): string {
  const base = new Date(serverDatetime.replace(' ', 'T'));
  const date = Number.isNaN(base.getTime()) ? new Date() : base;
  if (date.getHours() >= 11) date.setDate(date.getDate() + 1);

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 12:00`;
}

function pickComboSuspects(items: UnifiedMenuItem[], limit: number): string[] {
  const suspects = items.filter((item) => item.isComboSource !== 'default' || item.isCombo);
  const pool = suspects.length > 0 ? suspects : items;
  return pool.slice(0, limit).map((item) => item.id);
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  const config = loadMcpConfig();
  console.log(`endpoint : ${config.url}`);
  console.log(`token    : ${maskToken(config.token)}`);
  console.log('');

  const client = new McpClient({ url: config.url, token: config.token });
  const rawCalls: Record<string, unknown> = {};

  try {
    const info = await client.connect();
    console.log(`handshake: ok | ${info.serverInfo.name} v${info.serverInfo.version}`);
    const tools = await client.listTools();
    console.log(`tools    : ${tools.length}\n`);

    const call = async (
      tool: string,
      args: Record<string, unknown> = {},
    ): Promise<Unwrapped> => {
      const result = await client.callTool(tool, args);
      const unwrapped = unwrap(result);
      rawCalls[tool] = {
        args: sanitize(args),
        isError: result.isError,
        structuredContent: sanitize(result.structuredContent),
      };
      console.log(
        `  ${tool.padEnd(24)} code=${String(unwrapped.code)} content=${String(unwrapped.contentChars)}字符` +
          (unwrapped.ok ? '' : `  ↳ ${unwrapped.message ?? '业务失败'}`),
      );
      return unwrapped;
    };

    // 1) 服务器时间：既是最便宜的连通性证明，也用来算预约时间。
    const clock = await call('now-time-info');
    const clockData = clock.data as Record<string, unknown> | undefined;
    const serverTime =
      typeof clockData?.formatted === 'string' ? clockData.formatted : new Date().toISOString();
    const reservation = nextNoon(serverTime);
    console.log(`\n  服务器时间 ${serverTime} → 预约取样时间 ${reservation}\n`);

    // 2) 门店：关键词搜（收藏列表对新账号必空）。
    const storeSearch = await call('query-nearby-stores', {
      beType: 1,
      searchType: 2,
      city: CITY,
      keyword: STORE_KEYWORD,
    });
    const stores = normalizeStores(storeSearch.data);
    if (stores.length === 0) throw new Error('没有拿到门店，后续门店相关工具无法取样');

    const primary = stores.find((store) => store.businessStatus === true) ?? stores[0];
    console.log(`\n  选中门店 ${primary.id} ${primary.name} | 营业中=${String(primary.businessStatus)}\n`);

    const storeRef = { id: primary.id, name: primary.name };
    const bizArgs = { storeCode: primary.id, orderType: 1, beType: 1 };
    // 未营业的门店会报 600057，只有预约链路能拿到菜单。
    const menuArgs = primary.businessStatus === true
      ? bizArgs
      : { ...bizArgs, reservationDate: reservation };

    // 3) 菜单
    let menuCall = await call('query-meals', menuArgs);
    if (!menuCall.ok && primary.businessStatus === true) {
      // 营业中却失败，退回预约链路再试一次。
      menuCall = await call('query-meals', { ...bizArgs, reservationDate: reservation });
    }
    if (!menuCall.ok) throw new Error(`query-meals 失败：${menuCall.message ?? menuCall.code}`);

    // 先把菜单转一次，用它挑出「疑似套餐」去查详情。
    const draftMenu = normalizeMenu({
      store: storeRef,
      mealsData: menuCall.data,
      orderType: 1,
      beType: 1,
    });

    // 4) 逐商品详情：唯一能证实 isCombo 的真凭据（rounds 非空 = 套餐）。
    const verifyCodes = pickComboSuspects(draftMenu.items, DETAIL_VERIFY_LIMIT);
    const details: Record<string, unknown> = {};
    for (const code of verifyCodes) {
      const detail = await call('query-meal-detail', { ...menuArgs, code });
      if (detail.ok && detail.data !== undefined) details[code] = detail.data;
    }

    // 5) 门店券（该账号大概率是空数组，保留原始返回以便下次复跑对比）
    await call('query-store-coupons', menuArgs);

    // 6) 计价：用菜单里真实存在的商品组一个小篮子。
    const cheap = [...draftMenu.items].sort((a, b) => a.priceFen - b.priceFen);
    const combo = draftMenu.items.find((item) => item.isCombo);
    const basket = [combo, cheap[0], cheap[1], cheap[2]]
      .filter((item): item is UnifiedMenuItem => item !== undefined)
      .map((item) => ({ productCode: item.id, quantity: 1 }));

    const pricingCall = await call('calculate-price', { ...menuArgs, items: basket });

    // ---------------- 产出 ----------------

    await writeJson(resolve(rawRoot, 'calls.json'), {
      capturedAt: new Date().toISOString(),
      endpoint: config.url,
      serverInfo: info.serverInfo,
      protocolVersion: info.protocolVersion,
      note: '每个工具的原始 structuredContent（已脱敏）。成功判据是 code===200，不是 isError。',
      calls: rawCalls,
    });

    await writeJson(resolve(rawRoot, 'stores.json'), {
      capturedAt: new Date().toISOString(),
      tool: 'query-nearby-stores',
      args: sanitize({ beType: 1, searchType: 2, city: CITY, keyword: STORE_KEYWORD }),
      data: sanitize(storeSearch.data),
    });

    await writeJson(resolve(rawRoot, 'menu.json'), {
      capturedAt: new Date().toISOString(),
      tool: 'query-meals',
      args: sanitize(menuArgs),
      samplingNote:
        primary.businessStatus === true
          ? '门店营业中，为即时菜单价。'
          : `取样时门店未营业，走 reservationDate=${reservation} 预约链路，价格是预约报价而非即时价。`,
      data: sanitize(menuCall.data),
    });

    await writeJson(resolve(rawRoot, 'meal-detail.json'), {
      capturedAt: new Date().toISOString(),
      tool: 'query-meal-detail',
      note: 'rounds 非空即套餐。仅取样疑似套餐的商品，未覆盖全部 96 个。',
      details: sanitize(details),
    });

    await writeJson(resolve(rawRoot, 'pricing.json'), {
      capturedAt: new Date().toISOString(),
      tool: 'calculate-price',
      args: sanitize({ ...menuArgs, items: basket }),
      note: '金额单位是「分」：productPrice 2990 = ¥29.90。',
      data: sanitize(pricingCall.data),
    });

    const finalMenu = normalizeMenu({
      store: storeRef,
      mealsData: menuCall.data,
      orderType: 1,
      beType: 1,
      details,
    });

    await writeJson(resolve(normalizedRoot, 'stores.json'), stores);

    await writeJson(resolve(normalizedRoot, 'menu.json'), finalMenu);

    if (pricingCall.ok) {
      await writeJson(
        resolve(normalizedRoot, 'pricing.json'),
        normalizePricing({ store: storeRef, priceData: pricingCall.data }),
      );
    }

    // ---------------- 结论 ----------------

    console.log('\n' + '─'.repeat(60));
    console.log(`门店      : ${stores.length} 家`);
    console.log(`菜单      : ${finalMenu.meta.itemCount} 个商品 / ${finalMenu.categories.length} 个分类`);
    console.log(
      `套餐判定  : 认出 ${finalMenu.meta.comboCount} 个套餐，其中 ${finalMenu.meta.comboVerifiedCount} 个由 detail 证实`,
    );
    console.log(`未分类商品: ${finalMenu.meta.orphanCount} 个`);
    console.log(`计价      : ${pricingCall.ok ? `应付 ¥${normalizePricing({ store: storeRef, priceData: pricingCall.data }).payable}` : '取样失败'}`);
    console.log(`输出      : ${fixturesRoot}`);
    console.log('─'.repeat(60));
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof McpHttpError || error instanceof McpTransportError) {
    console.error(`[${error.kind}] ${error.message}`);
  } else if (error instanceof McpRpcError) {
    console.error(`[rpc ${error.code}] ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`[error] ${error.message}`);
  } else {
    console.error('[error]', error);
  }

  process.exitCode = 1;
});
