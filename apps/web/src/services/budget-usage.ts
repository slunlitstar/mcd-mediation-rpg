export function getBudgetUsage(spentCents: number, budgetYuan: number | null) {
  const validSpend = Number.isSafeInteger(spentCents) && spentCents >= 0;
  const validBudget = budgetYuan !== null && Number.isFinite(budgetYuan) && budgetYuan > 0 && Number.isSafeInteger(Math.round(budgetYuan * 100));
  if (!validSpend || !validBudget) return null;
  const budgetCents = Math.round(budgetYuan * 100);
  if (budgetCents === 0) return null;
  return {
    spentCents,
    budgetCents,
    remainingCents: budgetCents - spentCents,
    percent: Math.min(100, Math.max(0, spentCents / budgetCents * 100)),
    overBudget: spentCents > budgetCents,
  };
}
