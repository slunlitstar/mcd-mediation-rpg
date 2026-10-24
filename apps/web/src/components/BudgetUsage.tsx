import { useEffect, useState } from 'react';
import { useElementVisibility } from '../hooks/useElementVisibility';
import { getBudgetUsage } from '../services/budget-usage';
import { money } from '../services/demo-data';

export default function BudgetUsage({ memberId, spentCents, budgetYuan }: { memberId: number; spentCents: number; budgetYuan: number | null }) {
  const { ref, active } = useElementVisibility();
  const [revealed, setRevealed] = useState(false);
  const usage = getBudgetUsage(spentCents, budgetYuan);
  useEffect(() => { if (active) setRevealed(true); }, [active]);
  return (
    <div ref={ref} className={`budget-visual ${usage?.overBudget ? 'budget-visual--over' : ''}`} data-motion-active={active}>
      <div className="budget-visual-label"><span>个人预算使用</span><strong>{usage ? `${money(usage.spentCents)} / ${money(usage.budgetCents)}` : '预算信息待确认'}</strong></div>
      {usage && <>
        <div className="budget-visual-track" role="meter" aria-label={`成员${memberId}个人预算使用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.percent)} aria-valuetext={`已花${money(usage.spentCents)}，预算${money(usage.budgetCents)}，${usage.overBudget ? '超出' : '剩余'}${money(Math.abs(usage.remainingCents))}`}>
          <span className="budget-visual-fill" style={{ width: `${revealed ? usage.percent : 0}%` }} />
        </div>
        <p>{usage.overBudget ? `超出预算 ${money(-usage.remainingCents)}，需要调整` : usage.remainingCents === 0 ? '刚好在预算内' : `还留有 ${money(usage.remainingCents)} 预算余地`}</p>
      </>}
    </div>
  );
}
