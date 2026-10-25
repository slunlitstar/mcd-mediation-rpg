/**
 * Write-path probe: creates exactly ONE real order, records the payload shapes,
 * then cancels it. No payment is ever made.
 *
 * Run from the repository root:
 *   npm run mcp:order -w @mcd/server              # dry run, prints the plan only
 *   npm run mcp:order -w @mcd/server -- --confirm # actually creates + cancels
 *
 * Why this exists: `create-order` / `query-order` / `cancel-order` are the only
 * tools whose payloads cannot be observed read-only, and the app's 成交层 needs
 * their real field names (`orderId`, `payH5Url`, status enums…).
 *
 * Safety contract:
 * - one order, one product, cheapest item in the menu (¥5.00 ice cream cone);
 * - the returned payment URL is **never** opened and never written to disk;
 * - `cancel-order` runs in a `finally` block: if query/capture fails midway the
 *   order is still cancelled;
 * - every payload is masked by the same rules as the read-only probe.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMcpConfig, maskToken } from '../config/env.js';
import { McpClient } from './client.js';
import type { McpTool, McpToolCallResult } from './client.js';
import { McpHttpError, McpRpcError, McpTransportError } from './errors.js';
import {
  describeData,
  describeError,
  diffShapes,
  errorKindOf,
  firstLine,
  num,
  padRight,
  redact,
  shapeFromSchema,
  shapeOf,
  textOf,
} from './payload.js';
import type { DiffEntry, ShapeNode } from './payload.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const shapesPath = resolve(repoRoot, 'docs/mcp-order-shapes.json');

/**
 * The single order this probe is allowed to place. Everything is explicit so the
 * blast radius is reviewable in a diff: 1 × 圆筒冰淇淋 at 麦当劳北京新王府井餐厅,
 * picked up in store, reserved for noon (the store is closed at probe time).
 */
const ORDER = {
  storeCode: '1950059',
  storeName: '麦当劳北京新王府井餐厅',
  orderType: 1,
  beType: 1,
  reservationDate: '2026-10-25 12:00',
  productCode: '515837',
  productName: '圆筒冰淇淋',
  quantity: 1,
  expectedPrice: 5.0,
  takeWayCode: 'take-in-store',
} as const;

interface Step {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  isError: boolean;
  durationMs: number;
  contentChars: number;
  contentHead: string;
  envelope?: Record<string, unknown>;
  dataShape?: ShapeNode;
  diffs?: DiffEntry[];
  dataSample?: unknown;
  error?: { kind: string; message: string };
}

function collect(value: unknown, keys: string[], out: Record<string, unknown>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) collect(item, keys, out, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key) && (typeof child === 'string' || typeof child === 'number')) out[key] = child;
    if (child && typeof child === 'object') collect(child, keys, out, depth + 1);
  }
}

class OrderProbe {
  private readonly client: McpClient;
  private readonly tools = new Map<string, McpTool>();
  readonly steps: Step[] = [];

  constructor(client: McpClient) {
    this.client = client;
  }

  indexTools(tools: McpTool[]): void {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  async call(tool: string, args: Record<string, unknown>): Promise<{ step: Step; data: unknown }> {
    const step: Step = {
      tool,
      args: redact(args) as Record<string, unknown>,
      ok: false,
      isError: false,
      durationMs: 0,
      contentChars: 0,
      contentHead: '',
    };
    const startedAt = Date.now();
    let raw: unknown;

    try {
      const result: McpToolCallResult = await this.client.callTool(tool, args);
      step.durationMs = Date.now() - startedAt;
      step.ok = true;
      step.isError = result.isError === true;

      const text = textOf(result);
      step.contentChars = text.length;
      step.contentHead = firstLine(text);

      const structured = result.structuredContent as Record<string, unknown> | undefined;
      if (structured && typeof structured === 'object') step.envelope = redact(structured) as Record<string, unknown>;

      let data: unknown = structured?.data;
      if (data === undefined && structured !== undefined && !('code' in structured)) data = structured;

      const described = describeData(data);
      raw = described.data;

      if (raw !== undefined) {
        step.dataShape = shapeOf(raw);
        step.diffs = diffShapes(step.dataShape, shapeFromSchema(this.tools.get(tool)?.outputSchema?.properties?.data));
        step.dataSample = redact(raw);
      }
    } catch (error: unknown) {
      step.durationMs = Date.now() - startedAt;
      step.error = { kind: errorKindOf(error), message: describeError(error) };
    }

    this.steps.push(step);
    const code = num(step.envelope?.code);
    const status = step.ok ? (step.isError ? 'isError' : 'ok') : `FAIL ${step.error?.kind ?? ''}`;
    console.log(
      `  ${padRight(tool, 16)} ${padRight(status, 12)} ${String(step.durationMs).padStart(5)}ms  ` +
        `code ${String(code ?? '-')}  drift ${step.diffs?.length ?? 0}`,
    );
    if (!step.ok) console.log(`      ↳ ${step.error?.message ?? ''}`);
    else if (code !== undefined && code !== 200) console.log(`      ↳ ${String(step.envelope?.message ?? '')}`);
    for (const diff of (step.diffs ?? []).slice(0, 6)) {
      console.log(`      · ${diff.kind.padEnd(16)} ${diff.path} (${diff.detail})`);
    }

    return { step, data: raw };
  }
}

function printPlan(): void {
  console.log('dry run — 未发起任何请求。加 --confirm 才会真正执行。\n');
  console.log(`  门店     : ${ORDER.storeCode} ${ORDER.storeName}`);
  console.log(`  商品     : ${ORDER.productCode} ${ORDER.productName} × ${ORDER.quantity}（预期 ¥${ORDER.expectedPrice.toFixed(2)}）`);
  console.log(`  取餐方式 : ${ORDER.takeWayCode}（外带）`);
  console.log(`  预约时间 : ${ORDER.reservationDate}（此刻门店未营业，只能走预约链路）`);
  console.log('  执行顺序 : calculate-price → create-order → query-order → cancel-order(1) → query-order');
  console.log('  花费     : ¥0（只建单不付款，支付链接不打开，扫描完立即取消）');
  console.log('\n确认无误后执行：npm run mcp:order -w @mcd/server -- --confirm');
}

async function main(): Promise<void> {
  const confirmed = process.argv.includes('--confirm');
  if (!confirmed) {
    printPlan();
    return;
  }

  const config = loadMcpConfig();
  console.log('⚠️  真实下单：1 份商品，不付款，抓完立即取消');
  console.log(`endpoint : ${config.url}`);
  console.log(`token    : ${maskToken(config.token)}`);
  console.log(`order    : ${ORDER.storeCode} / ${ORDER.productCode} × ${ORDER.quantity} / ${ORDER.reservationDate}`);
  console.log('');

  const client = new McpClient({ url: config.url, token: config.token });
  const probe = new OrderProbe(client);
  const base = {
    storeCode: ORDER.storeCode,
    orderType: ORDER.orderType,
    beType: ORDER.beType,
    reservationDate: ORDER.reservationDate,
  };
  const items = [{ productCode: ORDER.productCode, quantity: ORDER.quantity }];

  const outcome = { created: false, orderIdMasked: '', queryOk: false, cancelOk: false, cancelConfirmed: false };

  try {
    const info = await client.connect();
    console.log(`handshake: ok | ${info.serverInfo.name} v${info.serverInfo.version} | ${info.protocolVersion}`);
    probe.indexTools(await client.listTools());
    console.log('');

    // 1. Price first: confirms the store is orderable and yields the takeWayCode.
    const priced = await probe.call('calculate-price', { ...base, items });
    const takeWayList = (priced.data as Record<string, unknown> | undefined)?.takeWayList;
    const takeWayCode =
      Array.isArray(takeWayList) && takeWayList.length > 0
        ? String((takeWayList[0] as Record<string, unknown>).code ?? ORDER.takeWayCode)
        : ORDER.takeWayCode;
    const price = num((priced.data as Record<string, unknown> | undefined)?.price);
    console.log(`  → takeWayCode=${takeWayCode}${price === undefined ? '' : ` / 应付 ${(price / 100).toFixed(2)} 元`}`);

    // 2. Create the single order.
    const created = await probe.call('create-order', { ...base, takeWayCode, items });
    const fields: Record<string, unknown> = {};
    collect(created.data, ['orderId', 'orderNo', 'payId', 'payH5Url', 'status'], fields);
    const orderId = typeof fields.orderId === 'string' ? fields.orderId : undefined;

    if (orderId === undefined) {
      console.log('\ncreate-order 没拿到 orderId，未产生可取消的订单（或字段名不同，见 snapshot）。');
      return;
    }

    outcome.created = true;
    outcome.orderIdMasked = `${orderId.slice(0, 4)}<masked>`;
    console.log(`  → orderId=${orderId}  payH5Url=${fields.payH5Url === undefined ? '无' : '已返回（不打开、不落盘）'}`);

    // 3 + 4. Query, then cancel. The cancel sits in `finally` so a failed query
    // still leaves the account clean.
    try {
      const queried = await probe.call('query-order', { orderId });
      outcome.queryOk = queried.step.ok && !queried.step.isError;
    } finally {
      const cancelled = await probe.call('cancel-order', { orderId, cancelReasonCode: '1' });
      outcome.cancelOk = cancelled.step.ok && !cancelled.step.isError;
    }

    // 5. Verify the cancellation actually took effect.
    const verify = await probe.call('query-order', { orderId });
    const statusText = JSON.stringify(redact(verify.data) ?? '');
    outcome.cancelConfirmed = /取消|cancel/i.test(statusText);
    console.log(
      `\n  取消结果: cancelOk=${String(outcome.cancelOk)} / query 里出现「取消」字样=${String(outcome.cancelConfirmed)}`,
    );
    if (!outcome.cancelConfirmed) {
      console.log('  ⚠️ 未能确认已取消，请到麦当劳 App「我的订单」手工核对（未付款订单也会超时自动关闭）。');
    }
  } finally {
    const summary = {
      created: outcome.created,
      orderId: outcome.orderIdMasked || undefined,
      queryOk: outcome.queryOk,
      cancelOk: outcome.cancelOk,
      cancelConfirmed: outcome.cancelConfirmed,
      driftEntries: probe.steps.reduce((sum, step) => sum + (step.diffs?.length ?? 0), 0),
    };

    await mkdir(dirname(shapesPath), { recursive: true });
    await writeFile(
      shapesPath,
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          endpoint: config.url,
          redacted: true,
          purpose: '写链路空跑：建单不付款，抓 create-order / query-order / cancel-order 的真实形状后立即取消。',
          order: {
            storeCode: ORDER.storeCode,
            storeName: ORDER.storeName,
            productCode: ORDER.productCode,
            productName: ORDER.productName,
            quantity: ORDER.quantity,
            expectedPrice: ORDER.expectedPrice,
            takeWayCode: ORDER.takeWayCode,
            reservationDate: ORDER.reservationDate,
          },
          note: 'orderId 已打码，payH5Url 一律不落盘；其余字段按与只读探针相同的规则脱敏。',
          summary,
          steps: probe.steps,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    console.log(`\nsummary  : ${JSON.stringify(summary)}`);
    console.log(`snapshot : ${shapesPath}`);
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof McpHttpError) console.error(`[${error.kind}] ${error.message}`);
  else if (error instanceof McpTransportError) console.error(`[${error.kind}] ${error.message}`);
  else if (error instanceof McpRpcError) console.error(`[rpc ${error.code}] ${error.message}`);
  else if (error instanceof Error) console.error(`[error] ${error.message}`);
  else console.error('[error]', error);

  process.exitCode = 1;
});
