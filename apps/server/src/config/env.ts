/**
 * Server-side configuration for the McDonald's MCP integration.
 *
 * These values are server-only by design: the MCP token authenticates a real
 * McDonald's account and can create orders and spend points, so it must never
 * be exposed to the browser bundle. Vite inlines anything prefixed with
 * `VITE_`, hence the explicit guard below.
 */

export interface McpConfig {
  /** Streamable HTTP endpoint, e.g. https://mcp.mcd.cn */
  url: string;
  /** Bearer token issued at https://open.mcd.cn/mcp */
  token: string;
}

export interface LoadMcpConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Skip the hard failure so tooling can explain what is missing itself. */
  allowMissing?: boolean;
}

const TOKEN_HELP = [
  'MCD_MCP_TOKEN 未配置。',
  '  1. 打开 https://open.mcd.cn/mcp 登录 → 控制台 → 激活 → 复制 Token',
  '  2. Copy-Item .env.example .env',
  '  3. 在 .env 中填写 MCD_MCP_TOKEN=（不要加 VITE_ 前缀，否则会泄漏到浏览器）',
].join('\n');

const URL_HELP = 'MCD_MCP_URL 未配置。默认应为 https://mcp.mcd.cn（见 .env.example）。';

/** Reads MCP settings from the environment and fails loudly when incomplete. */
export function loadMcpConfig(options: LoadMcpConfigOptions = {}): McpConfig {
  const env = options.env ?? process.env;

  // A VITE_-prefixed secret would be inlined into the client bundle.
  const leaked = Object.keys(env).filter((key) => /^VITE_.*MCD.*(TOKEN|SECRET|KEY)/i.test(key));
  if (leaked.length > 0) {
    throw new Error(`发现疑似泄漏到前端的安全变量：${leaked.join(', ')}。请改名去掉 VITE_ 前缀。`);
  }

  const url = env.MCD_MCP_URL?.trim();
  const token = env.MCD_MCP_TOKEN?.trim();

  if (!options.allowMissing) {
    if (!url) throw new Error(URL_HELP);
    if (!token) throw new Error(TOKEN_HELP);
  }

  return { url: url ?? '', token: token ?? '' };
}

/** Masks a token for logs: keeps a 3-char prefix and suffix only. */
export function maskToken(token: string): string {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 3)}***${token.slice(-3)} (len=${token.length})`;
}
