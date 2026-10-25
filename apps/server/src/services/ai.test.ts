/**
 * 模型接入层的隔离测试（离线）。
 *
 * 这里验证的是「模型说什么都不能直接信」：
 * - 结构必须严格是 `plans[].allocations[].items[]`，寒暄/markdown 要能剥掉；
 * - **模型返回的价格一律丢弃**，金额只从真实计价来；
 * - 编造商品 ID、选中蘸酱周边、违反 `dislikes`/`no-spicy`、数量越界、
 *   菜单价超预算、漏成员、动别人餐品，全部必须被拦；
 * - 网络层：非 2xx、非 JSON、超时，都必须变成可降级的 `AiError`。
 *
 * 其中「网络层」用真实 `http.createServer` 起一个本地假网关，走的是真的 fetch，
 * 不是把 fetch 换掉——这样能同时覆盖请求体、鉴权头和超时中断。
 *
 * 运行：npm run test --workspace=@mcd/server
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  AiError,
  extractJsonObject,
  loadAiConfig,
  normalizeChatEndpoint,
  parseProposal,
  requestProposal,
  validateProposal,
} from './ai.js';
import type { ProposalAllocation, ProposalRequest, ValidatableMember, ValidatableProduct } from './ai.js';

// ---------------------------------------------------------------- 假商品与假成员

const PRODUCTS: ValidatableProduct[] = [
  { id: 'b1', name: '牛肉汉堡', category: 'burger', priceCents: 2000, spicy: false, beef: true, nonMeal: false },
  { id: 'b2', name: '鸡腿堡', category: 'burger', priceCents: 1800, spicy: false, beef: false, nonMeal: false },
  { id: 'b3', name: '麦辣鸡腿堡', category: 'burger', priceCents: 1600, spicy: true, beef: false, nonMeal: false },
  { id: 's1', name: '中薯条', category: 'fries', priceCents: 1200, spicy: false, beef: false, nonMeal: false },
  { id: 'd1', name: '可乐', category: 'drink', priceCents: 900, spicy: false, beef: false, nonMeal: false },
  { id: 'x1', name: '北美招牌牧场酱', category: 'snack', priceCents: 300, spicy: false, beef: false, nonMeal: true },
];

function members(): ValidatableMember[] {
  return [
    { id: 1, budgetCents: 3000, likes: ['fries'], dislikes: [], requirement: 'none' },
    { id: 2, budgetCents: 2500, likes: [], dislikes: [], requirement: 'no-spicy' },
  ];
}

/** 一份合法方案：成员 1 鸡腿堡 + 薯条，成员 2 鸡腿堡。 */
const GOOD: ProposalAllocation[] = [
  { memberId: 1, items: [{ productId: 'b2', quantity: 1 }, { productId: 's1', quantity: 1 }], reason: '鸡腿堡配薯条' },
  { memberId: 2, items: [{ productId: 'b2', quantity: 1 }], reason: '不辣的堡' },
];

// ---------------------------------------------------------------- 配置

test('loadAiConfig：三项齐全才算配置，只填 key 不算接入', () => {
  assert.equal(loadAiConfig({} as NodeJS.ProcessEnv), null);
  assert.equal(loadAiConfig({ AI_API_KEY: 'sk-x' } as NodeJS.ProcessEnv), null);
  assert.equal(
    loadAiConfig({ AI_API_KEY: 'sk-x', AI_BASE_URL: 'https://example.com/v1' } as NodeJS.ProcessEnv),
    null,
    '缺 model 时不能假定网关默认模型',
  );

  const config = loadAiConfig({
    AI_BASE_URL: 'https://example.com/v1',
    AI_API_KEY: 'sk-x',
    AI_MODEL: 'test-model',
  } as NodeJS.ProcessEnv);

  assert.equal(config?.baseUrl, 'https://example.com/v1/chat/completions');
  assert.equal(config?.model, 'test-model');
  assert.equal(config?.timeoutMs, 20_000);
});

test('normalizeChatEndpoint：已是 completions 地址时不重复拼接', () => {
  assert.equal(normalizeChatEndpoint('https://a.com/v1/'), 'https://a.com/v1/chat/completions');
  assert.equal(normalizeChatEndpoint('https://a.com/v1/chat/completions'), 'https://a.com/v1/chat/completions');
});

// ---------------------------------------------------------------- 解析

test('extractJsonObject：剥掉 ``` 包裹与前后寒暄', () => {
  const raw = '好的，方案如下：\n```json\n{"plans":[]}\n```\n希望有帮助。';
  assert.equal(extractJsonObject(raw), '{"plans":[]}');
});

test('parseProposal：多策略 plans 逐份解析', () => {
  const raw = JSON.stringify({
    plans: [
      { strategy: 'saving', allocations: [{ memberId: 1, items: [{ productId: 'b2', quantity: 1 }] }] },
      { strategy: 'happy', allocations: GOOD },
    ],
  });

  const parsed = parseProposal(raw);
  assert.deepEqual(parsed.plans.map((plan) => plan.strategy), ['saving', 'happy']);
  assert.equal(parsed.plans[1]?.allocations.length, 2);
});

test('parseProposal：模型只回 allocations 时按默认策略归位（兼容退化写法）', () => {
  const parsed = parseProposal(JSON.stringify({ allocations: GOOD }), 'saving');
  assert.equal(parsed.plans.length, 1);
  assert.equal(parsed.plans[0]?.strategy, 'saving');
});

test('parseProposal：模型自带的 price 字段被丢弃，只保留 productId/quantity', () => {
  const raw = JSON.stringify({
    plans: [
      {
        strategy: 'saving',
        allocations: [
          {
            memberId: 1,
            reason: '便宜',
            items: [{ productId: 'b2', quantity: 2, price: 1, priceCents: 1, subtotalCents: 1 }],
          },
        ],
        totalCents: 1,
      },
    ],
    payableCents: 1,
  });

  const parsed = parseProposal(raw);
  const item = parsed.plans[0]?.allocations[0]?.items[0];

  assert.deepEqual(item, { productId: 'b2', quantity: 2 });
  assert.equal('price' in (item as object), false);
  assert.equal('priceCents' in (item as object), false);
  assert.equal('totalCents' in (parsed.plans[0] as object), false);
  assert.equal('payableCents' in (parsed as object), false);
});

test('parseProposal：非 JSON 抛 model_invalid_json', () => {
  assert.throws(
    () => parseProposal('抱歉，我无法完成'),
    (error: unknown) => error instanceof AiError && error.code === 'model_invalid_json',
  );
});

test('parseProposal：缺 plans 抛 model_invalid_shape', () => {
  assert.throws(
    () => parseProposal('{"other":[]}'),
    (error: unknown) => error instanceof AiError && error.code === 'model_invalid_shape',
  );
});

// ---------------------------------------------------------------- 语义校验

test('validateProposal：合法方案通过并算出 matched/missingLikes', () => {
  const result = validateProposal(GOOD, members(), PRODUCTS);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const first = result.selections.find((entry) => entry.memberId === 1);
  assert.deepEqual(first?.matchedLikes, ['fries']);
  assert.deepEqual(first?.missingLikes, []);
  assert.equal(first?.requiresManualReview, false);
});

test('validateProposal：编造的商品 ID 被拦（model_unknown_product）', () => {
  const bad: ProposalAllocation[] = [
    { memberId: 1, items: [{ productId: 'fake-999', quantity: 1 }] },
    { memberId: 2, items: [{ productId: 'b2', quantity: 1 }] },
  ];

  const result = validateProposal(bad, members(), PRODUCTS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violation.code, 'model_unknown_product');
  assert.equal(result.violation.memberId, 1);
});

test('validateProposal：蘸酱/周边被当成餐品时被拦（model_non_meal_product）', () => {
  const bad: ProposalAllocation[] = [
    { memberId: 1, items: [{ productId: 'x1', quantity: 1 }] },
    { memberId: 2, items: [{ productId: 'b2', quantity: 1 }] },
  ];

  const result = validateProposal(bad, members(), PRODUCTS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violation.code, 'model_non_meal_product');
});

test('validateProposal：命中 dislikes 被拦（硬排除优先于排序）', () => {
  const withDislike = members();
  withDislike[1] = { ...withDislike[1]!, dislikes: ['burger'] };

  const result = validateProposal(GOOD, withDislike, PRODUCTS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violation.code, 'model_dislike_violation');
  assert.equal(result.violation.memberId, 2);
});

test('validateProposal：no-spicy 时选辣味商品被拦', () => {
  const bad: ProposalAllocation[] = [
    { memberId: 1, items: [{ productId: 'b2', quantity: 1 }] },
    { memberId: 2, items: [{ productId: 'b3', quantity: 1 }] },
  ];

  const result = validateProposal(bad, members(), PRODUCTS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violation.code, 'model_requirement_violation');
});

test('validateProposal：no-beef 时选牛肉商品被拦', () => {
  const noBeef = members();
  noBeef[0] = { ...noBeef[0]!, requirement: 'no-beef' };

  const bad: ProposalAllocation[] = [
    { memberId: 1, items: [{ productId: 'b1', quantity: 1 }] },
    { memberId: 2, items: [{ productId: 'b2', quantity: 1 }] },
  ];

  const result = validateProposal(bad, noBeef, PRODUCTS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violation.code, 'model_requirement_violation');
});

test('validateProposal：明确要 fries 但方案里没有，被拦', () => {
  const wantsFries = members();
  wantsFries[0] = { ...wantsFries[0]!, requirement: 'fries' };

  const noFries: ProposalAllocation[] = [
    { memberId: 1, items: [{ productId: 'b1', quantity: 1 }] },
    { memberId: 2, items: [{ productId: 'b2', quantity: 1 }] },
  ];

  const result = validateProposal(noFries, wantsFries, PRODUCTS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violation.code, 'model_missing_required_category');
});

test('validateProposal：数量必须是 1–3 的整数', () => {
  for (const quantity of [0, 4, 1.5, -1]) {
    const bad: ProposalAllocation[] = [
      { memberId: 1, items: [{ productId: 'b2', quantity }] },
      { memberId: 2, items: [{ productId: 'b2', quantity: 1 }] },
    ];

    const result = validateProposal(bad, members(), PRODUCTS);
    assert.equal(result.ok, false, `quantity=${String(quantity)} 应被拒绝`);
    if (result.ok) return;
    assert.equal(result.violation.code, 'model_invalid_quantity');
  }
});

test('validateProposal：按菜单价超预算被拦（真实应付再验一次）', () => {
  const bad: ProposalAllocation[] = [
    { memberId: 1, items: [{ productId: 'b1', quantity: 2 }] },
    { memberId: 2, items: [{ productId: 'b2', quantity: 1 }] },
  ];

  const result = validateProposal(bad, members(), PRODUCTS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violation.code, 'model_budget_exceeded');
});

test('validateProposal：漏掉成员被拦，不允许只给一部分人点餐', () => {
  const partial: ProposalAllocation[] = [{ memberId: 1, items: [{ productId: 'b2', quantity: 1 }] }];

  const result = validateProposal(partial, members(), PRODUCTS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violation.code, 'model_missing_member');
  assert.equal(result.violation.memberId, 2);
});

test('validateProposal：动被锁定成员被拦（复议只改目标成员）', () => {
  const result = validateProposal(GOOD, members(), PRODUCTS, { lockedMemberIds: [2] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violation.code, 'model_locked_member');
  assert.equal(result.violation.memberId, 2);
});

test('validateProposal：自填要求不会被模型"验证"，只标记人工核对', () => {
  const withCustom = members();
  withCustom[0] = { ...withCustom[0]!, customRequirement: '不要洋葱' };

  const result = validateProposal(GOOD, withCustom, PRODUCTS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selections.find((entry) => entry.memberId === 1)?.requiresManualReview, true);
});

// ---------------------------------------------------------------- 网络层（真 fetch + 本地假网关）

interface ServerOptions {
  hang?: boolean;
}

async function withFakeGateway(
  respond: (body: Record<string, unknown>, headers: Record<string, unknown>) => { status?: number; body: string },
  run: (baseUrl: string) => Promise<void>,
  options: ServerOptions = {},
): Promise<void> {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      if (options.hang === true) return;

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = { raw };
      }

      const out = respond(parsed, request.headers as Record<string, unknown>);
      response.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      response.end(out.body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    await run(`http://127.0.0.1:${String(port)}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
    });
  }
}

const REQUEST: ProposalRequest = {
  storeName: '测试门店',
  strategies: ['saving', 'peace', 'happy'],
  members: [
    { id: 1, budgetCents: 3000, hunger: 'hungry', likes: ['fries'], dislikes: [], requirement: 'none' },
    { id: 2, budgetCents: 2500, hunger: 'little', likes: [], dislikes: [], requirement: 'no-spicy' },
  ],
  candidates: [
    { id: 'b2', name: '鸡腿堡', category: 'burger', priceCents: 1800 },
    { id: 's1', name: '中薯条', category: 'fries', priceCents: 1200 },
  ],
};

function contentBody(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

test('requestProposal：真发 HTTP，带上 bearer、model、策略与候选商品', async () => {
  let seen: { auth?: string; model?: unknown; user?: string } = {};

  await withFakeGateway(
    (body, headers) => {
      const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content: string }>) : [];
      seen = {
        auth: typeof headers.authorization === 'string' ? headers.authorization : undefined,
        model: body.model,
        user: messages[1]?.content,
      };
      return {
        body: contentBody(
          JSON.stringify({
            plans: [
              {
                strategy: 'saving',
                allocations: [
                  { memberId: 1, items: [{ productId: 'b2', quantity: 1, price: 1 }], reason: 'a' },
                  { memberId: 2, items: [{ productId: 'b2', quantity: 1 }], reason: 'b' },
                ],
              },
            ],
          }),
        ),
      };
    },
    async (baseUrl) => {
      const result = await requestProposal(
        { baseUrl: normalizeChatEndpoint(baseUrl), apiKey: 'sk-test', model: 'test-model', timeoutMs: 3000 },
        REQUEST,
      );

      assert.equal(seen.auth, 'Bearer sk-test');
      assert.equal(seen.model, 'test-model');
      assert.match(seen.user ?? '', /b2/);
      assert.match(seen.user ?? '', /budgetCents/);
      assert.match(seen.user ?? '', /"strategies":\["saving","peace","happy"\]/);
      // 模型返回的 price 不进结果。
      assert.deepEqual(result.proposal.plans[0]?.allocations[0]?.items[0], { productId: 'b2', quantity: 1 });
      assert.ok(result.latencyMs >= 0);
    },
  );
});

test('requestProposal：HTTP 500 变成可降级的 model_http_error', async () => {
  await withFakeGateway(
    () => ({ status: 500, body: '{"error":"boom"}' }),
    async (baseUrl) => {
      await assert.rejects(
        requestProposal(
          { baseUrl: normalizeChatEndpoint(baseUrl), apiKey: 'sk-test', model: 'm', timeoutMs: 3000 },
          REQUEST,
        ),
        (error: unknown) => error instanceof AiError && error.code === 'model_http_error',
      );
    },
  );
});

test('requestProposal：429 限流保留 status 与 retry-after，供调用方降级', async () => {
  await withFakeGateway(
    () => ({ status: 429, body: '{"error":{"type":"rate_limit_exceeded"}}' }),
    async (baseUrl) => {
      await assert.rejects(
        requestProposal(
          { baseUrl: normalizeChatEndpoint(baseUrl), apiKey: 'sk-test', model: 'm', timeoutMs: 3000 },
          REQUEST,
        ),
        (error: unknown) =>
          error instanceof AiError &&
          error.code === 'model_http_error' &&
          (error.detail as { status?: number } | undefined)?.status === 429,
      );
    },
  );
});

test('requestProposal：网关不返回时按超时中断（model_timeout）', async () => {
  await withFakeGateway(
    () => ({ body: '{}' }),
    async (baseUrl) => {
      await assert.rejects(
        requestProposal(
          { baseUrl: normalizeChatEndpoint(baseUrl), apiKey: 'sk-test', model: 'm', timeoutMs: 120 },
          REQUEST,
        ),
        (error: unknown) => error instanceof AiError && error.code === 'model_timeout',
      );
    },
    { hang: true },
  );
});

test('requestProposal：content 为空抛 model_invalid_shape', async () => {
  await withFakeGateway(
    () => ({ body: JSON.stringify({ choices: [{ message: { content: '' } }] }) }),
    async (baseUrl) => {
      await assert.rejects(
        requestProposal(
          { baseUrl: normalizeChatEndpoint(baseUrl), apiKey: 'sk-test', model: 'm', timeoutMs: 3000 },
          REQUEST,
        ),
        (error: unknown) => error instanceof AiError && error.code === 'model_invalid_shape',
      );
    },
  );
});
