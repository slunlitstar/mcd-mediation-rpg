import { useState } from 'react';
import type { CSSProperties } from 'react';
import CharacterArtwork, { MediatorArtwork } from '../components/CharacterArtwork';
import { PageTitle } from '../components/UI';
import { mediatorName } from '../assets/characters/character-assets';
import { categoryLabel, hungerLabel, memberRequirementLabel, money, roleFor } from '../services/demo-data';
import type { Party } from '../types/demo';

const demoStages = [
  { title: '收齐大家的诉求', detail: '汇总个人预算、饥饿程度和食物偏好。', line: '先听听大家怎么说，每个人的要求都记下。' },
  { title: '整理示例菜单和价格', detail: '使用本地示例餐品，按成员分别分配。', line: '看看这份示例菜单里，有哪些可以搭配。' },
  { title: '核对预算与不可退让的要求', detail: '检查可计算的条件，自填要求保留待核对。', line: '预算逐人检查，不会拿别人的余额替你超支。' },
  { title: '准备这一顿的三种结局', detail: '整理和平、省钱、快乐策略和取舍说明。', line: '把菜单和分配整理好，看看哪种更合心意。' },
];

const liveStages = [
  { title: '收齐大家的诉求', detail: '汇总个人预算、份量偏好和要求。', line: '大家的要求都记好了。' },
  { title: '核对真实菜单与方案', detail: '等待服务完成菜单查询、选品、整单试算和预算核对。', line: '正在核对这家店的菜单和价格，结果返回前请稍候。' },
  { title: '核对分摊金额', detail: '结果返回后展示每人花费与优惠分摊。', line: '不挪用别人的预算，逐人核对。' },
  { title: '整理可行方案', detail: '只展示实际返回的方案；相同组合合并展示。', line: '把可行的搭配整理好。' },
];

export default function MediationCourt({ party, progress, resultReady, onViewResult, onInspect, live = false }: { party: Party; progress: number; resultReady: boolean; onViewResult: () => void; onInspect: () => void; live?: boolean }) {
  const stages = live ? liveStages : demoStages;
  const [held, setHeld] = useState(false);
  const totalBudget = party.members.reduce((sum, member) => sum + (member.budget ?? 0), 0);
  const completed = progress >= stages.length;
  function hold() { if (!held) { setHeld(true); onInspect(); } }
  return (
    <section className="page mediation-page" aria-busy={!resultReady} onPointerDownCapture={hold} onFocusCapture={hold}>
      <PageTitle number="04" eyebrow="THE MEDIATION COURT" title="这顿饭，正在商量。">大家的要求已收齐，让袋袋逐项看看。</PageTitle>
      <span className="source-label">{live ? '真实门店 · 方案核对中' : '示例菜单 · 离线演示'}</span>
      <p className="court-playback-note">{held ? '已停留查看，准备好后点下方按钮看方案。' : live ? '方案核对完成后自动展示；触摸页面可停留查看诉求。' : '触摸页面可以停留查看。'}</p>
      <div className="stage-overview"><div className="stage-summary"><span className="stage-summary-label">{completed ? '本轮方案已就绪' : stages[Math.min(progress, stages.length - 1)].title}</span><small>{Math.min(progress + 1, stages.length)} / {stages.length}</small></div><div className="stage-segments" role="progressbar" aria-label="调解阶段" aria-valuemin={0} aria-valuemax={stages.length} aria-valuenow={Math.min(progress, stages.length)}>{stages.map((stage, index) => <i key={stage.title} className={index < progress ? 'done' : index === progress ? 'current' : ''} />)}</div></div>
      <div className="court-members">
        {party.members.map((member, index) => (
          <article className="court-member" key={member.id} style={{ '--member-delay': `${index * 110}ms` } as CSSProperties}>
            <div className="demand-bubble">
              <span className="court-demand">{member.requirement !== 'none' ? memberRequirementLabel(member) : hungerLabel(member.hunger)}</span>
              <small>预算 ≤ {money((member.budget ?? 0) * 100)}</small>
            </div>
            <CharacterArtwork role={member.roleId ?? 'saver'} variant="court" />
            <strong>成员{member.id}</strong>
            <span>{roleFor(member.roleId)?.name}</span>
            <details className="court-member-details">
              <summary>查看完整诉求</summary>
              <p>{hungerLabel(member.hunger)}</p>
              {member.likes.length > 0 && <p>喜欢：{member.likes.map(categoryLabel).join('、')}</p>}
              {member.dislikes.length > 0 && <p>不喜欢：{member.dislikes.map(categoryLabel).join('、')}</p>}
              {member.requirement !== 'none' && <p>要求：{memberRequirementLabel(member)}</p>}
              {member.requirement === 'other' && <p>自填内容需在结果中核对。</p>}
            </details>
          </article>
        ))}
      </div>
      <section className="court-desk" aria-label="调解进度">
        <div className="court-npc"><MediatorArtwork variant="court" /><div><strong>{mediatorName}</strong><p key={progress} className="court-npc-line" aria-live="polite">{completed ? '方案准备好了，看看这顿怎么安排。' : stages[Math.min(progress, stages.length - 1)].line}</p></div></div>
        <div className="court-report">
          <span className="eyebrow">本场协商重点</span>
          <p>{party.members.length} 位成员，个人预算上限合计 <b>{money(totalBudget * 100)}</b>。每个人的花费仍单独检查，再照顾主食、偏好和不可退让的要求。</p>

          <ol className="progress-list mediation-timeline">{stages.map((stage, index) => <li key={stage.title} className={index < progress ? 'done' : index === progress ? 'running' : ''} aria-current={index === progress ? 'step' : undefined}><span className="stage-number" aria-hidden="true">{index < progress ? '✓' : index + 1}</span><div className="stage-copy"><strong>{stage.title}</strong><p>{stage.detail}</p></div><small className="stage-status">{index < progress ? '已完成' : index === progress ? live ? '等待核对结果' : '示例演示中' : '待完成'}</small></li>)}</ol>
        </div>
      </section>
      <div className="court-actions mobile-dock"><span>{resultReady ? '方案已准备好' : live ? '正在核对真实菜单与金额' : '正在准备示例方案'}</span><button className="button button-primary" disabled={!resultReady} onClick={onViewResult}>{resultReady ? '查看方案' : '方案准备中…'}<span aria-hidden="true">→</span></button></div>
    </section>
  );
}
