import { useEffect, useRef, useState } from 'react';
import RoleSelector from './components/RoleSelector';
import BudgetUsage from './components/BudgetUsage';
import { useMobileKeyboard } from './hooks/useMobileKeyboard';
import CharacterArtwork, { MediatorArtwork } from './components/CharacterArtwork';
import MediationCourt from './pages/MediationCourt';
import MediationEmptyState from './components/MediationEmptyState';
import { mediatorName } from './assets/characters/character-assets';
import { Arrow, NpcNote, PageTitle } from './components/UI';
import { categories, exampleParty, hungerLabel, hungers, money, newMember, productFor, memberRequirementLabel, requirements, roleFor, roles, stores, strategies } from './services/demo-data';
import { generateDemoPlans, memberError } from './services/demo-service';
import type { Category, MediationRequest, MediationResult, Member, Party, Revision, Step, Strategy } from './types/demo';

const chapters = ['调解所大厅', '小队集结', '职业与属性', '仲裁庭', '饭局结局'];
const initialParty = (): Party => ({ storeId: '', members: [newMember(1), newMember(2), newMember(3)] });

export default function App() {
  const [step, setStep] = useState<Step>(0);
  const [party, setParty] = useState<Party>(initialParty);
  const [activeMember, setActiveMember] = useState(0);
  const [previewRole, setPreviewRole] = useState(0);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<MediationResult | null>(null);
  const [strategy, setStrategy] = useState<Strategy>('peace');
  const [progress, setProgress] = useState(0);
  const [courtReady, setCourtReady] = useState(false);
  const courtHoldAuto = useRef(false);
  const [request, setRequest] = useState<MediationRequest | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [reviewedCustom, setReviewedCustom] = useState(false);
  const [revising, setRevising] = useState(false);
  const [revisionMember, setRevisionMember] = useState(1);
  const [revisionAction, setRevisionAction] = useState<Revision['action']>('cheaper');
  const [revisionError, setRevisionError] = useState('');
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [revisionCount, setRevisionCount] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const generationRef = useRef(0);
  const keyboardOpen = useMobileKeyboard();
  const member = party.members[activeMember] ?? party.members[0];
  const plan = result?.plans.find(item => item.strategy === strategy);
  const store = stores.find(item => item.id === party.storeId);
  const pendingCustomReview = Boolean(plan?.allocations.some(item => item.requiresManualReview) && !reviewedCustom);
  useEffect(() => { setReviewedCustom(false); }, [plan]);

  function go(next: Step) {
    setMessage(''); setStep(next); window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function editMember(index: number) {
    setActiveMember(index);
    setPreviewRole(Math.max(0, roles.findIndex(role => role.id === party.members[index].roleId)));
    setMessage('');
    if (step !== 2) go(2);
  }
  function updateMember(patch: Partial<Member>) {
    setParty(current => ({ ...current, members: current.members.map((person, index) => index === activeMember ? { ...person, ...patch, configured: false } : person) }));
    setResult(null); setAccepted(false); setMessage('');
  }
  function toggleCategory(category: Category, kind: 'likes' | 'dislikes') {
    const other = kind === 'likes' ? 'dislikes' : 'likes';
    const next = member[kind].includes(category) ? member[kind].filter(item => item !== category) : [...member[kind], category];
    updateMember({ [kind]: next, [other]: member[other].filter(item => item !== category) });
  }
  function startMediation() {
    const error = memberError(member);
    if (error) { setMessage(error); return; }
    const members = party.members.map((person, index) => index === activeMember ? { ...person, configured: true } : person);
    const nextParty = { ...party, members };
    setParty(nextParty);
    if (activeMember < members.length - 1) {
      const index = activeMember + 1;
      setActiveMember(index);
      setPreviewRole(Math.max(0, roles.findIndex(role => role.id === members[index].roleId)));
      setMessage(''); window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); return;
    }
    const missing = members.findIndex(person => !person.configured || memberError(person));
    if (missing !== -1) { editMember(missing); setMessage(`请先完成成员${members[missing].id}的角色与属性。`); return; }
    setResult(null); setAccepted(false); setRequest({ party: nextParty }); setCourtReady(false); setProgress(0); go(3);
  }
  useEffect(() => {
    if (step !== 3 || !request) return;
    let disposed = false;
    const timers: number[] = [];
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const schedule = (delay: number, callback: () => void) => {
      timers.push(window.setTimeout(() => { if (!disposed) callback(); }, reduceMotion ? 0 : delay));
    };
    courtHoldAuto.current = false;
    setCourtReady(false);
    setResult(null);
    setProgress(0);
    schedule(420, () => setProgress(1));
    schedule(1050, () => {
      setProgress(2);
      void generateDemoPlans(request).then(next => {
        if (disposed) return;
        setResult(next);
        setCourtReady(true);
        // Stop at an actual issue instead of presenting all checks as successful.
        if (next.issues.length) { setStep(4); window.scrollTo({ top: 0, behavior: 'instant' }); return; }
        schedule(500, () => setProgress(3));
        schedule(1200, () => setProgress(4));
        schedule(1800, () => {
          if (!courtHoldAuto.current) { setStep(4); window.scrollTo({ top: 0, behavior: 'instant' }); }
        });
      }).catch(() => {
        if (!disposed) {
          setResult({ source: 'demo', plans: [], issues: [{ memberId: 0, message: '这次方案暂时没有生成成功，大家的设置已保留，可以再试一次。', kind: 'unavailable' }] });
          setStep(4);
        }
      });
    });
    return () => { disposed = true; timers.forEach(timer => window.clearTimeout(timer)); };
  }, [step, request]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (revising && dialog && !dialog.open) dialog.showModal();
    if (!revising && dialog?.open) dialog.close();
  }, [revising]);
  useEffect(() => () => { generationRef.current += 1; }, []);

  async function submitRevision() {
    if (revisionBusy) return;
    const target = party.members.find(person => person.id === revisionMember)!;
    if (['fries', 'burger', 'drink'].includes(revisionAction) && target.dislikes.includes(revisionAction as Category)) {
      setRevisionError('这项食物在该成员的不喜欢列表里，请先回角色卡调整。'); return;
    }
    const nextParty: Party = { ...party, members: party.members.map(person => {
      if (person.id !== revisionMember) return person;
      if (revisionAction === 'hungrier') return { ...person, hunger: person.hunger === 'little' ? 'hungry' : 'faint' };
      if (['fries', 'burger', 'drink'].includes(revisionAction)) return { ...person, likes: [...new Set([...person.likes, revisionAction as Category])] };
      return person;
    }) };
    setRevisionBusy(true); setRevisionError('');
    const generation = ++generationRef.current;
    try {
      await new Promise(resolve => window.setTimeout(resolve, 900));
      const next = await generateDemoPlans({ party: nextParty, revision: { memberId: revisionMember, action: revisionAction }, excludePlan: plan });
      if (generation !== generationRef.current) return;
      setParty(nextParty); setResult(next); setAccepted(false); setRevisionCount(count => count + 1); setRevising(false);
    } catch {
      if (generation === generationRef.current) setRevisionError('这次复议没有完成，请重试。');
    } finally {
      if (generation === generationRef.current) setRevisionBusy(false);
    }
  }
  function loadExample() {
    setParty(exampleParty()); setActiveMember(0); setPreviewRole(0); setResult(null); setAccepted(false); setRevisionCount(0); go(1);
  }

  return (
    <div className={`app-shell page-${step} ${keyboardOpen ? 'is-keyboard-open' : ''}`}>
      <header className="site-header">
        <button className="brand" onClick={() => go(0)} aria-label="返回调解所首页"><span className="brand-stamp">饭</span><span>麦门饭局调解所<small>THE DINNER MEDIATION CLUB</small></span></button>
        <div className="header-right"><span className="demo-badge"><i /> 可交互 DEMO</span><span className="edition">VOL. 001</span></div>
      </header>
      <nav className="chapter-nav" aria-label="饭局进度"><ol>{chapters.map((chapter, index) => <li key={chapter} className={`${index === step ? 'current' : ''} ${index < step ? 'passed' : ''}`} aria-current={index === step ? 'step' : undefined}><span>{index < step ? '✓' : `0${index + 1}`}</span><span>{chapter}</span></li>)}</ol></nav>
      <main id="main-content">
        {step === 0 && <section className="home-page">
          <div className="hero-copy"><span className="eyebrow"><span className="tiny-star">✳</span> 饭点到了，意见也到了。</span><h1>今天这顿，<br />谁都别只说<br /><span className="hero-word">“随便”<span className="word-spark">✦</span></span></h1><p className="hero-description">省钱的、饿晕的、只想吃薯条的。<br />带上各自的要求，让袋袋来主持这一顿。</p><div className="hero-actions"><button className="button button-primary button-large" onClick={() => go(1)}>开始饭局 <Arrow /></button><button className="text-button" onClick={loadExample}>体验三人示例 <span>↗</span></button></div><div className="hero-footnote"><span>2—4 人同行</span><i /><span>一台设备就够</span><i /><span>各有主张，一起开饭</span></div></div>
          <section className="hero-scene" aria-label="认识袋袋调解官"><div className="hero-portrait"><MediatorArtwork variant="hero" /></div><div className="hero-introduction"><span className="eyebrow">今日值班</span><h2>{mediatorName}</h2><p>把“都可以”，变成一份具体菜单。</p><span className="hero-greeting">大家慢慢说，这顿我来调。</span></div></section>
          <div className="home-bottom"><span className="bottom-label">HOW WE MAKE PEACE</span><div><b>01</b> 选出今日角色</div><span className="bottom-arrow">→</span><div><b>02</b> 说出各自要求</div><span className="bottom-arrow">→</span><div><b>03</b> 带着共识开饭</div></div>
        </section>}

        {step === 1 && <section className="page setup-page">
          <PageTitle number="02" eyebrow="ASSEMBLE YOUR PARTY" title="这顿饭，几个人？">先确定同行伙伴和门店，预算留到各自的角色卡里。</PageTitle>
          <div className="setup-layout"><div className="setup-fields"><section className="panel count-panel"><div className="field-heading"><span className="field-number">01</span><h2>小队人数</h2><span>2—4 人</span></div><div className="count-picker" aria-label="参与人数">{[2, 3, 4].map(count => <button key={count} className={party.members.length === count ? 'selected' : ''} aria-pressed={party.members.length === count} onClick={() => { setParty(current => ({ ...current, members: Array.from({ length: count }, (_, index) => current.members[index] ?? newMember(index + 1)) })); setActiveMember(0); setResult(null); setAccepted(false); }}><span className="people-dots">{'●'.repeat(count)}</span><strong>{count}<small>人</small></strong><span>{['双人小分队', '三人刚刚好', '四人热闹局'][count - 2]}</span></button>)}</div><p className="field-hint">用成员1、成员2……称呼大家。减少人数会移除末尾成员。</p></section>
          <section className="panel"><div className="field-heading"><span className="field-number">02</span><h2>选择门店</h2><span className="label-mini">示例门店</span></div><div className="store-list">{stores.map((item, index) => <button key={item.id} className={`store-option ${party.storeId === item.id ? 'selected' : ''}`} aria-pressed={party.storeId === item.id} onClick={() => { setParty(current => ({ ...current, storeId: item.id })); setMessage(''); setResult(null); }}><span className="store-icon">↗</span><span className="store-text"><strong>{item.name}</strong><small>{item.address}</small></span><span className="store-meta">{index === 0 ? '常去' : '备选'}</span><span className="radio-mark" /></button>)}</div><p className="field-hint">这里展示示例门店与位置，供你体验选店流程。</p></section></div>
          <aside className="setup-aside"><NpcNote>一份订单，各有所爱。{party.members.length} 位成员一起点单，餐品分别分配；预算下一步各自填写。</NpcNote><div className="mini-member-row">{party.members.map(person => <span key={person.id}>成员{person.id}</span>)}</div></aside></div>
          <div className="page-actions mobile-dock">{message && <p role="alert" className="form-error">{message}</p>}<button className="text-button" onClick={() => go(0)}><Arrow left /> 返回大厅</button><button className="button button-primary" onClick={() => { if (!party.storeId) { setMessage('请选择一家示例门店。'); return; } editMember(0); }}>创建角色 <Arrow /></button></div>
        </section>}

        {step === 2 && <section className="page character-page">
          <PageTitle number="03" eyebrow="CHOOSE YOUR CHARACTER" title="今天，你是哪一派？">角色是开场白，真正的要求由你决定。</PageTitle>
          <div className="member-tabs" aria-label="切换成员">{party.members.map((person, index) => <button key={person.id} className={index === activeMember ? 'active' : ''} aria-pressed={index === activeMember} onClick={() => editMember(index)}><span>{person.configured ? '✓' : `0${person.id}`}</span>成员{person.id}<small>{index === activeMember ? '正在设置' : person.configured ? '已配置' : '待配置'}</small></button>)}<span className="member-progress">{party.members.filter(person => person.configured).length} / {party.members.length} 已完成</span></div>
          <div className="character-layout"><RoleSelector preview={previewRole} selected={member.roleId} onPreview={setPreviewRole} onSelect={() => { const role = roles[previewRole]; const untouched = member.roleId === null && member.likes.length === 0 && member.dislikes.length === 0; updateMember({ roleId: role.id, ...(untouched ? { likes: role.likes.filter(category => !member.dislikes.includes(category)) } : {}) }); }} /><section className="attribute-panel panel"><div className="attribute-heading"><span className="eyebrow">MEMBER 0{member.id} / ATTRIBUTES</span><h2>成员{member.id}的点餐主张</h2></div><div className="attribute-field"><div className="budget-title"><label htmlFor="budget-number">个人预算上限</label><span className="budget-input"><span>¥</span><input id="budget-number" type="number" inputMode="numeric" min="1" max="200" step="1" placeholder="填写" value={member.budget ?? ''} onChange={event => updateMember({ budget: event.target.value === '' ? null : event.currentTarget.valueAsNumber })} /></span></div><input aria-label="拖动调整个人预算" className="budget-range" type="range" min="1" max="200" value={Number.isFinite(member.budget) && member.budget !== null ? member.budget : 1} onChange={event => updateMember({ budget: Number(event.target.value) })} /><div className="range-labels"><span>¥1</span><span>拖动或直接输入金额</span><span>¥200</span></div><div className="budget-presets" role="group" aria-label="常用个人预算">{[20, 25, 30, 40].map(amount => <button key={amount} className={member.budget === amount ? 'selected' : ''} aria-pressed={member.budget === amount} onClick={() => updateMember({ budget: amount })}>¥{amount}</button>)}</div></div>
          <fieldset className="attribute-field"><legend>今天有多饿？</legend><div className="hunger-picker">{hungers.map((hunger, index) => <button key={hunger.id} className={member.hunger === hunger.id ? 'selected' : ''} aria-pressed={member.hunger === hunger.id} onClick={() => updateMember({ hunger: hunger.id })}><span className="hunger-bars">{'▮'.repeat(index + 1)}<i>{'▯'.repeat(2 - index)}</i></span><strong>{hunger.label}</strong><small>{hunger.hint}</small></button>)}</div></fieldset>
          <fieldset className="attribute-field"><legend>喜欢吃什么？<small>可多选</small></legend><div className="food-chips">{categories.map(category => <button key={category.id} className={member.likes.includes(category.id) ? 'selected' : ''} aria-pressed={member.likes.includes(category.id)} onClick={() => toggleCategory(category.id, 'likes')}><span>{category.emoji}</span>{category.label}{member.likes.includes(category.id) && <i>✓</i>}</button>)}</div></fieldset>
          <fieldset className="attribute-field"><legend>不喜欢什么？<small>示例方案中将排除</small></legend><div className="food-chips food-chips--dislike">{categories.map(category => <button key={category.id} className={member.dislikes.includes(category.id) ? 'selected' : ''} aria-pressed={member.dislikes.includes(category.id)} onClick={() => toggleCategory(category.id, 'dislikes')}>{category.label}{member.dislikes.includes(category.id) && <i>×</i>}</button>)}</div></fieldset>
          <div className="attribute-field requirement-field"><label htmlFor="requirement">有一条不能退让的要求</label><select id="requirement" value={member.requirement} onChange={event => updateMember({ requirement: event.target.value as Member['requirement'] })}>{requirements.map(requirement => <option key={requirement.id} value={requirement.id}>{requirement.label}</option>)}</select>{member.requirement === 'other' && <div className="custom-requirement"><label htmlFor="custom-requirement">写下你的要求</label><textarea id="custom-requirement" rows={3} maxLength={120} placeholder="例如：饮料不要冰，或者汉堡不要酱" value={member.customRequirement ?? ''} onChange={event => updateMember({ customRequirement: event.target.value })} aria-describedby="custom-requirement-hint" /><span className="custom-counter">{(member.customRequirement ?? '').length} / 120</span></div>}<p className="field-hint" id="custom-requirement-hint">{member.requirement === 'other' ? '自填要求会完整保留；当前示例方案需要你核对是否满足。' : '预算与这条要求会作为硬性条件检查。'}</p></div></section></div>
          <div className="page-actions sticky-actions mobile-dock"><button className="text-button" onClick={() => activeMember > 0 ? editMember(activeMember - 1) : go(1)}><Arrow left />{activeMember > 0 ? '上一位' : '小队设置'}</button><div className="action-end">{message && <p className="form-error" role="alert">{message}</p>}<button className="button button-primary" onClick={startMediation}>{activeMember === party.members.length - 1 ? '开始调解' : '保存，设置下一位'}<Arrow /></button></div></div>
        </section>}

        {step === 3 && <MediationCourt party={party} progress={progress} resultReady={courtReady} onViewResult={() => { if (courtReady && result) go(4); }} onInspect={() => { courtHoldAuto.current = true; }} />}

        {step === 4 && <section className="page results-page"><PageTitle number="05" eyebrow="YOUR DINNER ENDING" title={accepted ? '这顿，就这么定了！' : '不同主张，也能一起开饭。'}>{store?.name} · {party.members.length} 位成员 · 同一订单，分别分配{revisionCount > 0 ? ` · 已复议 ${revisionCount} 次` : ''}</PageTitle>
          {!result?.plans.length ? <MediationEmptyState party={party} issues={result?.issues ?? []} onEdit={editMember} onRetry={() => { setCourtReady(false); setProgress(0); setRequest({ party }); go(3); }} />: <>
          {accepted && <div className="accepted-banner" role="status"><MediatorArtwork variant="note" /><div><strong>方案已确认，带着这份清单去点餐吧。</strong><p>这是演示确认，不会创建真实订单或扣款。</p></div><button className="text-button" onClick={() => setAccepted(false)}>继续调整</button></div>}
          <div className="strategy-tabs" role="tablist" aria-label="选择方案策略">{strategies.map(item => <button key={item.id} role="tab" id={`tab-${item.id}`} aria-controls="plan-panel" aria-selected={strategy === item.id} className={strategy === item.id ? 'active' : ''} onClick={() => { setStrategy(item.id); setAccepted(false); }}><span>{item.id === 'peace' ? '✳' : item.id === 'saving' ? '¥' : '✦'}</span><strong>{item.name}</strong><small>{item.description}</small></button>)}</div>
          {plan && <div className="results-layout" id="plan-panel" role="tabpanel" aria-labelledby={`tab-${strategy}`}><div className="mobile-plan-summary"><div><span>{strategies.find(item => item.id === strategy)!.name} · 合计</span><strong>{money(plan.totalCents)}</strong></div><p>{strategies.find(item => item.id === strategy)!.description}</p></div><div className="allocations">{plan.allocations.map(allocation => { const person = party.members.find(item => item.id === allocation.memberId)!; return <article className="allocation-card panel" key={person.id}><div className="allocation-header"><div className="allocation-member"><CharacterArtwork role={person.roleId ?? 'saver'} variant="avatar" /><div><h2>成员{person.id}<small>{roleFor(person.roleId)?.name}</small></h2><span>{hungerLabel(person.hunger)} · 预算 {money((person.budget ?? 0) * 100)}</span></div></div><div className="allocation-price"><strong>{money(allocation.totalCents)}</strong><span>余 {money(Math.round((person.budget ?? 0) * 100) - allocation.totalCents)}</span></div></div><BudgetUsage memberId={person.id} spentCents={allocation.totalCents} budgetYuan={person.budget} /><ul className="product-list">{allocation.items.map(item => { const product = productFor(item.productId); return <li key={product.id}><span className="product-emoji">{product.emoji}</span><span>{product.name}<small>{money(product.priceCents)} / 份</small></span><span className="product-quantity">×{item.quantity}</span><b>{money(product.priceCents * item.quantity)}</b></li>; })}</ul><div className="allocation-checks"><span>✓ 预算内</span>{allocation.requiresManualReview ? <span className="check-pending">自填要求待核对</span> : <span>✓ {person.requirement === 'none' ? '已按饥饿程度搭配' : memberRequirementLabel(person)}</span>}</div>{allocation.requiresManualReview && <div className="custom-review-note"><strong>你的要求：{(person.customRequirement ?? '').trim()}</strong><p>已记录；请核对上方餐品是否满足这条要求。</p></div>}</article>; })}</div>
          <aside className="result-summary"><div className="receipt panel"><span className="eyebrow">{strategies.find(item => item.id === strategy)!.eyebrow}</span><h2>本次饭局小票</h2><div className="receipt-rule" /><div className="receipt-line"><span>餐品合计</span><b>{money(plan.totalCents)}</b></div><div className="receipt-line"><span>优惠</span><span>本轮未使用</span></div><div className="receipt-line"><span>额外费用</span><span>本示例不计</span></div><div className="receipt-rule" /><div className="receipt-total"><span>总价</span><strong>{money(plan.totalCents)}</strong></div><p className="receipt-budget">每个人的花费均已分别检查预算。</p><span className="receipt-demo">示例餐品 / 示例价格 / 非真实订单</span>{!accepted && plan.allocations.some(item => item.requiresManualReview) && <label id="custom-review-confirm" className="custom-review-confirm"><input type="checkbox" checked={reviewedCustom} onChange={event => setReviewedCustom(event.target.checked)} />我已逐项核对所有自填要求</label>}{!accepted && <button className="button button-primary receipt-accept" disabled={pendingCustomReview} onClick={() => { if (!pendingCustomReview) setAccepted(true); }}>{pendingCustomReview ? '请先核对自填要求' : '接受这套方案'} <span>✓</span></button>}<button className="button button-outline" onClick={() => { setRevisionMember(party.members[0].id); setRevisionAction('cheaper'); setRevisionError(''); setRevising(true); }}>申请复议 <span>↻</span></button><button className="text-button receipt-edit" onClick={() => editMember(0)}>返回修改成员属性 <Arrow left /></button></div><NpcNote>{strategy === 'saving' ? '先满足硬性要求，再寻找最低花费。有些偏好可能需要让一步。' : strategy === 'happy' ? '在每个人的预算里，多争取一点喜欢的食物。' : '照顾大家的偏好，也给预算留一点余地。'}</NpcNote><details className="plan-notes"><summary>查看本轮说明</summary><ul>{plan.explanations.map(text => <li key={text}>{text}</li>)}</ul><p>不同策略可能得到相同组合，不代表存在三套不同菜单。</p></details></aside><div className="result-mobile-dock mobile-dock"><div className="dock-total"><span>本单合计</span><strong>{money(plan.totalCents)}</strong></div><button className="text-button dock-revise" onClick={() => { setRevisionMember(party.members[0].id); setRevisionAction('cheaper'); setRevisionError(''); setRevising(true); }}>复议 ↻</button><button className="button button-primary" disabled={accepted} onClick={() => { if (pendingCustomReview) { const review = document.getElementById('custom-review-confirm'); review?.scrollIntoView({ behavior: 'smooth', block: 'center' }); review?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); } else setAccepted(true); }}>{accepted ? '已接受 ✓' : pendingCustomReview ? '核对自填要求' : '接受方案'}{!accepted && !pendingCustomReview && <span>✓</span>}</button></div></div>}
          </>}
        </section>}
      </main>
      <footer className="site-footer"><span>饭局有分歧，开饭有共识。<span className="footer-star">✳</span></span><span>演示体验 · 示例菜单与价格 · 非真实订单</span></footer>
      <dialog ref={dialogRef} className="revision-dialog" onCancel={event => { if (revisionBusy) event.preventDefault(); else setRevising(false); }} onClose={() => { if (!revisionBusy) setRevising(false); }} aria-labelledby="revision-title"><div className="dialog-top"><div className="dialog-mediator"><MediatorArtwork variant="note" /><span>袋袋再听一轮</span></div><button className="circle-button" aria-label="关闭复议" disabled={revisionBusy} onClick={() => setRevising(false)}>×</button></div><h2 id="revision-title">这顿，还能再商量。</h2><p>只调整选中成员的诉求，其余成员的要求继续保留。</p><label htmlFor="revision-member">谁想调整？</label><select id="revision-member" value={revisionMember} disabled={revisionBusy} onChange={event => { setRevisionMember(Number(event.target.value)); setRevisionError(''); }}>{party.members.map(person => <option value={person.id} key={person.id}>成员{person.id} · {roleFor(person.roleId)?.name ?? '待选角色'}</option>)}</select><label htmlFor="revision-action">这次想怎么改？</label><select id="revision-action" value={revisionAction} disabled={revisionBusy} onChange={event => { setRevisionAction(event.target.value as Revision['action']); setRevisionError(''); }}><option value="cheaper">在原有条件下，再便宜一点</option><option value="hungrier" disabled={party.members.find(person => person.id === revisionMember)?.hunger === 'faint'}>更饿了，提高一档饥饿程度</option><option value="fries">优先安排薯条</option><option value="burger">优先安排汉堡</option><option value="drink">优先安排饮料</option></select><p className="field-hint">个人预算与不可退让的要求保持；需要更改时返回角色卡。</p>{revisionError && <p className="form-error" role="alert">{revisionError}</p>}<button className="button button-primary" disabled={revisionBusy} onClick={() => void submitRevision()}>{revisionBusy ? '正在重新核对示例方案…' : '提交复议'}<span>↻</span></button><p className="dialog-demo">本轮使用本地示例数据演示复议。</p></dialog>
    </div>
  );
}
