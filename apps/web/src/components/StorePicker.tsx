import { useEffect, useState } from 'react';
import { loadStores } from '../services/live-service';
import type { Store } from '../types/demo';

export default function StorePicker({ selected, demoStores, onSelect }: { selected: string; demoStores?: Store[]; onSelect: (store: Store | null) => void }) {
  const [city, setCity] = useState('北京');
  const [keyword, setKeyword] = useState('麦当劳');
  const [query, setQuery] = useState({ city: '北京', keyword: '麦当劳', attempt: 0 });
  const [stores, setStores] = useState<Store[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (demoStores) return;
    const controller = new AbortController();
    setBusy(true); setError(''); setStores([]);
    void loadStores(query.city, query.keyword, controller.signal).then(stores => { if (!controller.signal.aborted) setStores(stores); }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '门店查询失败，请重试。');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [query, demoStores]);

  const options = demoStores ?? stores;
  return <section className="panel" aria-label="选择麦当劳门店" aria-busy={busy}>
    <div className="field-heading"><span className="field-number">02</span><h2>选择门店</h2><span className="label-mini">{demoStores ? '示例门店' : '真实门店'}</span></div>
    {!demoStores && <form className="store-search" onSubmit={event => { event.preventDefault(); if (!city.trim()) { setError('请填写城市。'); return; } onSelect(null); setQuery(previous => ({ city, keyword, attempt: previous.attempt + 1 })); }}>
      <label>城市<input value={city} onChange={event => setCity(event.target.value)} placeholder="例如：北京" maxLength={30} required /></label>
      <label>门店关键词<input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="麦当劳或商圈" maxLength={60} /></label>
      <button className="button button-outline" type="submit">{busy ? '重新查询' : '查询门店'}</button>
    </form>}
    {busy && <p className="field-hint" role="status">正在查询门店，请稍候…</p>}
    {error && <div className="service-notice" role="alert"><p>{error}</p><button className="text-button" onClick={() => setQuery(previous => ({ ...previous, attempt: previous.attempt + 1 }))}>重新查询 ↻</button><p className="field-hint">可返回首页体验离线示例；真实模式不会用示例门店替代。</p></div>}
    {!busy && !error && options.length === 0 && <p className="field-hint">没有找到门店，试试其他城市或关键词。</p>}
    <div className="store-list">{options.map(item => <button key={item.id} className={`store-option ${selected === item.id ? 'selected' : ''}`} aria-pressed={selected === item.id} onClick={() => onSelect(item)}>
      <span className="store-icon">↗</span><span className="store-text"><strong>{item.name}</strong><small>{item.address || '地址以门店信息为准'}</small>{item.businessHours && <small>营业时间 {item.businessHours}</small>}</span><span className="store-meta">{item.businessStatus === false ? '非营业时段' : selected === item.id ? '已选' : ''}</span><span className="radio-mark" />
    </button>)}</div>
    <p className="field-hint">{demoStores ? '示例位置和价格仅用于离线体验。' : '非营业时段服务可能返回预约价；实际取餐时间与价格需在点餐时确认。'}</p>
  </section>;
}
