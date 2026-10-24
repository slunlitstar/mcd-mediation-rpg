import type { ReactNode } from 'react';
import { MediatorArtwork } from './CharacterArtwork';
import { mediatorName } from '../assets/characters/character-assets';

export function Arrow({ left = false }: { left?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={left ? { transform: 'rotate(180deg)' } : undefined}><path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export function PageTitle({ number, eyebrow, title, children }: { number: string; eyebrow: string; title: string; children: ReactNode }) {
  return <header className="page-heading"><span className="eyebrow">CHAPTER {number} / {eyebrow}</span><h1>{title}<span className="heading-dot">.</span></h1><p>{children}</p></header>;
}
export function NpcNote({ children }: { children: ReactNode }) {
  return <div className="npc-note"><MediatorArtwork variant="note" /><div><strong>{mediatorName}</strong><p>{children}</p></div></div>;
}
