/**
 * Minimal Streamable HTTP client for the McDonald's MCP server.
 *
 * The project scaffold deliberately avoids third-party MCP / AI SDKs, so this
 * implements just the subset the app needs on top of Node's global `fetch`:
 * `initialize` → `notifications/initialized` → `tools/list` → `tools/call`.
 *
 * Reference: https://open.mcd.cn/mcp/doc (endpoint https://mcp.mcd.cn,
 * `Authorization: Bearer <token>`, protocol version up to 2025-06-18).
 */

import { McpHttpError, McpProtocolError, McpRpcError, McpTransportError } from './errors.js';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: McpServerInfo;
}

export interface McpClientOptions {
  /** Streamable HTTP endpoint, normally https://mcp.mcd.cn */
  url: string;
  /** Bearer token from https://open.mcd.cn/mcp */
  token: string;
  /** Highest protocol version this client understands. */
  protocolVersion?: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

type JsonRpcPayload = JsonRpcMessage & { method?: string; params?: unknown };

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Extracts `data:` payloads from one raw SSE event block. */
function parseSseEvent(raw: string): JsonRpcMessage | undefined {
  const data = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');

  if (!data.trim()) return undefined;

  try {
    return JSON.parse(data) as JsonRpcMessage;
  } catch {
    return undefined;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

export class McpClient {
  /** Endpoint this client talks to (no secrets). */
  readonly endpoint: string;
  /** Negotiated session id, set by the server during `initialize`. */
  sessionId: string | undefined;

  private readonly token: string;
  private readonly protocolVersion: string;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private nextId = 1;
  private info: McpInitializeResult | undefined;

  constructor(options: McpClientOptions) {
    this.endpoint = options.url;
    this.token = options.token;
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientName = options.clientName ?? 'mcd-mediation-rpg-server';
    this.clientVersion = options.clientVersion ?? '0.1.0';
  }

  /** Server identity reported by `initialize`, if connected. */
  get serverInfo(): McpServerInfo | undefined {
    return this.info?.serverInfo;
  }

  /** Protocol version actually negotiated with the server. */
  get negotiatedProtocolVersion(): string | undefined {
    return this.info?.protocolVersion;
  }

  get isConnected(): boolean {
    return this.info !== undefined;
  }

  /** Performs the MCP handshake once; subsequent calls are no-ops. */
  async connect(): Promise<McpInitializeResult> {
    if (this.info) return this.info;

    const id = this.nextId++;
    const response = await this.send({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      },
    });

    const result = (await this.readResult(response, id)) as Partial<McpInitializeResult> | undefined;
    if (!result || typeof result !== 'object') {
      throw new McpProtocolError('initialize 返回的 result 不是对象');
    }

    this.info = {
      protocolVersion: result.protocolVersion ?? this.protocolVersion,
      capabilities: result.capabilities ?? {},
      serverInfo: result.serverInfo ?? { name: 'unknown', version: 'unknown' },
    };

    await this.notify('notifications/initialized');
    return this.info;
  }

  /** Lists every tool, following `nextCursor` pagination. */
  async listTools(): Promise<McpTool[]> {
    await this.connect();

    const tools: McpTool[] = [];
    let cursor: string | undefined;

    for (;;) {
      const id = this.nextId++;
      const response = await this.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
        params: cursor === undefined ? {} : { cursor },
      });

      const result = (await this.readResult(response, id)) as
        | { tools?: McpTool[]; nextCursor?: string }
        | undefined;

      if (result?.tools) tools.push(...result.tools);
      if (!result?.nextCursor) return tools;
      cursor = result.nextCursor;
    }
  }

  /** Invokes one tool and returns its raw MCP result. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    await this.connect();

    const id = this.nextId++;
    const response = await this.send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    const result = (await this.readResult(response, id)) as McpToolCallResult | undefined;
    return result ?? {};
  }

  /** Best-effort session teardown; failures are ignored. */
  async disconnect(): Promise<void> {
    if (!this.sessionId) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      await fetch(this.endpoint, {
        method: 'DELETE',
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch {
      // Session cleanup is optional; the server expires idle sessions anyway.
    } finally {
      clearTimeout(timer);
      this.sessionId = undefined;
      this.info = undefined;
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
    };

    if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId;
    if (this.info !== undefined) headers['mcp-protocol-version'] = this.info.protocolVersion;

    return headers;
  }

  /** POSTs one JSON-RPC payload and validates the HTTP layer. */
  private async send(payload: JsonRpcPayload): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await safeText(response)).slice(0, 300);
        throw new McpHttpError(response.status, detail);
      }

      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;

      return response;
    } catch (error) {
      if (error instanceof McpHttpError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new McpTransportError('timeout', `MCP 请求超时（${this.timeoutMs}ms）：${this.endpoint}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error ? error.cause : undefined;
      const failures = cause instanceof AggregateError ? cause.errors : [cause];
      // Log only transport codes, never authorization headers or response bodies.
      console.error('[mcp] connection failed', {
        host: new URL(this.endpoint).hostname,
        codes: failures.map((failure: unknown) =>
          typeof failure === 'object' && failure !== null && 'code' in failure
            ? String(failure.code)
            : 'unknown',
        ),
      });
      throw new McpTransportError('network', `无法连接 ${this.endpoint}：${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async notify(method: string): Promise<void> {
    const response = await this.send({ jsonrpc: '2.0', method });
    await response.body?.cancel().catch(() => undefined);
  }

  private async readResult(response: Response, id: number): Promise<unknown> {
    const message = await this.readMessage(response, id);

    if (message.error) {
      throw new McpRpcError(message.error.code, message.error.message, message.error.data);
    }

    return message.result;
  }

  private async readMessage(response: Response, id: number): Promise<JsonRpcMessage> {
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    if (contentType.includes('text/event-stream')) {
      return this.readSseMessage(response, id);
    }

    const text = await safeText(response);
    if (text === '') throw new McpProtocolError('MCP 返回了空响应体');

    let parsed: JsonRpcMessage | JsonRpcMessage[];
    try {
      parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    } catch {
      throw new McpProtocolError(`无法解析 MCP 响应：${text.slice(0, 200)}`);
    }

    const message = Array.isArray(parsed) ? parsed.find((item) => item.id === id) : parsed;
    if (!message) throw new McpProtocolError(`响应中没有匹配 id=${id} 的 JSON-RPC 消息`);

    return message;
  }

  private async readSseMessage(response: Response, id: number): Promise<JsonRpcMessage> {
    const body = response.body;
    if (!body) throw new McpProtocolError('SSE 响应没有响应体');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const message = parseSseEvent(rawEvent);
          if (message && message.id === id) return message;

          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    throw new McpProtocolError('SSE 流已结束，但没有收到匹配的 JSON-RPC 响应');
  }
}
