import { useState } from 'react';
import BudgetUsage from './BudgetUsage';
import CharacterArtwork, { MediatorArtwork } from './CharacterArtwork';
import MediationEmptyState from './MediationEmptyState';
import { Arrow, NpcNote, PageTitle } from './UI';
import { categories, hungerLabel, memberRequirementLabel, money, products as demoProducts, roleFor, strategies } from '../services/demo-data';
import { resultSourceLabel } from '../services/live-service';
import type { MediationResult, Party, Product, RecoverySuggestion, Strategy } from '../types/demo';

function ProductPicture({ product }: { product: Product }) {
  const [failed, setFailed] = useState(false);
  return product.image && !failed ? <img className="product-photo" src={product.image} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    : <span className="product-emoji" aria-hidden="true">{product.emoji || categories.find(category => category.id === product.category)?.emoji || '🍽️'}</span>;
}

interface Props {
  party: Party;
  result: MediationResult | null;
  live: boolean;
  storeName?: string;
  strategy: Strategy;
  onStrategy: (value: Strategy) => void;
  accepted: boolean;
  onAccept: (value: boolean) => void;
  reviewed: boolean;
  onReviewed: (value: boolean) => void;
  revisionCount: number;
  onEdit: (index: number) => void;
  onRetry: () => void;
  onRevise: () => void;
  onSuggestion: (suggestion: RecoverySuggestion) => void;
}

export default function MealResults({ party, result, live, storeName, strategy, onStrategy, accepted, onAccept, reviewed, onReviewed, revisionCount, onEdit, onRetry, onRevise, onSuggestion }: Props) {
  const plan = result?.plans.find(item => item.strategy === strategy) ?? result?.plans[0];
  const currentStrategy = strategies.find(item => item.id === plan?.strategy) ?? strategies[0];
  const pendingReview = Boolean(plan?.allocations.some(item => item.requiresManualReview) && !reviewed);
  const catalog = result?.source === 'live' ? result.products ?? [] : demoProducts;
  const notices = [...new Set([...(result?.issues.filter(issue => issue.blocking !== true).map(issue => issue.message) ?? []), ...(result?.hints?.map(hint => hint.message) ?? [])])];
  function accept() {
    if (!pendingReview) { onAccept(true); return; }
    const confirmation = document.getElementById('custom-review-confirm');
    confirmation?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    confirmation?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }
  return <section className="page results-page">
    <PageTitle number="05" eyebrow="YOUR DINNER ENDING" title={accepted ? '这顿，就这么定了！' : '不同主张，也能一起开饭。'}>{result?.store?.name ?? storeName} · {party.members.length} 位成员 · 同一订单，分别分配{revisionCount > 0 ? ` · 已复议 ${revisionCount} 次` : ''}</PageTitle>
    <p className="source-label">{resultSourceLabel(result, live, plan?.strategy)}</p>
    {!plan ? <MediationEmptyState party={party} issues={result?.issues ?? []} suggestions={result?.suggestions} onSuggestion={onSuggestion} onEdit={onEdit} onRetry={onRetry} /> : <>
      {notices.length > 0 && <div className="service-notice" role="status">{notices.map(text => <p key={text}>{text}</p>)}</div>}
      {result?.meta?.degraded && <p className="service-notice">部分模型结果暂不可用或未通过核对，已使用规则方案补充；菜单与金额仍按真实数据核对。</p>}
      {accepted && <div className="accepted-banner" role="status"><MediatorArtwork variant="note" /><div><strong>方案已确认，带着这份清单去点餐吧。</strong><p>接受推荐不会创建订单或扣款，实际价格以点餐时为准。</p></div><button className="text-button" onClick={() => onAccept(false)}>继续调整</button></div>}
      <div className="strategy-tabs" role="tablist" aria-label="选择方案策略">{strategies.map(item => {
        const available = result!.plans.some(plan => plan.strategy === item.id);
        const duplicate = result?.meta?.strategiesDeduplicated?.includes(item.id);
        return <button key={item.id} role="tab" id={`tab-${item.id}`} aria-controls="plan-panel" aria-selected={plan.strategy === item.id} disabled={!available} className={plan.strategy === item.id ? 'active' : ''} onClick={() => { onStrategy(item.id); onAccept(false); }}><span>{item.id === 'peace' ? '✳' : item.id === 'saving' ? '¥' : '✦'}</span><strong>{item.name}</strong><small>{available ? item.description : duplicate ? '结果相同，已合并' : revisionCount > 0 ? '本次未重新生成' : '暂无可行方案'}</small></button>;
      })}</div>
      {Boolean(result?.meta?.strategiesDeduplicated?.length) && <p className="strategy-notice">{result!.meta!.strategiesDeduplicated!.map(id => strategies.find(item => item.id === id)?.name).join('、')}与已有方案餐品相同，已合并展示。</p>}
      <div className="results-layout" id="plan-panel" role="tabpanel" aria-labelledby={`tab-${plan.strategy}`}>
        <div className="mobile-plan-summary"><div><span>{currentStrategy.name} · 合计</span><strong>{money(plan.totalCents)}</strong></div><p>{currentStrategy.description}</p></div>
        <div className="allocations">{plan.allocations.map(allocation => {
          const person = party.members.find(item => item.id === allocation.memberId)!;
          const inferredDiet = live && ['no-spicy', 'no-beef'].includes(person.requirement);
          return <article className="allocation-card panel" key={person.id}>
            <div className="allocation-header"><div className="allocation-member"><CharacterArtwork role={person.roleId ?? 'saver'} variant="avatar" /><div><h2>成员{person.id}<small>{roleFor(person.roleId)?.name}</small></h2><span>{hungerLabel(person.hunger)} · 预算 {money((person.budget ?? 0) * 100)}</span></div></div><div className="allocation-price"><strong>{money(allocation.totalCents)}</strong><span>余 {money((person.budget ?? 0) * 100 - allocation.totalCents)}</span></div></div>
            <BudgetUsage memberId={person.id} spentCents={allocation.totalCents} budgetYuan={person.budget} />
            <ul className="product-list">{allocation.items.map(item => {
              const product = catalog.find(product => product.id === item.productId)!;
              const unit = item.unitPriceCents ?? product.priceCents;
              return <li key={product.id}><ProductPicture key={`${product.id}-${product.image}`} product={product} /><span>{product.name}{product.isCombo && <em className="combo-label">默认套餐</em>}<small>{money(unit)} / 份</small>{product.components?.length ? <small className="combo-contents">含：{product.components.map(component => `${component.name} ×${component.quantity}`).join('、')}</small> : null}</span><span className="product-quantity">×{item.quantity}</span><b>{money(item.subtotalCents ?? unit * item.quantity)}</b></li>;
            })}</ul>
            {live && <p className="allocation-pricing-note">个人实付已计入整单优惠分摊，可能与商品明细合计不同。</p>}
            <div className="allocation-checks"><span>✓ 预算内</span>{allocation.requiresManualReview ? <span className="check-pending">自填要求待核对</span> : inferredDiet ? <span className="check-pending">已按名称／标签筛选</span> : <span>✓ {person.requirement === 'none' ? (live ? '主餐已安排' : '已按份量偏好搭配') : memberRequirementLabel(person)}</span>}</div>
            {inferredDiet && <p className="dietary-note">{memberRequirementLabel(person)}：依据商品名称与标签推导，非官方配料确认；请在点餐时核对配料。</p>}
            {allocation.requiresManualReview && <div className="custom-review-note"><strong>你的要求：{person.customRequirement.trim() || '请核对餐品与个人要求'}</strong><p>已记录，请核对上方餐品后再接受方案。</p></div>}
          </article>;
        })}</div>
        <aside className="result-summary"><div className="receipt panel"><span className="eyebrow">{currentStrategy.eyebrow}</span><h2>本次饭局小票</h2><div className="receipt-rule" />
          <div className="receipt-line"><span>餐品合计</span><b>{money(plan.productSubtotalCents ?? plan.totalCents)}</b></div>
          <div className="receipt-line"><span>整单优惠</span><span>{money(plan.discountCents ?? 0)}</span></div>
          <div className="receipt-rule" /><div className="receipt-total"><span>总价</span><strong>{money(plan.totalCents)}</strong></div>
          <p className="receipt-budget">每个人的分摊花费均已分别检查预算。</p><span className="receipt-demo">{resultSourceLabel(result, live, plan.strategy)} · 非真实订单</span>
          {!accepted && plan.allocations.some(item => item.requiresManualReview) && <label id="custom-review-confirm" className="custom-review-confirm"><input type="checkbox" checked={reviewed} onChange={event => onReviewed(event.target.checked)} />我已逐项核对所有自填要求</label>}
          {!accepted && <button className="button button-primary receipt-accept" disabled={pendingReview} onClick={accept}>{pendingReview ? '请先核对自填要求' : '接受这套方案'} ✓</button>}
          <button className="button button-outline" onClick={onRevise}>申请复议 ↻</button><button className="text-button receipt-edit" onClick={() => onEdit(0)}>返回修改成员属性 <Arrow left /></button>
        </div><NpcNote>{currentStrategy.description} 饥饿程度仅作为份量偏好，实际需求请自行确认。</NpcNote><details className="plan-notes"><summary>查看本轮说明</summary><ul>{plan.explanations.map((text, index) => <li key={index}>{text}</li>)}</ul></details></aside>
        <div className="result-mobile-dock mobile-dock"><div className="dock-total"><span>本单合计</span><strong>{money(plan.totalCents)}</strong></div><button className="text-button dock-revise" onClick={onRevise}>复议 ↻</button><button className="button button-primary" disabled={accepted} onClick={accept}>{accepted ? '已接受 ✓' : pendingReview ? '核对自填要求' : '接受方案 ✓'}</button></div>
      </div>
    </>}
  </section>;
}
