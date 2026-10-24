/**
 * Read-only payload probe for the McDonald's MCP server.
 *
 * Run from the repository root:
 *   npm run mcp:shapes -w @mcd/server
 *
 * Calls the 8 MVP read-only tools once each (plus store discovery), captures the
 * real `structuredContent.data` shape, and diffs it against the `outputSchema`
 * that `tools/list` advertises. Output goes to docs/mcp-data-shapes.json, which
 * is the payload contract baseline for the app's TypeScript types.
 *
 * Two behaviours worth knowing:
 * - Store-scoped tools reject out-of-hours stores (code 600057). When the picked
 *   store reports `businessStatus: false`, the chain automatically switches to
 *   the reservation path (`reservationDate`, next noon) instead of failing.
 * - `list-nutrition-foods` returns `data` as a *compact table string*
 *   (`[160]{col,...}:\n  值,值,...`), not JSON. It is parsed here so the shape is
 *   recorded as real rows.
 *
 * Safety rules baked in:
 * - read-only tools only (no create-order / mall-create-order / draw-lottery /
 *   party-order-create / cancel-order / auto-bind-coupons / delivery-create-address);
 * - the token is never printed nor written to the snapshot;
 * - phone numbers, coupon codes, signed image URLs and secret-looking fields are
 *   redacted before anything is persisted, and long strings are truncated.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMcpConfig, maskToken } from '../config/env.js';
import { McpClient } from './client.js';
import type { JsonSchema, McpTool, McpToolCallResult } from './client.js';
import { McpHttpError, McpRpcError, McpTransportError } from './errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const shapesPath = resolve(repoRoot, 'docs/mcp-data-shapes.json');

/** Cities tried in order when `searchType=1` (favourites) returns nothing. */
const CITY_CANDIDATES = ['北京', '上海', '深圳', '广州', '杭州', '成都'];
const STORE_KEYWORD = '麦当劳';
/** How many stores / product codes to try before giving up on a payload. */
const STORE_ATTEMPTS = 3;
const CODE_ATTEMPTS = 3;

type ShapeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'unknown' | 'mixed';

interface ShapeNode {
  kind: ShapeKind;
  kinds?: string[];
  items?: ShapeNode;
  keys?: Record<string, ShapeNode>;
  optional?: string[];
  samples?: number;
  counts?: Record<string, number>;
  examples?: string[];
  lengths?: number[];
}

interface DiffEntry {
  path: string;
  kind: 'actual-extra' | 'declared-missing' | 'type-mismatch';
  detail: string;
}

/** Result of parsing the non-JSON payload formats this server uses. */
interface ParsedTextData {
  format: 'json-string' | 'compact-table' | 'plain-text';
  columns?: string[];
  declaredRowCount?: number;
  rowCount?: number;
  rows?: Record<string, string>[];
  /** Columns whose every cell is `null`/empty — treat them as absent fields. */
  nullLikeColumns?: string[];
  sample?: unknown;
}

interface CallRecord {
  /** `bonus` = read-only tool outside the MVP 8, sampled only to enrich a shape. */
  phase: 'discovery' | 'mvp' | 'bonus';
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  isError: boolean;
  durationMs: number;
  contentChars: number;
  contentHead: string;
  structuredKeys?: string[];
  envelope?: Record<string, unknown>;
  dataFormat?: ParsedTextData['format'];
  parsedText?: ParsedTextData;
  dataShape?: ShapeNode;
  declaredShape?: ShapeNode;
  diffs?: DiffEntry[];
  dataSample?: unknown;
  error?: { kind: string; message: string };
}

// --- redaction -------------------------------------------------------------

const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const SECRET_KEY = /token|authoriz|secret|password|cookie|session/i;
const URL_KEY = /image|url|icon|qr/i;
const STRING_LIMIT = 160;

function redactString(text: string, key = '', inCoupons = false): string {
  let masked = text.replace(PHONE, (match) => `${match.slice(0, 3)}****${match.slice(7)}`);
  if (URL_KEY.test(key)) masked = masked.replace(/\?.*$/, '?<signed>');
  // Long all-caps/alnum blobs are coupon codes or ids, never display text.
  const looksLikeToken = /^[A-Z0-9]{16,}$/.test(masked);
  if (looksLikeToken || (inCoupons && (key === 'code' || key === 'id') && masked.length > 8)) {
    masked = `${masked.slice(0, 4)}<masked>`;
  }
  return masked.length <= STRING_LIMIT ? masked : `${masked.slice(0, STRING_LIMIT)}…`;
}

/** Recursively masks sensitive keys/values so the snapshot is safe to commit. */
function redact(value: unknown, path: string[] = [], depth = 0): unknown {
  const key = path[path.length - 1] ?? '';
  if (depth > 10) return '[depth-limit]';

  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) return '***';
    return redactString(value, key, path.includes('coupons'));
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => redact(item, path, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = SECRET_KEY.test(childKey) ? '***' : redact(childValue, [...path, childKey], depth + 1);
    }
    return out;
  }
  return String(value);
}

// --- shape inference -------------------------------------------------------

function kindOf(value: unknown): ShapeKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'object') {
    return type as ShapeKind;
  }
  return 'unknown';
}

function shapeOf(value: unknown, path: string[] = []): ShapeNode {
  const key = path[path.length - 1] ?? '';
  const kind = kindOf(value);

  if (kind === 'array') {
    const list = value as unknown[];
    const items = list.reduce<ShapeNode | undefined>((acc, item) => {
      const node = shapeOf(item, path);
      return acc === undefined ? node : mergeShape(acc, node);
    }, undefined);
    return { kind: 'array', items, lengths: [list.length] };
  }
  if (kind === 'object') {
    const keys: Record<string, ShapeNode> = {};
    const counts: Record<string, number> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      keys[childKey] = shapeOf(child, [...path, childKey]);
      counts[childKey] = 1;
    }
    return { kind: 'object', keys, counts, samples: 1, optional: [] };
  }
  // Examples go through the same redaction as samples: shapes must never leak codes.
  if (kind === 'string') {
    return { kind, examples: [redactString(value as string, key, path.includes('coupons'))] };
  }
  return { kind };
}

function mergeShape(a: ShapeNode, b: ShapeNode): ShapeNode {
  if (a.kind !== b.kind && a.kind !== 'null' && b.kind !== 'null') {
    const kinds = new Set<string>([...(a.kinds ?? [a.kind]), ...(b.kinds ?? [b.kind])]);
    return { kind: 'mixed', kinds: [...kinds] };
  }
  if (a.kind === 'null' && b.kind !== 'null') return b;
  if (b.kind === 'null' && a.kind !== 'null') return a;

  if (a.kind === 'array') {
    const items = a.items && b.items ? mergeShape(a.items, b.items) : (a.items ?? b.items);
    return { kind: 'array', items, lengths: [...(a.lengths ?? []), ...(b.lengths ?? [])] };
  }

  if (a.kind === 'object') {
    const keys: Record<string, ShapeNode> = {};
    const counts: Record<string, number> = {};
    const aSamples = a.samples ?? 1;
    const bSamples = b.samples ?? 1;
    for (const key of new Set([...Object.keys(a.keys ?? {}), ...Object.keys(b.keys ?? {})])) {
      const left = a.keys?.[key];
      const right = b.keys?.[key];
      if (left && right) keys[key] = mergeShape(left, right);
      else keys[key] = (left ?? right) as ShapeNode;
      counts[key] = (a.counts?.[key] ?? (left ? aSamples : 0)) + (b.counts?.[key] ?? (right ? bSamples : 0));
    }
    const samples = aSamples + bSamples;
    return {
      kind: 'object',
      keys,
      counts,
      samples,
      optional: Object.keys(counts).filter((key) => counts[key] < samples),
    };
  }

  if (a.kind === 'string') {
    return { kind: 'string', examples: [...(a.examples ?? []), ...(b.examples ?? [])].slice(0, 3) };
  }

  return { kind: a.kind };
}

/** Turns a JSON-Schema fragment (MCP `outputSchema`) into the same ShapeNode form. */
function shapeFromSchema(schema: JsonSchema | undefined): ShapeNode | undefined {
  if (!schema) return undefined;
  const type = schema.type;
  if (type === 'array') return { kind: 'array', items: shapeFromSchema(schema.items) };
  if (type === 'object' || schema.properties) {
    const keys: Record<string, ShapeNode> = {};
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      keys[key] = shapeFromSchema(child) ?? { kind: 'unknown' };
    }
    return { kind: 'object', keys, samples: 1, optional: [] };
  }
  if (type === 'string') return { kind: 'string' };
  if (type === 'integer' || type === 'number') return { kind: 'number' };
  if (type === 'boolean') return { kind: 'boolean' };
  if (type === 'null') return { kind: 'null' };
  return { kind: 'unknown' };
}

/**
 * The server describes dynamic dictionaries (`data.meals`, keyed by product
 * code) as an object with a single `mapKey` placeholder property. Diffing it
 * key-by-key would report every product code as drift, so compare the first
 * real value against the placeholder instead.
 */
function isDynamicMapSchema(node: ShapeNode): boolean {
  const keys = Object.keys(node.keys ?? {});
  return node.kind === 'object' && keys.length === 1 && keys[0] === 'mapKey';
}

/** Walks actual vs declared shapes and reports structural drift. */
function diffShapes(actual: ShapeNode | undefined, declared: ShapeNode | undefined, path = 'data'): DiffEntry[] {
  if (!actual || !declared || declared.kind === 'unknown') return [];
  const entries: DiffEntry[] = [];

  if (actual.kind !== declared.kind && actual.kind !== 'mixed') {
    if (!(actual.kind === 'null' && declared.kind !== 'null')) {
      entries.push({ path, kind: 'type-mismatch', detail: `declared ${declared.kind}, actual ${actual.kind}` });
    }
    return entries;
  }

  if (actual.kind === 'array') {
    entries.push(...diffShapes(actual.items, declared.items, `${path}[]`));
    return entries;
  }

  if (actual.kind === 'object') {
    const actualKeys = actual.keys ?? {};
    const declaredKeys = declared.keys ?? {};

    if (isDynamicMapSchema(declared)) {
      const placeholder = declaredKeys.mapKey;
      const firstValue = Object.values(actualKeys)[0];
      if (placeholder && firstValue) entries.push(...diffShapes(firstValue, placeholder, `${path}{}`));
      return entries;
    }

    for (const key of Object.keys(actualKeys)) {
      if (!(key in declaredKeys)) {
        entries.push({ path: `${path}.${key}`, kind: 'actual-extra', detail: `actual ${actualKeys[key]?.kind}` });
      }
    }
    for (const key of Object.keys(declaredKeys)) {
      if (!(key in actualKeys)) {
        entries.push({
          path: `${path}.${key}`,
          kind: 'declared-missing',
          detail: `declared ${declaredKeys[key]?.kind}`,
        });
      }
    }
    for (const key of Object.keys(actualKeys)) {
      const declaredChild = declaredKeys[key];
      if (declaredChild) entries.push(...diffShapes(actualKeys[key], declaredChild, `${path}.${key}`));
    }
  }

  return entries;
}

// --- payload parsing -------------------------------------------------------

/**
 * Parses the compact table format `list-nutrition-foods` uses:
 *
 *   [160]{productName,energyKcal,...}:
 *     猪柳麦满分,308,...
 *     猪柳蛋麦满分,387,...
 */
function parseCompactTable(text: string): ParsedTextData | undefined {
  const match = /^\[(\d+)\]\{([^}]*)\}:\s*\n?([\s\S]*)$/.exec(text.trim());
  if (!match) return undefined;

  const declaredRowCount = Number(match[1]);
  const columns = (match[2] ?? '').split(',').map((column) => column.trim()).filter(Boolean);
  const body = (match[3] ?? '').trim();
  if (columns.length === 0) return undefined;

  const rows = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const cells = line.split(',');
      const row: Record<string, string> = {};
      columns.forEach((column, index) => {
        row[column] = (cells[index] ?? '').trim();
      });
      return row;
    });

  return {
    format: 'compact-table',
    columns,
    declaredRowCount,
    rowCount: rows.length,
    rows: rows.slice(0, 2),
    nullLikeColumns: columns.filter((column) =>
      rows.every((row) => row[column] === '' || row[column].toLowerCase() === 'null'),
    ),
    sample: rows[0],
  };
}

function describeData(value: unknown): { data: unknown; parsed?: ParsedTextData } {
  if (typeof value !== 'string') return { data: value };

  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return { data: parsed, parsed: { format: 'json-string', sample: redact(parsed) } };
    } catch {
      // Fall through: not JSON after all.
    }
  }

  const table = parseCompactTable(trimmed);
  if (table) return { data: trimmed, parsed: { ...table, sample: redact(table.sample) } };

  return { data: trimmed, parsed: { format: 'plain-text', sample: redactString(trimmed) } };
}

// --- helpers ---------------------------------------------------------------

function textOf(result: McpToolCallResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n');
}

function firstLine(text: string, width = 84): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function errorKindOf(error: unknown): string {
  if (error instanceof McpHttpError) return error.kind;
  if (error instanceof McpTransportError) return error.kind;
  if (error instanceof McpRpcError) return `rpc-${error.code}`;
  return 'error';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Store {
  storeCode: string;
  storeName?: string;
  address?: string;
  businessStatus?: boolean;
}

/** A payload counts as usable when it carries at least one real record. */
function isUsablePayload(data: unknown): boolean {
  if (data === undefined || data === null) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === 'string') return data.trim().length > 0;
  if (typeof data === 'object') return Object.keys(data as Record<string, unknown>).length > 0;
  return true;
}

function pickStores(data: unknown, limit: number): Store[] {
  if (!Array.isArray(data)) return [];
  const stores: Store[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.storeCode !== 'string' || record.storeCode.length === 0) continue;
    stores.push({
      storeCode: record.storeCode,
      storeName: typeof record.storeName === 'string' ? record.storeName : undefined,
      address: typeof record.address === 'string' ? record.address : undefined,
      businessStatus: typeof record.businessStatus === 'boolean' ? record.businessStatus : undefined,
    });
    if (stores.length >= limit) break;
  }
  return stores;
}

/** Depth-first search for product codes: `data.meals` keys plus `code` fields. */
function findProductCodes(data: unknown, limit: number): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (found.length >= limit || node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if ((key === 'code' || key === 'productCode') && typeof value === 'string' && value.length > 0) {
        found.push(value);
        if (found.length >= limit) return;
      }
      if (value && typeof value === 'object') walk(value);
    }
  };

  walk(data);
  return [...new Set(found)].slice(0, limit);
}

/** `12:00` on the next day that is still in the future, in `yyyy-MM-dd HH:mm`. */
function nextNoon(serverDatetime: string): string {
  const base = new Date(serverDatetime.replace(' ', 'T'));
  const date = Number.isNaN(base.getTime()) ? new Date() : base;
  const target = new Date(date);
  if (date.getHours() >= 11) target.setDate(target.getDate() + 1);
  target.setHours(12, 0, 0, 0);

  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())} 12:00`;
}

// --- probe -----------------------------------------------------------------

class DataShapeProbe {
  private readonly client: McpClient;
  private readonly tools = new Map<string, McpTool>();
  private readonly toolOutcome = new Map<string, 'ok' | 'failed' | 'empty' | 'skipped'>();
  readonly calls: CallRecord[] = [];

  constructor(client: McpClient) {
    this.client = client;
  }

  indexTools(tools: McpTool[]): void {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  private declaredDataShape(toolName: string): ShapeNode | undefined {
    return shapeFromSchema(this.tools.get(toolName)?.outputSchema?.properties?.data);
  }

  /** Runs one `tools/call`, captures shape, diff and a redacted sample. */
  async call(
    phase: CallRecord['phase'],
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ record: CallRecord; data: unknown }> {
    const record: CallRecord = {
      phase,
      tool,
      args: redact(args) as Record<string, unknown>,
      ok: false,
      isError: false,
      durationMs: 0,
      contentChars: 0,
      contentHead: '',
    };

    let rawData: unknown;
    const startedAt = Date.now();

    try {
      const result = await this.client.callTool(tool, args);
      record.durationMs = Date.now() - startedAt;
      record.ok = true;
      record.isError = result.isError === true;

      const text = textOf(result);
      record.contentChars = text.length;
      record.contentHead = firstLine(text);

      const structured = result.structuredContent as Record<string, unknown> | undefined;
      if (structured && typeof structured === 'object') {
        record.structuredKeys = Object.keys(structured);
        record.envelope = redact(structured) as Record<string, unknown>;
      } else if (text.length > 0) {
        record.structuredKeys = [];
        record.envelope = { message: 'structuredContent 缺失，只有 content 文本' };
      }

      let data: unknown = structured?.data;
      if (data === undefined && structured !== undefined && !('code' in structured)) {
        data = structured;
      }

      const described = describeData(data);
      if (described.parsed) {
        record.dataFormat = described.parsed.format;
        record.parsedText = described.parsed;
      }
      rawData = described.data;

      if (rawData !== undefined) {
        record.dataShape = shapeOf(rawData);
        record.declaredShape = this.declaredDataShape(tool);
        record.diffs = diffShapes(record.dataShape, record.declaredShape);
        record.dataSample = redact(rawData);
      }
    } catch (error: unknown) {
      record.durationMs = Date.now() - startedAt;
      record.error = { kind: errorKindOf(error), message: describeError(error) };
    }

    this.calls.push(record);
    const succeeded = record.ok && !record.isError && (num(record.envelope?.code) ?? 200) === 200;
    if (succeeded) this.toolOutcome.set(tool, 'ok');
    else if (this.toolOutcome.get(tool) !== 'ok') this.toolOutcome.set(tool, 'failed');
    this.report(record);

    // Callers chain on the *unredacted* payload; only the snapshot is masked.
    return { record, data: rawData };
  }

  private report(record: CallRecord): void {
    const status = record.ok ? (record.isError ? 'isError' : 'ok') : `FAIL ${record.error?.kind ?? ''}`;
    const drift = record.diffs?.length ?? 0;
    console.log(
      `  ${padRight(record.tool, 24)} ${padRight(status, 13)} ${String(record.durationMs).padStart(5)}ms  ` +
        `content ${String(record.contentChars).padStart(5)}  drift ${String(drift).padStart(3)}` +
        (record.dataFormat === 'compact-table' ? '  [紧凑表格]' : record.dataFormat === 'json-string' ? '  [JSON 字符串]' : ''),
    );
    if (!record.ok) console.log(`      ↳ ${record.error?.message ?? ''}`);
    const code = num(record.envelope?.code);
    if (record.ok && record.isError) {
      console.log(`      ↳ MCP 层标记 isError，业务码 ${String(record.envelope?.code)} ${String(record.envelope?.message ?? '')}`);
    } else if (code !== undefined && code !== 200) {
      console.log(`      ↳ 业务码 ${code} ${String(record.envelope?.message ?? '')}`);
    }
    for (const diff of (record.diffs ?? []).slice(0, 6)) {
      console.log(`      · ${diff.kind.padEnd(16)} ${diff.path} (${diff.detail})`);
    }
    if ((record.diffs?.length ?? 0) > 6) console.log(`      · …另有 ${(record.diffs?.length ?? 0) - 6} 处`);
  }

  /** Finds real stores: favourites first, then a city keyword search per city. */
  async discoverStores(): Promise<Store[]> {
    console.log('  discovery: query-nearby-stores ...');
    const favourite = await this.call('discovery', 'query-nearby-stores', { beType: 1, searchType: 1 });
    const fromFavourite = pickStores(favourite.data, STORE_ATTEMPTS);
    if (fromFavourite.length > 0) return fromFavourite;

    for (const city of CITY_CANDIDATES) {
      const attempt = await this.call('discovery', 'query-nearby-stores', {
        beType: 1,
        searchType: 2,
        city,
        keyword: STORE_KEYWORD,
      });
      const stores = pickStores(attempt.data, 5);
      if (stores.length > 0) {
        console.log(`  discovery: ${city} 命中 ${stores.length} 家门店`);
        return stores;
      }
      if (!attempt.record.ok) break;
    }

    return [];
  }

  /** Tries each arg variant until one lands a usable, non-empty payload. */
  async firstUsable(
    tool: string,
    variants: Record<string, unknown>[],
  ): Promise<{ record: CallRecord | undefined; data: unknown }> {
    let last: CallRecord | undefined;
    for (const args of variants) {
      const { record, data } = await this.call('mvp', tool, args);
      last = record;
      const succeeded = record.ok && !record.isError && (num(record.envelope?.code) ?? 200) === 200;
      if (succeeded && isUsablePayload(data)) return { record, data };
    }
    // Every variant came back empty or failed: record that honestly.
    const lastSucceeded = last?.ok === true && !last.isError;
    this.toolOutcome.set(tool, lastSucceeded ? 'empty' : 'failed');
    return { record: last, data: undefined };
  }

  /** Records a tool we deliberately did not call (no real product code to pass). */
  markSkipped(tool: string, reason: string): void {
    this.toolOutcome.set(tool, 'skipped');
    console.log(`  ${padRight(tool, 24)} SKIP          ${reason}`);
  }

  summary(): Record<string, unknown> {
    const mvp = this.calls.filter((call) => call.phase === 'mvp');
    const covered = [...this.toolOutcome.entries()];
    const bonus = this.calls.filter((call) => call.phase === 'bonus');
    return {
      calls: this.calls.length,
      mvpCalls: mvp.length,
      toolsCovered: covered.length,
      toolsOk: covered.filter(([, outcome]) => outcome === 'ok').length,
      toolsEmpty: covered.filter(([, outcome]) => outcome === 'empty').length,
      toolsFailed: covered.filter(([, outcome]) => outcome === 'failed').length,
      bonusCalls: bonus.length,
      failures: mvp.filter((call) => !call.ok || call.isError).length,
      driftEntries: mvp.reduce((sum, call) => sum + (call.diffs?.length ?? 0), 0),
    };
  }
}

async function main(): Promise<void> {
  const config = loadMcpConfig();
  console.log(`endpoint : ${config.url}`);
  console.log(`token    : ${maskToken(config.token)}`);
  console.log('');

  const client = new McpClient({ url: config.url, token: config.token });
  const probe = new DataShapeProbe(client);

  try {
    const info = await client.connect();
    console.log(`handshake: ok | ${info.serverInfo.name} v${info.serverInfo.version} | ${info.protocolVersion}`);
    const tools = await client.listTools();
    probe.indexTools(tools);
    console.log(`tools    : ${tools.length}`);
    console.log('');

    // 1/8 — server clock; also the cheapest proof that `tools/call` works.
    const clock = await probe.call('mvp', 'now-time-info', {});
    const serverDatetime =
      typeof (clock.data as Record<string, unknown> | undefined)?.formatted === 'string'
        ? String((clock.data as Record<string, unknown>).formatted)
        : new Date().toISOString().slice(0, 16).replace('T', ' ');
    const reservation = nextNoon(serverDatetime);
    console.log(`\n  server time: ${serverDatetime} → 预约采样时间 ${reservation}`);

    // 2/8 — store discovery feeds every later call.
    const stores = await probe.discoverStores();
    if (stores.length === 0) {
      console.log('\n没有拿到可用 storeCode，门店相关工具无法取样。');
    } else {
      const primary = stores.find((store) => store.businessStatus === true) ?? stores[0];
      console.log(
        `\n  store: ${primary.storeCode} ${primary.storeName ?? ''} | 营业中=${String(primary.businessStatus)} | ${primary.address ?? ''}`,
      );

      const base = { storeCode: primary.storeCode, orderType: 1, beType: 1 };
      // Out-of-hours stores reject with 600057; the reservation path is the escape hatch.
      const variants = primary.businessStatus === true ? [base, { ...base, reservationDate: reservation }] : [{ ...base, reservationDate: reservation }, base];

      // 3/8 — live menu (largest payload in the MVP set).
      const meals = await probe.firstUsable('query-meals', variants);
      const codes = findProductCodes(meals.data, 4);
      console.log(`  product codes: ${codes.slice(0, 4).join(', ') || '（无）'}`);

      // 4/8 — one meal detail per product code until one lands.
      if (codes.length > 0) {
        const detailVariants = codes.slice(0, CODE_ATTEMPTS).flatMap((code) =>
          variants.map((variant) => ({ ...variant, code })),
        );
        await probe.firstUsable('query-meal-detail', detailVariants);
      } else {
        probe.markSkipped('query-meal-detail', '菜单里没有可用 productCode');
      }

      // 5/8 — coupons valid for this store; other stores tried if the list is empty.
      const couponVariants = stores
        .slice(0, STORE_ATTEMPTS)
        .flatMap((store) =>
          variants.map((variant) => ({ ...variant, storeCode: store.storeCode })),
        );
      await probe.firstUsable('query-store-coupons', couponVariants);

      // 6/8 — static nutrition table (no params, compact-table payload).
      await probe.call('mvp', 'list-nutrition-foods', {});

      // 7/8 — the user's own coupon wallet.
      await probe.call('mvp', 'query-my-coupons', {});

      // Bonus: the store had no claimable coupons, so sample the claimable pool
      // (read-only) to at least capture one coupon-item shape for the UI types.
      await probe.call('bonus', 'available-coupons', {});

      // 8/8 — price trial; `calculate-price` never creates an order.
      if (codes.length > 0) {
        const priceVariants = codes.slice(0, CODE_ATTEMPTS).flatMap((code) =>
          variants.map((variant) => ({
            ...variant,
            items: [{ productCode: code, quantity: 1 }],
          })),
        );
        await probe.firstUsable('calculate-price', priceVariants);
      } else {
        probe.markSkipped('calculate-price', '菜单里没有可用 productCode');
      }
    }

    const summary = probe.summary();
    await mkdir(dirname(shapesPath), { recursive: true });
    const payload = {
      capturedAt: new Date().toISOString(),
      endpoint: config.url,
      protocolVersion: info.protocolVersion,
      serverInfo: info.serverInfo,
      redacted: true,
      samplingNote:
        '取样时刻门店未营业，门店相关工具带 reservationDate 走预约链路（与下单链路参数一致的要求相同）。',
      note:
        '真实 tools/call 取样。args 已脱敏，字符串已截断（160 字符），手机号/券码/带签名图片 URL 已掩码；' +
        'diffs 是「实测 data 结构」与「tools/list 声明 outputSchema.data」的差异；' +
        'parsedText 记录非 JSON 载荷（紧凑表格 / JSON 字符串）的解析结果。',
      summary,
      calls: probe.calls,
    };
    await writeFile(shapesPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    console.log('');
    console.log(`calls    : ${String(summary.calls)}（MVP ${String(summary.mvpCalls)} 次）`);
    console.log(
      `tools    : 覆盖 ${String(summary.toolsCovered)} / 有数据 ${String(summary.toolsOk)} / ` +
        `空结果 ${String(summary.toolsEmpty)} / 失败 ${String(summary.toolsFailed)}`,
    );
    console.log(`drift    : ${String(summary.driftEntries)} 处与 outputSchema 不一致`);
    console.log(`snapshot : ${shapesPath}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof McpHttpError) {
    console.error(`[${error.kind}] ${error.message}`);
  } else if (error instanceof McpTransportError) {
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
