/**
 * 真实模型探测：把真实菜单、真实成员需求发给真实模型，再把结果落盘。
 *
 * 这个脚本存在的意义是「不许嘴上说接入了」：
 * - 没配置 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` 时直接以退出码 2 结束，
 *   不会伪造一份 `planner: llm-validated-v1` 的结果；
 * - 配置齐全时走完整链路：MCP 真菜单 → 模型提议 → 语义校验 → calculate-price
 *   → 整数分摊 → 预算复验，产出 `fixtures/normalized/mediate.llm.sample.json`；
 * - 额外做一次「投毒」验证：把模型给出的商品 ID 改成不存在的值，确认守卫会拦下，
 *   证明拦截不是靠提示词，而是靠代码。
 *
 * 运行：npm run ai:probe --workspace=@mcd/server
 * 可选环境变量：PROBE_STORE_CODE（默认 1950059，北京王府井）
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describeAiConfig, loadAiConfig, validateProposal } from '../src/services/ai.js';
import { mediate } from '../src/services/mediate.js';
import { mcd } from '../src/services/mcd.js';

const STORE_CODE = (process.env.PROBE_STORE_CODE ?? '1950059').trim();

function maskKey(key: string): string {
  return key.length <= 8 ? '***' : `${key.slice(0, 4)}***${key.slice(-4)}`;
}

async function main(): Promise<void> {
  const config = loadAiConfig();

  if (config === null) {
    console.error('模型未配置：需要同时填写 AI_BASE_URL / AI_API_KEY / AI_MODEL。');
    console.error('仅填写 AI_API_KEY 不算接入，本脚本不会伪造结果。');
    process.exitCode = 2;
    return;
  }

  console.log(`模型: ${describeAiConfig(config)}`);
  console.log(`端点: ${config.baseUrl}`);
  console.log(`密钥: ${maskKey(config.apiKey)}`);
  console.log(`超时: ${config.timeoutMs}ms`);

  const request = {
    storeId: STORE_CODE,
    members: [
      {
        id: 1,
        budget: 40,
        hunger: 'hungry' as const,
        likes: ['burger' as const],
        dislikes: [] as const,
        requirement: 'none' as const,
      },
      {
        id: 2,
        budget: 35,
        hunger: 'hungry' as const,
        likes: ['fries' as const],
        dislikes: ['dessert' as const],
        requirement: 'no-spicy' as const,
      },
      {
        id: 3,
        budget: 30,
        hunger: 'little' as const,
        likes: [] as const,
        dislikes: [] as const,
        requirement: 'drink' as const,
        customRequirement: '不要洋葱',
      },
    ],
    options: { maxPlans: 3 },
  };

  const startedAt = Date.now();
  const result = await mediate(request);
  const elapsedMs = Date.now() - startedAt;

  console.log('');
  console.log(`plan 生成耗时: ${String(elapsedMs)}ms`);
  console.log(`store: ${result.store.name} (${result.store.id})`);
  console.log(`meta.planner: ${result.meta.planner}`);
  console.log(`meta.reasoning: ${result.meta.reasoning}`);
  console.log(`meta.degraded: ${String(result.meta.degraded)}`);
  console.log(`meta.llm: ${result.meta.llm}`);
  console.log(`strategiesReturned: ${result.meta.strategiesReturned.join(',') || '(none)'}`);
  console.log(`strategiesDeduplicated: ${result.meta.strategiesDeduplicated.join(',') || '(none)'}`);

  for (const attempt of result.meta.llmDetail ?? []) {
    console.log(
      `  llm[${attempt.strategy}] ${attempt.status}${attempt.code === undefined ? '' : ` ${attempt.code}`}${
        attempt.latencyMs === undefined ? '' : ` ${String(attempt.latencyMs)}ms`
      }${attempt.message === undefined ? '' : ` — ${attempt.message}`}`,
    );
  }

  for (const plan of result.plans) {
    const sum = plan.allocations.reduce((total, allocation) => total + allocation.totalCents, 0);
    console.log(
      `  plan[${plan.strategy}] planId=${plan.planId} 应付=${String(plan.payableCents)}分 分摊合计=${String(sum)}分 ${
        sum === plan.payableCents ? 'OK' : 'MISMATCH'
      }`,
    );
    for (const allocation of plan.allocations) {
      const items = allocation.items
        .map((item) => `${item.productId}x${String(item.quantity)}(${String(item.subtotalCents)}分)`)
        .join(' + ');
      console.log(
        `    成员${String(allocation.memberId)}: ${items} → 分摊${String(allocation.totalCents)}分 / 预算${String(
          allocation.budgetCents,
        )}分`,
      );
    }
  }

  if (result.issues.length > 0) {
    console.log('  issues:');
    for (const issue of result.issues) {
      console.log(`    [${issue.blocking ? 'blocking' : 'info'}] ${issue.code}: ${issue.message}`);
    }
  }

  if (result.hints.length > 0) {
    console.log('  hints:');
    for (const hint of result.hints) console.log(`    [${hint.level}] ${hint.message}`);
  }

  // ---- 投毒验证：把真实模型的选品改掉一个 ID，确认守卫拦得住 ----
  const firstPlan = result.plans[0];
  const pool = (result.products ?? []).map((product) => ({
    id: product.id,
    name: product.name,
    category: product.category,
    priceCents: product.priceCents,
    spicy: product.dietary.spicy.inferred,
    beef: product.dietary.beef.inferred,
    nonMeal: false,
  }));

  if (firstPlan !== undefined && pool.length > 0) {
    const tampered = {
      allocations: firstPlan.allocations.map((allocation) => ({
        memberId: allocation.memberId,
        items: allocation.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      })),
    };

    const victim = tampered.allocations[0]?.items[0];
    if (victim !== undefined) victim.productId = 'fake-product-0000';

    const check = validateProposal(
      tampered.allocations,
      request.members.map((member) => ({
        id: member.id,
        budgetCents: Math.round(member.budget * 100),
        likes: [...member.likes],
        dislikes: [...member.dislikes],
        requirement: member.requirement,
        customRequirement: 'customRequirement' in member ? member.customRequirement : '',
      })),
      pool,
    );

    console.log('');
    console.log(
      check.ok
        ? '投毒验证: 失败 —— 伪造商品 ID 竟然通过了校验'
        : `投毒验证: 通过 —— 伪造商品 ID 被拦下（${check.violation.code}）`,
    );
    if (check.ok) process.exitCode = 1;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const target = join(here, '..', 'fixtures', 'normalized', 'mediate.llm.sample.json');

  // 落盘前再脱敏一次：结果里本来不该有 token/手机号，这里只兜底抹掉密钥形态的字符串。
  const serialized = JSON.stringify(result, null, 2)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer ***');

  await writeFile(target, `${serialized}\n`, 'utf8');
  console.log('');
  console.log(`已写入 ${target}`);

  await mcd.close();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  try {
    await mcd.close();
  } catch {
    // 关闭失败不掩盖原始错误。
  }
});
