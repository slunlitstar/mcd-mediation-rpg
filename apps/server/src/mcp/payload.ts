/**
 * Shared payload utilities for the McDonald's MCP probes.
 *
 * Both `probe-data.ts` (read-only) and `probe-order.ts` (write path) dump real
 * payloads into `docs/`, so masking and shape inference must live in one place:
 * a single redaction rule that only one probe respects is a data leak waiting to
 * happen.
 */

import type { JsonSchema, McpToolCallResult } from './client.js';
import { McpHttpError, McpRpcError, McpTransportError } from './errors.js';

export type ShapeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'unknown' | 'mixed';

export interface ShapeNode {
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

export interface DiffEntry {
  path: string;
  kind: 'actual-extra' | 'declared-missing' | 'type-mismatch';
  detail: string;
}

/** Result of parsing the non-JSON payload formats this server uses. */
export interface ParsedTextData {
  format: 'json-string' | 'compact-table' | 'plain-text';
  columns?: string[];
  declaredRowCount?: number;
  rowCount?: number;
  rows?: Record<string, string>[];
  /** Columns whose every cell is `null`/empty — treat them as absent fields. */
  nullLikeColumns?: string[];
  sample?: unknown;
}

// --- redaction -------------------------------------------------------------

const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const SECRET_KEY = /token|authoriz|secret|password|cookie|session/i;
const URL_KEY = /image|url|icon|qr/i;
const STRING_LIMIT = 160;

export function redactString(text: string, key = '', inCoupons = false): string {
  // Payment links must never reach disk, not even with the query stripped.
  if (/pay.*url/i.test(key)) return '<payment-url-hidden>';
  // Order ids are account-scoped identifiers: keep the shape, hide the value.
  if (/^(orderId|orderNo|orderCode)$/i.test(key) && text.length > 6) return `${text.slice(0, 4)}<masked>`;

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
export function redact(value: unknown, path: string[] = [], depth = 0): unknown {
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

export function shapeOf(value: unknown, path: string[] = []): ShapeNode {
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

export function mergeShape(a: ShapeNode, b: ShapeNode): ShapeNode {
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
export function shapeFromSchema(schema: JsonSchema | undefined): ShapeNode | undefined {
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
export function diffShapes(actual: ShapeNode | undefined, declared: ShapeNode | undefined, path = 'data'): DiffEntry[] {
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

export function describeData(value: unknown): { data: unknown; parsed?: ParsedTextData } {
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

export function textOf(result: McpToolCallResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n');
}

export function firstLine(text: string, width = 84): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

export function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function errorKindOf(error: unknown): string {
  if (error instanceof McpHttpError) return error.kind;
  if (error instanceof McpTransportError) return error.kind;
  if (error instanceof McpRpcError) return `rpc-${error.code}`;
  return 'error';
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
