import { useEffect, useRef, useState } from 'react';
import RoleSelector from './components/RoleSelector';
import StorePicker from './components/StorePicker';
import MealResults from './components/MealResults';
import { useMobileKeyboard } from './hooks/useMobileKeyboard';
import { MediatorArtwork } from './components/CharacterArtwork';
import MediationCourt from './pages/MediationCourt';
import { mediatorName } from './assets/characters/character-assets';
import { Arrow, NpcNote, PageTitle } from './components/UI';
import { categories, exampleParty, hungers, newMember, requirements, roleFor, roles, stores } from './services/demo-data';
import { generateDemoPlans, memberError } from './services/demo-service';
import { ApiError, generateLivePlans, preferredStrategy, prepareRecovery } from './services/live-service';
import { allocationCategories } from './services/shared-meals';
import { loadDraft, saveDraft } from './services/party-draft';
import type { Category, MediationRequest, MediationResult, Member, Party, RecoverySuggestion, Revision, Step, Store, Strategy } from './types/demo';

const chapters = ['调解所大厅', '小队集结', '职业与属性', '仲裁庭', '饭局结局'];
const initialParty = (): Party => ({ storeId: '', members: [newMember(1), newMember(2), newMember(3)] });

export default function App() {
  const [savedDraft, setSavedDraft] = useState(loadDraft);
  const [draftEnabled, setDraftEnabled] = useState(Boolean(savedDraft));
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);
  const [step, setStep] = useState<Step>(0);
  const [mode, setMode] = useState<'live' | 'demo'>(savedDraft?.mode ?? 'live');
  const live = mode === 'live';
  const [selectedStore, setSelectedStore] = useState<Store | null>(savedDraft?.store ?? null);
  const [party, setParty] = useState<Party>(savedDraft?.party ?? initialParty());
  const [activeMember, setActiveMember] = useState(savedDraft?.activeMember ?? 0);
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
  const revisionController = useRef<AbortController | null>(null);
  const keyboardOpen = useMobileKeyboard();
  const member = party.members[activeMember] ?? party.members[0];
  const plan = result?.plans.find(item => item.strategy === strategy) ?? result?.plans[0];
  const revisionTarget = party.members.find(person => person.id === revisionMember) ?? party.members[0];
  const revisionAllocation = plan?.allocations.find(allocation => allocation.memberId === revisionTarget.id);
  const revisionCatalog = result?.products;
  const revisionIncludes = (category: Category, memberId = revisionTarget.id) => allocationCategories(plan?.allocations.find(allocation => allocation.memberId === memberId), plan, revisionCatalog ?? []).includes(category);
  const store = selectedStore ?? (!live ? stores.find(item => item.id === party.storeId) : undefined);
  useEffect(() => { setReviewedCustom(false); }, [plan]);
  useEffect(() => {
    if (!draftEnabled) return;
    const stored = saveDraft({ mode, party, store: selectedStore, activeMember });
    setDraftSaveFailed(!stored); if (stored) setSavedDraft(stored);
  }, [draftEnabled, mode, party, selectedStore, activeMember]);

  function go(next: Step) {
    if (next !== 4) {
      generationRef.current += 1; revisionController.current?.abort();
      setRevisionBusy(false); setRevising(false);
    }
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
    const controller = new AbortController();
    let disposed = false;
    const timers: number[] = [];
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const schedule = (delay: number, callback: () => void) => {
      timers.push(window.setTimeout(() => { if (!disposed) callback(); }, reduceMotion ? 0 : delay));
    };
    courtHoldAuto.current = false;
    setCourtReady(false); setResult(null); setProgress(1);
    // Real requests stay in one pending stage; no timer invents MCP or model progress.
    const pending = live ? generateLivePlans(request, controller.signal) : generateDemoPlans(request);
    void pending.then(next => {
      if (disposed) return;
      setResult(next); setStrategy(preferredStrategy(next.plans)); setCourtReady(true); setProgress(4);
      if (!next.plans.length) { setStep(4); window.scrollTo({ top: 0, behavior: 'instant' }); return; }
      schedule(850, () => { if (!courtHoldAuto.current) { setStep(4); window.scrollTo({ top: 0, behavior: 'instant' }); } });
    }).catch(error => {
      if (disposed) return;
      setResult({ source: live ? 'live' : 'demo', plans: [], issues: [{ memberId: 0, message: error instanceof Error ? error.message : '方案暂时未生成，请重试。', kind: error instanceof ApiError && error.kind === 'bad_request' ? 'input' : 'unavailable', blocking: true }] });
      setCourtReady(true); setStep(4);
    });
    return () => { disposed = true; controller.abort(); timers.forEach(timer => window.clearTimeout(timer)); };
  }, [step, request, live]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (revising && dialog && !dialog.open) dialog.showModal();
    if (!revising && dialog?.open) dialog.close();
  }, [revising]);
  useEffect(() => () => { generationRef.current += 1; revisionController.current?.abort(); }, []);

  async function submitRevision() {
    if (revisionBusy || !plan) return;
    const target = party.members.find(person => person.id === revisionMember)!;
    if (['fries', 'burger', 'drink'].includes(revisionAction) && target.dislikes.includes(revisionAction as Category)) {
      setRevisionError('这项食物在该成员的不喜欢列表里，请先回角色卡调整。'); return;
    }
    if (live && ['fries', 'burger', 'drink'].includes(revisionAction) && revisionIncludes(revisionAction as Category)) {
      setRevisionError('当前分配已包含这类食物（含套餐默认子项）。想增加份量，可以选择“更饿了”。'); return;
    }
    const nextParty: Party = { ...party, members: party.members.map(person => {
      if (person.id !== revisionMember) return person;
      if (revisionAction === 'hungrier') return { ...person, hunger: person.hunger === 'little' ? 'hungry' : 'faint' };
      if (['fries', 'burger', 'drink'].includes(revisionAction)) return { ...person, likes: [...new Set([...person.likes, revisionAction as Category])] };
      return person;
    }) };
    setRevisionBusy(true); setRevisionError('');
    const generation = ++generationRef.current;
    const controller = new AbortController(); revisionController.current = controller;
    try {
      const input = { party: nextParty, revision: { memberId: revisionMember, action: revisionAction }, excludePlan: plan };
      const next = live ? await generateLivePlans(input, controller.signal) : await generateDemoPlans(input);
      if (generation !== generationRef.current) return;
      if (!next.plans.length) { setRevisionError(next.issues.map(issue => issue.message).join('；') || '暂未找到符合条件的新方案，原方案已保留。'); return; }
      setParty(nextParty); setResult(next); setStrategy(preferredStrategy(next.plans, strategy)); setAccepted(false); setReviewedCustom(false); setRevisionCount(count => count + 1); setRevising(false);
    } catch (error) {
      if (generation === generationRef.current) setRevisionError(error instanceof Error ? error.message : '这次复议未完成，原方案已保留，请重试。');
    } finally {
      if (generation === generationRef.current) setRevisionBusy(false);
    }
  }
  function beginLive() {
    setDraftEnabled(true);
    setMode('live'); setParty(initialParty()); setSelectedStore(null); setActiveMember(0); setPreviewRole(0); setResult(null); setAccepted(false); setRevisionCount(0); go(1);
  }
  function loadExample() {
    setDraftEnabled(true);
    setMode('demo'); setSelectedStore(null); setParty(exampleParty()); setActiveMember(0); setPreviewRole(0); setResult(null); setAccepted(false); setRevisionCount(0); go(1);
  }
  function openRevision() { setRevisionMember(party.members[0].id); setRevisionAction('cheaper'); setRevisionError(''); setRevising(true); }
  function useSuggestion(suggestion: RecoverySuggestion) {
    if (!result) return;
    try {
      const next = prepareRecovery(result, party, suggestion);
      setParty(next.party); setResult(next.result); setStrategy(preferredStrategy(next.result.plans));
      setAccepted(false); setReviewedCustom(false); setMessage('');
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (error) { setMessage(error instanceof Error ? error.message : '建议已失效，请重新生成。'); }
  }
  function resumeDraft() {
    setResult(null); setAccepted(false); setReviewedCustom(false);
    if (party.storeId) editMember(Math.min(activeMember, party.members.length - 1)); else go(1);
  }
  return (
    <div className={`app-shell page-${step} ${keyboardOpen ? 'is-keyboard-open' : ''}`}>
      <header className="site-header">
        <button className="brand" onClick={() => go(0)} aria-label="返回调解所首页"><span className="brand-stamp">饭</span><span>麦门饭局调解所<small>THE DINNER MEDIATION CLUB</small></span></button>
        <div className="header-right"><span className="demo-badge"><i /> {live ? '真实菜单' : '离线示例'}</span><span className="edition">VOL. 001</span></div>
      </header>
      <nav className="chapter-nav" aria-label="饭局进度"><ol>{chapters.map((chapter, index) => <li key={chapter} className={`${index === step ? 'current' : ''} ${index < step ? 'passed' : ''}`} aria-current={index === step ? 'step' : undefined}><span>{index < step ? '✓' : `0${index + 1}`}</span><span>{chapter}</span></li>)}</ol></nav>
      <main id="main-content">
        {step === 0 && savedDraft && <div className="page draft-resume service-notice"><strong>上次饭局的设置已保留 · {party.members.length} 位成员</strong><p>继续填写后重新核对菜单与价格，不会自动请求模型。</p><button className="button button-outline" onClick={resumeDraft}>继续上次饭局 <Arrow /></button></div>}
        {draftSaveFailed && <p className="page service-notice" role="status">浏览器暂时无法保存设置，请保持当前页面打开。</p>}
        {step === 0 && <section className="home-page">
          <div className="hero-copy"><span className="eyebrow"><span className="tiny-star">✳</span> 饭点到了，意见也到了。</span><h1>今天这顿，<br />谁都别只说<br /><span className="hero-word">“随便”<span className="word-spark">✦</span></span></h1><p className="hero-description">省钱的、饿晕的、只想吃薯条的。<br />带上各自的要求，让袋袋来主持这一顿。</p><div className="hero-actions"><button className="button button-primary button-large" onClick={beginLive}>开始饭局 <Arrow /></button><button className="text-button" onClick={loadExample}>体验三人示例 <span>↗</span></button></div><div className="hero-footnote"><span>2—4 人同行</span><i /><span>一台设备就够</span><i /><span>各有主张，一起开饭</span></div></div>
          <section className="hero-scene" aria-label="认识袋袋调解官"><div className="hero-portrait"><MediatorArtwork variant="hero" /></div><div className="hero-introduction"><span className="eyebrow">今日值班</span><h2>{mediatorName}</h2><p>把“都可以”，变成一份具体菜单。</p><span className="hero-greeting">大家慢慢说，这顿我来调。</span></div></section>
          <div className="home-bottom"><span className="bottom-label">HOW WE MAKE PEACE</span><div><b>01</b> 选出今日角色</div><span className="bottom-arrow">→</span><div><b>02</b> 说出各自要求</div><span className="bottom-arrow">→</span><div><b>03</b> 带着共识开饭</div></div>
        </section>}

        {step === 1 && <section className="page setup-page">
          <PageTitle number="02" eyebrow="ASSEMBLE YOUR PARTY" title="这顿饭，几个人？">先确定同行伙伴和门店，预算留到各自的角色卡里。</PageTitle>
          <div className="setup-layout"><div className="setup-fields"><section className="panel count-panel"><div className="field-heading"><span className="field-number">01</span><h2>小队人数</h2><span>2—4 人</span></div><div className="count-picker" aria-label="参与人数">{[2, 3, 4].map(count => <button key={count} className={party.members.length === count ? 'selected' : ''} aria-pressed={party.members.length === count} onClick={() => { setParty(current => ({ ...current, members: Array.from({ length: count }, (_, index) => current.members[index] ?? newMember(index + 1)) })); setActiveMember(0); setResult(null); setAccepted(false); }}><span className="people-dots">{'●'.repeat(count)}</span><strong>{count}<small>人</small></strong><span>{['双人小分队', '三人刚刚好', '四人热闹局'][count - 2]}</span></button>)}</div><p className="field-hint">用成员1、成员2……称呼大家。减少人数会移除末尾成员。</p></section>
          <StorePicker key={mode} selected={party.storeId} demoStores={live ? undefined : stores} onSelect={item => { setSelectedStore(item); setParty(current => ({ ...current, storeId: item?.id ?? '' })); setMessage(''); setResult(null); setAccepted(false); }} /></div>
          <aside className="setup-aside"><NpcNote>一份订单，各有所爱。{party.members.length} 位成员一起点单；可分别搭配，也会比较共享套餐。预算下一步各自填写。</NpcNote><div className="mini-member-row">{party.members.map(person => <span key={person.id}>成员{person.id}</span>)}</div></aside></div>
          <div className="page-actions mobile-dock">{message && <p role="alert" className="form-error">{message}</p>}<button className="text-button" onClick={() => go(0)}><Arrow left /> 返回大厅</button><button className="button button-primary" onClick={() => { if (!party.storeId) { setMessage('请选择一家门店。'); return; } editMember(0); }}>创建角色 <Arrow /></button></div>
        </section>}

        {step === 2 && <section className="page character-page">
          <PageTitle number="03" eyebrow="CHOOSE YOUR CHARACTER" title="今天，你是哪一派？">角色是开场白，真正的要求由你决定。</PageTitle>
          <div className="member-tabs" aria-label="切换成员">{party.members.map((person, index) => <button key={person.id} className={index === activeMember ? 'active' : ''} aria-pressed={index === activeMember} onClick={() => editMember(index)}><span>{person.configured ? '✓' : `0${person.id}`}</span>成员{person.id}<small>{index === activeMember ? '正在设置' : person.configured ? '已配置' : '待配置'}</small></button>)}<span className="member-progress">{party.members.filter(person => person.configured).length} / {party.members.length} 已完成</span></div>
          <div className="character-layout"><RoleSelector preview={previewRole} selected={member.roleId} onPreview={setPreviewRole} onSelect={() => { const role = roles[previewRole]; const untouched = member.roleId === null && member.likes.length === 0 && member.dislikes.length === 0; updateMember({ roleId: role.id, ...(untouched ? { likes: role.likes.filter(category => !member.dislikes.includes(category)) } : {}) }); }} /><section className="attribute-panel panel"><div className="attribute-heading"><span className="eyebrow">MEMBER 0{member.id} / ATTRIBUTES</span><h2>成员{member.id}的点餐主张</h2></div><div className="attribute-field"><div className="budget-title"><label htmlFor="budget-number">个人预算上限</label><span className="budget-input"><span>¥</span><input id="budget-number" type="number" inputMode="numeric" min="1" max="200" step="1" placeholder="填写" value={member.budget ?? ''} onChange={event => updateMember({ budget: event.target.value === '' ? null : event.currentTarget.valueAsNumber })} /></span></div><input aria-label="拖动调整个人预算" className="budget-range" type="range" min="1" max="200" value={Number.isFinite(member.budget) && member.budget !== null ? member.budget : 1} onChange={event => updateMember({ budget: Number(event.target.value) })} /><div className="range-labels"><span>¥1</span><span>拖动或直接输入金额</span><span>¥200</span></div><div className="budget-presets" role="group" aria-label="常用个人预算">{[20, 25, 30, 40].map(amount => <button key={amount} className={member.budget === amount ? 'selected' : ''} aria-pressed={member.budget === amount} onClick={() => updateMember({ budget: amount })}>¥{amount}</button>)}</div></div>
          <fieldset className="attribute-field"><legend>今天有多饿？</legend><div className="hunger-picker">{hungers.map((hunger, index) => <button key={hunger.id} className={member.hunger === hunger.id ? 'selected' : ''} aria-pressed={member.hunger === hunger.id} onClick={() => updateMember({ hunger: hunger.id })}><span className="hunger-bars">{'▮'.repeat(index + 1)}<i>{'▯'.repeat(2 - index)}</i></span><strong>{hunger.label}</strong><small>{hunger.hint}</small></button>)}</div></fieldset>
          <fieldset className="attribute-field"><legend>喜欢吃什么？<small>可多选</small></legend><div className="food-chips">{categories.map(category => <button key={category.id} className={member.likes.includes(category.id) ? 'selected' : ''} aria-pressed={member.likes.includes(category.id)} onClick={() => toggleCategory(category.id, 'likes')}><span>{category.emoji}</span>{category.label}{member.likes.includes(category.id) && <i>✓</i>}</button>)}</div></fieldset>
          <fieldset className="attribute-field"><legend>不喜欢什么？<small>推荐中将排除</small></legend><div className="food-chips food-chips--dislike">{categories.map(category => <button key={category.id} className={member.dislikes.includes(category.id) ? 'selected' : ''} aria-pressed={member.dislikes.includes(category.id)} onClick={() => toggleCategory(category.id, 'dislikes')}>{category.label}{member.dislikes.includes(category.id) && <i>×</i>}</button>)}</div></fieldset>
          <div className="attribute-field requirement-field"><label htmlFor="requirement">有一条不能退让的要求</label><select id="requirement" value={member.requirement} onChange={event => updateMember({ requirement: event.target.value as Member['requirement'] })}>{requirements.map(requirement => <option key={requirement.id} value={requirement.id}>{requirement.label}</option>)}</select>{member.requirement === 'other' && <div className="custom-requirement"><label htmlFor="custom-requirement">写下你的要求</label><textarea id="custom-requirement" rows={3} maxLength={120} placeholder="例如：饮料不要冰，或者汉堡不要酱" value={member.customRequirement ?? ''} onChange={event => updateMember({ customRequirement: event.target.value })} aria-describedby="custom-requirement-hint" /><span className="custom-counter">{(member.customRequirement ?? '').length} / 120</span></div>}<p className="field-hint" id="custom-requirement-hint">{member.requirement === 'other' ? '自填要求会完整保留；推荐结果需要你核对是否满足。' : '预算与这条要求会作为硬性条件检查。'}</p></div></section></div>
          <div className="page-actions sticky-actions mobile-dock"><button className="text-button" onClick={() => activeMember > 0 ? editMember(activeMember - 1) : go(1)}><Arrow left />{activeMember > 0 ? '上一位' : '小队设置'}</button><div className="action-end">{message && <p className="form-error" role="alert">{message}</p>}<button className="button button-primary" onClick={startMediation}>{activeMember === party.members.length - 1 ? '开始调解' : '保存，设置下一位'}<Arrow /></button></div></div>
        </section>}

        {step === 3 && <MediationCourt live={live} party={party} progress={progress} resultReady={courtReady} onViewResult={() => { if (courtReady && result) go(4); }} onInspect={() => { courtHoldAuto.current = true; }} />}

        {step === 4 && message && <p className="page form-error" role="alert">{message}</p>}
        {step === 4 && <MealResults party={party} result={result} live={live} storeName={store?.name} strategy={strategy} onStrategy={value => { setStrategy(value); setReviewedCustom(false); }} accepted={accepted} onAccept={setAccepted} reviewed={reviewedCustom} onReviewed={setReviewedCustom} revisionCount={revisionCount} onEdit={editMember} onRetry={() => { setCourtReady(false); setProgress(0); setRequest({ party }); go(3); }} onRevise={openRevision} onSuggestion={useSuggestion} />}
      </main>
      <footer className="site-footer"><span>饭局有分歧，开饭有共识。<span className="footer-star">✳</span></span><span>{live ? '真实门店与试算 · 仅推荐，不下单' : '离线体验 · 示例菜单与价格'}</span></footer>
      <dialog ref={dialogRef} className="revision-dialog" onCancel={event => { if (revisionBusy) event.preventDefault(); else setRevising(false); }} onClose={() => { if (!revisionBusy) setRevising(false); }} aria-labelledby="revision-title"><div className="dialog-top"><div className="dialog-mediator"><MediatorArtwork variant="note" /><span>袋袋再听一轮</span></div><button className="circle-button" aria-label="关闭复议" disabled={revisionBusy} onClick={() => setRevising(false)}>×</button></div><h2 id="revision-title">这顿，还能再商量。</h2><p>重新搭配选中成员的一餐，其余成员的餐品保持不变。</p><label htmlFor="revision-member">谁想调整？</label><select id="revision-member" value={revisionMember} disabled={revisionBusy} onChange={event => { setRevisionMember(Number(event.target.value)); setRevisionAction('cheaper'); setRevisionError(''); }}>{party.members.map(person => <option value={person.id} key={person.id}>成员{person.id} · {roleFor(person.roleId)?.name ?? '待选角色'}</option>)}</select><label htmlFor="revision-action">这次想怎么改？</label><select id="revision-action" value={revisionAction} disabled={revisionBusy} onChange={event => { setRevisionAction(event.target.value as Revision['action']); setRevisionError(''); }}><option value="cheaper">在原有条件下，再便宜一点</option><option value="hungrier">更饿了，增加主餐或配餐</option>{(['fries', 'burger', 'drink'] as const).map(category => { const included = live && revisionIncludes(category); const excluded = revisionTarget.dislikes.includes(category); return <option key={category} value={category} disabled={included || excluded}>{({ fries: '安排薯条', burger: '安排汉堡', drink: '安排饮料' })[category]}{excluded ? '（已排除）' : included ? '（当前已包含）' : ''}</option>; })}</select><div className="revision-current"><strong>当前个人实付 ¥{((revisionAllocation?.totalCents ?? 0) / 100).toFixed(2)} / 预算 ¥{revisionTarget.budget}</strong><p>{revisionAllocation?.sharedItems?.length ? '共享套餐和分餐保持不变；本轮调整你的个人加餐。更换共享套餐请重新生成整顿饭的方案。' : '会重新搭配整份餐，允许替换单品和默认套餐；其他成员餐品保留。'}</p></div><p className="field-hint">预算和食物限制保持。“更饿了”比较主餐／配餐份数，不承诺实际饱腹程度。</p>{revisionError && <p className="form-error" role="alert">{revisionError}</p>}<button className="button button-primary" disabled={revisionBusy} onClick={() => void submitRevision()}>{revisionBusy ? '正在重新试算…' : '提交复议'}<span>↻</span></button><p className="dialog-demo">{live ? '仅调整推荐方案，不会创建订单。' : '本轮使用本地示例数据演示复议。'}</p></dialog>
    </div>
  );
}
