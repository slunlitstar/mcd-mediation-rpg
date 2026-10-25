/**
 * 麦当劳 MCP 网关：进程内单例 + 缓存，供 HTTP 路由复用。
 *
 * 为什么要有这一层：
 * - `McpClient` 每次 `connect()` 都要一次握手，不能每个请求建一个；
 * - MCP 限流 600 次/分钟/Token，菜单一次 96 个商品且价格在短时间内不会变，
 *   必须缓存，否则一个人刷新三次就可能把配额打满；
 * - 门店凌晨未营业会报 `600057`，这里统一做「即时链路 → 预约链路」的降级，
 *   路由层不需要知道这件事。
 */

import { loadMcpConfig } from '../config/env.js';
import { McpClient } from '../mcp/client.js';
import type { McpToolCallResult } from '../mcp/client.js';
import { McpHttpError, McpRpcError, McpTransportError } from '../mcp/errors.js';
import { isComboFromDetail, normalizeMenu, normalizePricing, normalizeStores } from '../mcp/normalize.js';
import type { UnifiedMenu, UnifiedPricing, UnifiedStore } from '../mcp/normalize.js';
import { defaultCombo } from '../mcp/default-combo.js';

/** 门店未营业时 MCP 返回的业务码。 */
const STORE_CLOSED_CODE = 600057;
/** `calculate-price` 等工具的关门文案用的是另一套码，只能靠文案兜底。 */
const CLOSED_MESSAGE_RE = /营业|暂停|关门|打烊|休息/;
const MENU_TTL_MS = 5 * 60 * 1000;
const STORE_TTL_MS = 10 * 60 * 1000;

/**
 * 是否值得用「预约链路」重试一次。
 *
 * 实测：`query-meals` 关门时给 `600057`，`calculate-price` 给的是「门店暂停营业，
 * 请重新选择门店」，业务码不同。所以这里用「码 OR 文案」双判据，
 * 避免换一个工具就要改一次。
 */
function shouldRetryWithReservation(envelope: { code?: number; message?: string }): boolean {
  if (envelope.code === STORE_CLOSED_CODE) return true;
  return envelope.message !== undefined && CLOSED_MESSAGE_RE.test(envelope.message);
}

export interface McpEnvelope {
  ok: boolean;
  code?: number;
  message?: string;
  data?: unknown;
}

function unwrap(result: McpToolCallResult): McpEnvelope {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const code = typeof structured?.code === 'number' ? structured.code : undefined;

  return {
    ok: structured !== undefined && code === 200,
    code,
    message: typeof structured?.message === 'string' ? structured.message : undefined,
    data: structured?.data,
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** 服务器时间之后的最近一个 12:00，`yyyy-MM-dd HH:mm`。 */
export function nextNoon(from = new Date()): string {
  const date = new Date(from);
  if (date.getHours() >= 11) date.setDate(date.getDate() + 1);

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 12:00`;
}

export interface MenuQuery {
  storeCode: string;
  /** 1 到店 / 2 外送。 */
  orderType?: number;
  /** 1 到店自取 / 5 得来速 / 2 麦乐送 / 6 团餐。 */
  beType?: number;
}

export interface PriceItem {
  productCode: string;
  quantity: number;
  roundList?: NonNullable<import('../mcp/normalize.js').UnifiedMenuItem['combo']>['roundList'];
}

class McdGateway {
  private client: McpClient | undefined;
  private menuCache = new Map<string, { at: number; menu: UnifiedMenu }>();
  private storeCache = new Map<string, { at: number; stores: UnifiedStore[] }>();

  private async ensureClient(): Promise<McpClient> {
    if (this.client?.isConnected) return this.client;

    const config = loadMcpConfig();
    this.client = new McpClient({ url: config.url, token: config.token });
    await this.client.connect();
    return this.client;
  }

  /** 原样调用一个工具，返回已判过业务码的信封。 */
  async call(tool: string, args: Record<string, unknown>): Promise<McpEnvelope> {
    const client = await this.ensureClient();
    return unwrap(await client.callTool(tool, args));
  }

  async stores(city: string, keyword: string): Promise<UnifiedStore[]> {
    const key = `${city}\u0000${keyword}`;
    const cached = this.storeCache.get(key);
    if (cached && Date.now() - cached.at < STORE_TTL_MS) return cached.stores;

    // searchType=1（收藏餐厅）对新账号必然 600050，只能用关键词搜。
    const envelope = await this.call('query-nearby-stores', {
      beType: 1,
      searchType: 2,
      city,
      keyword,
    });
    if (!envelope.ok) {
      throw new GatewayError('stores_failed', envelope.message ?? `门店查询失败 code=${String(envelope.code)}`);
    }

    const stores = normalizeStores(envelope.data);
    this.storeCache.set(key, { at: Date.now(), stores });
    return stores;
  }

  /**
   * 取门店菜单。营业中拿即时价；未营业（600057）自动降级到预约链路，
   * 并在返回的 `meta` 之外由调用方从 `samplingNote` 得知这一点。
   */
  async menu(query: MenuQuery): Promise<UnifiedMenu> {
    const orderType = query.orderType ?? 1;
    const beType = query.beType ?? 1;
    const cacheKey = `${query.storeCode}|${String(orderType)}|${String(beType)}`;

    const cached = this.menuCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MENU_TTL_MS) return cached.menu;

    const base = { storeCode: query.storeCode, orderType, beType };
    let envelope = await this.call('query-meals', base);

    if (!envelope.ok && shouldRetryWithReservation(envelope)) {
      envelope = await this.call('query-meals', { ...base, reservationDate: nextNoon() });
    }
    if (!envelope.ok) {
      throw new GatewayError('menu_failed', envelope.message ?? `菜单获取失败 code=${String(envelope.code)}`);
    }

    const stores = await this.storesByNameFallback(query.storeCode);
    const store = stores.find((item) => item.id === query.storeCode);
    const menu = normalizeMenu({
      store: { id: query.storeCode, name: store?.name ?? query.storeCode },
      mealsData: envelope.data,
      orderType,
      beType,
    });

    // Resolve defaults once per menu cache lifetime, with bounded concurrency.
    const combos = menu.items.filter(item => item.isCombo);
    for (let index = 0; index < combos.length; index += 3) {
      await Promise.all(combos.slice(index, index + 3).map(async item => {
        try {
          let detail = await this.call('query-meal-detail', { ...base, code: item.id });
          if (!detail.ok && shouldRetryWithReservation(detail)) detail = await this.call('query-meal-detail', { ...base, code: item.id, reservationDate: nextNoon() });
          const verified = detail.ok ? isComboFromDetail(detail.data) : undefined;
          if (verified !== undefined) { item.isCombo = verified; item.isComboSource = 'detail'; }
          item.combo = detail.ok ? defaultCombo(detail.data) : undefined;
        } catch { item.combo = undefined; }
      }));
    }
    menu.meta.comboCount = menu.items.filter(item => item.isCombo).length;
    menu.meta.comboVerifiedCount = menu.items.filter(item => item.isComboSource === 'detail').length;

    this.menuCache.set(cacheKey, { at: Date.now(), menu });
    return menu;
  }

  /** 菜单里没有门店名，退回一次门店查询补齐；拿不到就用 storeCode 顶着。 */
  private async storesByNameFallback(storeCode: string): Promise<UnifiedStore[]> {
    for (const cached of this.storeCache.values()) {
      if (Date.now() - cached.at < STORE_TTL_MS && cached.stores.some(store => store.id === storeCode)) return cached.stores;
    }
    const cached = this.storeCache.get('北京\u0000麦当劳');
    if (cached) return cached.stores;

    try {
      return await this.stores('北京', '麦当劳');
    } catch {
      return [{ id: storeCode, name: storeCode }];
    }
  }

  /** 试算。返回实时应付（含优惠）与 `takeWayCode`。 */
  async price(
    storeCode: string,
    items: PriceItem[],
    orderType = 1,
    beType = 1,
  ): Promise<UnifiedPricing> {
    const args: Record<string, unknown> = { storeCode, orderType, beType, items };

    let envelope = await this.call('calculate-price', args);
    if (!envelope.ok && shouldRetryWithReservation(envelope)) {
      envelope = await this.call('calculate-price', { ...args, reservationDate: nextNoon() });
    }
    if (!envelope.ok) {
      throw new GatewayError('price_failed', envelope.message ?? `试算失败 code=${String(envelope.code)}`);
    }

    const stores = await this.storesByNameFallback(storeCode);
    const store = stores.find((item) => item.id === storeCode);

    return normalizePricing({
      store: { id: storeCode, name: store?.name ?? storeCode },
      priceData: envelope.data,
    });
  }

  async close(): Promise<void> {
    await this.client?.disconnect();
    this.client = undefined;
  }
}

/** 网关层错误：路由据此映射 HTTP 状态码，不要直接暴露 MCP 细节。 */
export class GatewayError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.kind = kind;
  }
}

export const mcd = new McdGateway();

/** 把任意异常翻译成稳定的 `{ kind, message }`，路由层统一出 5xx/4xx。 */
export function describeGatewayError(error: unknown): { kind: string; message: string } {
  if (error instanceof GatewayError) return { kind: error.kind, message: error.message };
  if (error instanceof McpHttpError) return { kind: `mcp_http_${String(error.status)}`, message: error.message };
  if (error instanceof McpTransportError) return { kind: `mcp_${error.kind}`, message: error.message };
  if (error instanceof McpRpcError) return { kind: 'mcp_rpc', message: error.message };
  if (error instanceof Error) return { kind: 'internal', message: error.message };
  return { kind: 'internal', message: String(error) };
}
