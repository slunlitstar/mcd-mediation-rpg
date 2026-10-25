import { useRef, useState } from 'react';
import CharacterArtwork from './CharacterArtwork';
import { Arrow } from './UI';
import { roles } from '../services/demo-data';
import type { RoleId } from '../types/demo';
import { useElementVisibility } from '../hooks/useElementVisibility';

interface Props {
  preview: number;
  selected: RoleId | null;
  onPreview: (index: number) => void;
  onSelect: () => void;
}

export default function RoleSelector({ preview, selected, onPreview, onSelect }: Props) {
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [direction, setDirection] = useState<'next' | 'previous'>('next');
  const { ref, active } = useElementVisibility();
  const role = roles[preview];
  const isSelected = selected === role.id;
  const move = (offset: number) => {
    setDirection(offset > 0 ? 'next' : 'previous');
    onPreview((preview + offset + roles.length) % roles.length);
  };

  return (
    <section className="role-section" aria-label="选择今日角色">
      <div
        ref={ref}
        className="role-card"
        data-motion-active={active}
        data-selected={isSelected}
        onTouchStart={event => {
          if (event.touches.length !== 1) { touchStart.current = null; return; }
          touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        }}
        onTouchEnd={event => {
          const start = touchStart.current;
          touchStart.current = null;
          if (!start) return;
          const dx = event.changedTouches[0].clientX - start.x;
          const dy = event.changedTouches[0].clientY - start.y;
          if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) move(dx < 0 ? 1 : -1);
        }}
        onTouchCancel={() => { touchStart.current = null; }}
      >
        <div className="role-card-heading">
          <span>今日角色 <b>{String(preview + 1).padStart(2, '0')}</b> / {String(roles.length).padStart(2, '0')}</span>
          <span className="role-selection-label" data-selected={isSelected} role="status">{isSelected ? '✓ 已选用' : '滑动浏览'}</span>
        </div>
        <div key={role.id} className={`role-card-content role-slide--${direction}`}>
          <div className="role-art"><CharacterArtwork role={role.id} selected={isSelected} /></div>
          <div className="role-copy" aria-live="polite">
            <span className="role-personality">{role.title}</span>
            <h2>{role.name}</h2>
            <p>{role.quote}</p>
            <button className={`button role-select-button ${isSelected ? 'button-selected' : 'button-dark'}`} aria-pressed={isSelected} onClick={() => { if (!isSelected) onSelect(); }}>
              {isSelected ? '✓ 已选用' : '选这个角色'}{!isSelected && <Arrow />}
            </button>
          </div>
        </div>
        <div className="role-navigation">
          <button className="circle-button" aria-label="上一个角色" onClick={() => move(-1)}><Arrow left /></button>
          <div className="role-position"><span className="role-navigation-hint">左右滑动换角色</span><div aria-hidden="true">{roles.map((item, index) => <span key={item.id} className={index === preview ? 'active' : ''} />)}</div></div>
          <button className="circle-button" aria-label="下一个角色" onClick={() => move(1)}><Arrow /></button>
        </div>
      </div>
      <p className="role-help">同一个角色也能重复选，自己的要求自己定。</p>
    </section>
  );
}
