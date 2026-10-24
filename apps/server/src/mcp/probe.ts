/**
 * One-shot probe against the McDonald's MCP server.
 *
 * Run from the repository root:
 *   npm run mcp:probe -w @mcd/server
 *
 * Verifies the handshake, dumps every tool's real `inputSchema` to
 * docs/mcp-tools.snapshot.json (the contract baseline), and calls a single
 * read-only tool to prove the full `tools/call` path works.
 *
 * It never prints the token and never calls anything that costs money or
 * points: only `now-time-info` is invoked.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMcpConfig, maskToken } from '../config/env.js';
import { McpClient } from './client.js';
import type { McpTool, McpToolCallResult } from './client.js';
import { McpHttpError, McpRpcError, McpTransportError } from './errors.js';

/** Tool we call to prove `tools/call` works; read-only, no side effects. */
const SMOKE_TOOL = 'now-time-info';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const snapshotPath = resolve(repoRoot, 'docs/mcp-tools.snapshot.json');

function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function describeSchema(tool: McpTool): string {
  const required = tool.inputSchema?.required ?? [];
  const total = Object.keys(tool.inputSchema?.properties ?? {}).length;
  if (total === 0) return '无入参';
  const requiredText = required.length > 0 ? required.join(',') : '—';
  return `必填:${requiredText} (共${total}个参数)`;
}

/** Concatenates the text blocks of a tool result for console output. */
function textOf(result: McpToolCallResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n');
}

function printToolTable(tools: McpTool[]): void {
  const nameWidth = Math.min(34, Math.max(...tools.map((tool) => tool.name.length)));
  tools.forEach((tool, index) => {
    const indexText = String(index + 1).padStart(2, ' ');
    const name = padRight(tool.name, nameWidth);
    const title = tool.title ?? '';
    const params = describeSchema(tool);
    console.log(`${indexText}. ${name}  ${padRight(params, 26)} ${truncate(title, 40)}`);
  });
}

async function main(): Promise<void> {
  const config = loadMcpConfig();
  console.log(`endpoint : ${config.url}`);
  console.log(`token    : ${maskToken(config.token)}`);

  const client = new McpClient({ url: config.url, token: config.token });

  try {
    const startedAt = Date.now();
    const info = await client.connect();
    console.log(`handshake: ok in ${Date.now() - startedAt}ms`);
    console.log(`server   : ${info.serverInfo.name} v${info.serverInfo.version}`);
    console.log(`protocol : ${info.protocolVersion}${client.sessionId ? ` (session ${client.sessionId})` : ''}`);

    const tools = await client.listTools();
    console.log(`tools    : ${tools.length}`);
    console.log('');
    printToolTable(tools);

    console.log('');
    console.log(`smoke    : tools/call ${SMOKE_TOOL} ...`);
    const result = await client.callTool(SMOKE_TOOL, {});
    const body = textOf(result) || JSON.stringify(result.structuredContent ?? result);
    console.log(`         isError=${String(result.isError ?? false)}`);
    console.log(`         ${truncate(body, 300)}`);

    await mkdir(dirname(snapshotPath), { recursive: true });
    const snapshot = {
      capturedAt: new Date().toISOString(),
      endpoint: config.url,
      protocolVersion: info.protocolVersion,
      serverInfo: info.serverInfo,
      capabilities: info.capabilities,
      toolCount: tools.length,
      tools,
    };
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

    console.log('');
    console.log(`snapshot : ${snapshotPath}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof McpHttpError && error.kind === 'unauthorized') {
    console.error(`[401] ${error.message}`);
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
