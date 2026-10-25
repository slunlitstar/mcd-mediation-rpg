import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { mediatorArtwork, roleArtwork, selectedRoleArtwork } from '../assets/characters/character-assets';
import type { CharacterAsset } from '../assets/characters/character-assets';
import type { RoleId } from '../types/demo';

type ArtworkVariant = 'card' | 'avatar' | 'hero' | 'court' | 'note' | 'state';

function PortraitArtwork({ asset, selected = false, variant = 'card', mediator = false }: { asset: CharacterAsset; selected?: boolean; variant?: ArtworkVariant; mediator?: boolean }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <div className={`role-portrait artwork--${variant} ${mediator ? 'mediator-artwork' : ''} ${selected ? 'role-portrait--selected' : ''}`} style={{ '--portrait-position': asset.position } as CSSProperties}>
      {failedSource === asset.src ? <span className="artwork-fallback" role="img" aria-label={`${asset.alt}暂未加载`}><span aria-hidden="true">图片暂缺</span></span> : <img
        key={asset.src}
        className="role-portrait-image"
        src={asset.src}
        alt={asset.alt}
        width={asset.width}
        height={asset.height}
        decoding="async"
        loading={variant === 'avatar' || variant === 'note' ? 'lazy' : 'eager'}
        draggable={false}
        onError={() => setFailedSource(asset.src)}
      />}
    </div>
  );
}

export default function CharacterArtwork({ role, selected = false, variant = 'card' }: { role: RoleId; selected?: boolean; variant?: ArtworkVariant }) {
  const [readyPose, setReadyPose] = useState<string | null>(null);
  const pose = selectedRoleArtwork[role];

  useEffect(() => {
    if (variant !== 'card') return;
    // Only preload the role being browsed. Keep its original visible until ready,
    // so selecting a pose on a slower phone connection cannot leave an empty frame.
    let cancelled = false;
    const image = new Image();
    image.onload = () => { if (!cancelled) setReadyPose(pose.src); };
    image.src = pose.src;
    if (image.complete && image.naturalWidth > 0) setReadyPose(pose.src);
    return () => { cancelled = true; image.onload = null; };
  }, [pose.src, variant]);

  const asset = variant === 'card' && selected && readyPose === pose.src ? pose : roleArtwork[role];
  return <PortraitArtwork asset={asset} selected={selected} variant={variant} />;
}

export function MediatorArtwork({ variant = 'note' }: { variant?: ArtworkVariant }) {
  return <PortraitArtwork asset={mediatorArtwork} variant={variant} mediator />;
}
