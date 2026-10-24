/**
 * Error types for the McDonald's MCP client.
 *
 * The remote server distinguishes failures by HTTP status, and the same status
 * means different things to a caller, so every failure is normalised into a
 * typed error with a stable `kind` instead of a bare `Error`.
 */

/** Why an MCP request failed, in terms a caller can branch on. */
export type McpFailureKind =
  | 'unauthorized' // 401: token missing, invalid or expired
  | 'forbidden' // 403: gateway rejected the request outright
  | 'rate_limited' // 429: more than 600 requests/minute for this token
  | 'http_error' // any other non-2xx
  | 'timeout' // local abort
  | 'network' // DNS / TLS / connection failure
  | 'bad_response'; // 2xx we could not parse as JSON-RPC

/** Human-readable hint matching the platform's documented error codes. */
export function hintForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'MCP Token 无效、已过期或未提供：检查 .env 中的 MCD_MCP_TOKEN';
    case 403:
      return '网关拒绝了请求：通常是 Authorization 头缺失或格式不是 "Bearer <token>"';
    case 429:
      return '触发限流（600 次/分钟/Token）：降低调用频率后重试';
    default:
      return `MCP 服务返回 HTTP ${status}`;
  }
}

/** A non-2xx HTTP response from the MCP endpoint. */
export class McpHttpError extends Error {
  readonly kind: McpFailureKind;
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`${hintForStatus(status)}${detail ? ` — ${detail}` : ''}`);
    this.name = 'McpHttpError';
    this.status = status;
    this.kind =
      status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : 'http_error';
  }
}

/** A JSON-RPC level error returned inside a 2xx response. */
export class McpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`MCP 工具调用失败（code ${code}）: ${message}`);
    this.name = 'McpRpcError';
    this.code = code;
    this.data = data;
  }
}

/** The request never produced an HTTP response (DNS, TLS, abort). */
export class McpTransportError extends Error {
  readonly kind: McpFailureKind;

  constructor(kind: 'timeout' | 'network', message: string) {
    super(message);
    this.name = 'McpTransportError';
    this.kind = kind;
  }
}

/** A 2xx response whose body could not be understood. */
export class McpProtocolError extends Error {
  readonly kind: McpFailureKind = 'bad_response';

  constructor(message: string) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

/** Collapses any thrown value into one of the known failure kinds. */
export function toFailureKind(error: unknown): McpFailureKind {
  if (error instanceof McpHttpError) return error.kind;
  if (error instanceof McpTransportError) return error.kind;
  if (error instanceof McpProtocolError) return error.kind;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'timeout';
  return 'network';
}
