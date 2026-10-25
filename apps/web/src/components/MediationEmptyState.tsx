import { MediatorArtwork } from './CharacterArtwork';
import { Arrow } from './UI';
import { categories, hungerLabel, memberRequirementLabel, money } from '../services/demo-data';
import type { MediationResult, Party, RecoverySuggestion } from '../types/demo';

export default function MediationEmptyState({ party, issues, suggestions = [], onSuggestion, onEdit, onRetry }: { party: Party; issues: MediationResult['issues']; suggestions?: RecoverySuggestion[]; onSuggestion?: (suggestion: RecoverySuggestion) => void; onEdit: (index: number) => void; onRetry: () => void }) {
  const retryable = issues.length === 0 || issues.every(issue => issue.kind === 'unavailable');
  const needsInput = !retryable && issues.some(issue => issue.kind === 'input') && !issues.some(issue => issue.kind === 'constraint');
  const firstIndex = Math.max(0, party.members.findIndex(member => member.id === issues[0]?.memberId));
  return (
    <section className="empty-state panel">
      <MediatorArtwork variant="state" />
      <h2>{retryable ? '这次没能完成调解。' : needsInput ? '先补充一下设置。' : '这一局，需要再商量一下。'}</h2>
      <p>{retryable ? '大家的要求已经保留，稍后可以再试一次。' : suggestions.length ? '袋袋试算了下面的调整，选一条即可查看搭配。' : '当前门店暂未找到可行调整。可以换一家门店，或返回查看预算与食物限制。'}</p>
      <div className="issue-list">{issues.map((issue, index) => {
        const memberIndex = party.members.findIndex(member => member.id === issue.memberId);
        const member = party.members[memberIndex];
        return <article className="issue-card" key={`${issue.memberId}-${index}`}>
          <strong>{member ? `成员${member.id}` : '本次饭局'} · {issue.kind === 'unavailable' ? '暂未完成' : issue.kind === 'input' ? '需要补充设置' : '条件暂时无法同时满足'}</strong>
          {member && <div className="issue-conditions"><span>预算 {money((member.budget ?? 0) * 100)}</span><span>{hungerLabel(member.hunger)}</span>{member.requirement !== 'none' && <span>{memberRequirementLabel(member)}</span>}</div>}
          <p>{issue.message}</p>
          {issues.length > 1 && member && issue.kind !== 'unavailable' && <button className="text-button" onClick={() => onEdit(memberIndex)}>调整成员{member.id} <Arrow /></button>}
        </article>;
      })}</div>
      {suggestions.length > 0 && <div className="recovery-options">{suggestions.map(suggestion => <article className="recovery-card" key={suggestion.id}>
        <strong>{suggestion.title}</strong><p>{suggestion.summary}</p>
        <ul>{suggestion.changes.map(change => {
          const member = party.members.find(member => member.id === change.memberId)!;
          return <li key={change.memberId}>成员{change.memberId}：{change.budget !== undefined && <>预算 {money((member.budget ?? 0) * 100)} → {money(change.budget * 100)}</>}{change.requirement !== undefined && <>取消「{memberRequirementLabel(member)}」</>}{change.dislikes !== undefined && <>允许包含{member.dislikes.filter(category => !change.dislikes!.includes(category)).map(category => categories.find(item => item.id === category)?.label).join('、')}</>}</li>;
        })}</ul>
        <p className="recovery-total">试算合计 <b>{money(suggestion.plan.totalCents)}</b><span>当前报价，5 分钟内可采用</span></p>
        <button className="button button-primary" onClick={() => onSuggestion?.(suggestion)}>按此调整并查看方案 <Arrow /></button>
      </article>)}</div>}
      <div className="empty-actions">
        <button className="button button-primary" onClick={retryable ? onRetry : () => onEdit(firstIndex)}>{retryable ? '重新尝试' : `调整成员${party.members[firstIndex].id}的设置`}<Arrow /></button>
        {retryable && <button className="text-button" onClick={() => onEdit(firstIndex)}>返回查看成员设置</button>}
        {!retryable && <button className="text-button" onClick={onRetry}>重新查询并试算</button>}
      </div>
    </section>
  );
}
