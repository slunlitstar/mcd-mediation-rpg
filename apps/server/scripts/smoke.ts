/**
 * 接口冒烟测试：对着**已经跑起来的服务**逐个打真实请求，输出通过/失败。
 *
 * 运行（先 `npm run dev:server`）：
 *   npm run smoke --workspace=@mcd/server
 *
 * 为什么不做成单元测试：这些接口的价值在于「真的连上了麦当劳 MCP」，
 * mock 掉 MCP 反而验证不到重点。这里直接打真接口，评委也能一条命令复现。
 */

const BASE = process.env.SMOKE_BASE_URL ?? `http://${process.env.SERVER_HOST ?? '127.0.0.1'}:${process.env.SERVER_PORT ?? '3001'}`;

interface Check {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

async function getJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // 非 JSON 响应（比如 404 纯文本）保留原文
  }
  return { status: response.status, body };
}

function dataOf(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  return record.ok === true && record.data !== undefined
    ? (record.data as Record<string, unknown>)
    : undefined;
}

const checks: Check[] = [
  {
    name: 'GET /api/health',
    run: async () => {
      const { status, body } = await getJson('/api/health');
      const data = dataOf(body);
      return {
        ok: status === 200 && data?.mcpConfigured === true,
        detail: `HTTP ${String(status)} mcpConfigured=${String(data?.mcpConfigured)} planner=${String(data?.planner)}`,
      };
    },
  },
  {
    name: 'GET /api/stores',
    run: async () => {
      const { status, body } = await getJson('/api/stores');
      const data = dataOf(body);
      const stores = Array.isArray(data) ? data : [];
      const first = stores[0] as Record<string, unknown> | undefined;
      return {
        ok: status === 200 && stores.length > 0,
        detail: `HTTP ${String(status)} 门店 ${String(stores.length)} 家，首个 ${String(first?.id)} ${String(first?.name)} 营业=${String(first?.businessStatus)}`,
      };
    },
  },
  {
    name: 'GET /api/menu（真实菜单）',
    run: async () => {
      const stores = await getJson('/api/stores');
      const list = (dataOf(stores.body) as unknown[] | undefined) ?? [];
      const storeCode = String((list[0] as Record<string, unknown> | undefined)?.id ?? '');
      if (storeCode === '') return { ok: false, detail: '没拿到 storeCode，跳过' };

      const { status, body } = await getJson(`/api/menu?storeCode=${encodeURIComponent(storeCode)}`);
      const data = dataOf(body);
      const meta = data?.meta as Record<string, unknown> | undefined;
      const items = data?.items as unknown[] | undefined;
      return {
        ok: status === 200 && Array.isArray(items) && items.length > 0,
        detail: `HTTP ${String(status)} 商品 ${String(meta?.itemCount)} 个 / 分类 ${String((data?.categories as unknown[] | undefined)?.length)} 个 / 套餐 ${String(meta?.comboCount)} 个`,
      };
    },
  },
  {
    name: 'POST /api/plan（多人协商 + 真实计价）',
    run: async () => {
      const stores = await getJson('/api/stores');
      const list = (dataOf(stores.body) as unknown[] | undefined) ?? [];
      const storeCode = String((list[0] as Record<string, unknown> | undefined)?.id ?? '');
      if (storeCode === '') return { ok: false, detail: '没拿到 storeCode，跳过' };

      const { status, body } = await getJson('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          storeCode,
          members: [
            { name: '忌辣的人', budget: 35, spicy: false },
            { name: '爱鸡肉的人', budget: 30, spicy: true, wantChicken: true },
            { name: '减脂的人', budget: 40, lightEater: true, wantVegetable: true },
          ],
        }),
      });

      const data = dataOf(body);
      const totals = data?.totals as Record<string, unknown> | undefined;
      const members = (data?.members as unknown[] | undefined) ?? [];
      const costSum = members.reduce(
        (sum, member) => sum + Number((member as Record<string, unknown>).cost ?? 0),
        0,
      );
      const payable = Number(totals?.payable ?? 0);

      // 关键自洽校验：成员花费之和必须等于 MCP 试算的应付
      const consistent = Math.abs(costSum - payable) < 0.011;

      return {
        ok: status === 200 && payable > 0 && consistent,
        detail:
          `HTTP ${String(status)} 应付 ¥${String(payable)} 优惠 ¥${String(totals?.discount)} ` +
          `人均 ¥${String(totals?.perPersonAvg)} 自洽=${String(consistent)}`,
      };
    },
  },
  {
    name: '错误路径：缺 storeCode 应 400',
    run: async () => {
      const { status } = await getJson('/api/menu');
      return { ok: status === 400, detail: `HTTP ${String(status)}（期望 400）` };
    },
  },
  {
    name: '错误路径：未知接口应 404',
    run: async () => {
      const { status } = await getJson('/api/not-exist');
      return { ok: status === 404, detail: `HTTP ${String(status)}（期望 404）` };
    },
  },
];

async function main(): Promise<void> {
  console.log(`smoke target: ${BASE}\n`);

  let failed = 0;
  for (const check of checks) {
    const startedAt = Date.now();
    try {
      const result = await check.run();
      const elapsed = Date.now() - startedAt;
      if (!result.ok) failed += 1;
      console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(38)} ${String(elapsed).padStart(5)}ms  ${result.detail}`);
    } catch (error: unknown) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAIL  ${check.name.padEnd(38)} ${'     '}  ${message}`);
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(`全部 ${String(checks.length)} 项通过`);
  } else {
    console.log(`${String(failed)} / ${String(checks.length)} 项失败`);
    process.exitCode = 1;
  }
}

await main();
