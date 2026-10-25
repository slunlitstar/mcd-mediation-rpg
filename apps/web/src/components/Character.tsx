import type { RoleId } from '../types/demo';
import CharacterArtwork, { MediatorArtwork } from './CharacterArtwork';

// Compatibility for older page imports: all visuals now use the approved artwork.
export default function Character({ kind = 'ticket', small = false, active = false }: { kind?: RoleId | 'ticket'; small?: boolean; active?: boolean }) {
  return kind === 'ticket'
    ? <MediatorArtwork variant={small ? 'note' : 'hero'} />
    : <CharacterArtwork role={kind} selected={active} variant={small ? 'avatar' : 'card'} />;
}
