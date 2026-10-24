import saverOriginal from './originals/role-saver-original.png';
import hungryOriginal from './originals/role-hungry-original.png';
import friesOriginal from './originals/role-fries-original.png';
import cheeseOriginal from './originals/role-cheese-original.png';
import bagOriginal from './originals/npc-bag-original.png';
import saverSelected from './selected/role-saver-selected.png';
import hungrySelected from './selected/role-hungry-selected.png';
import friesSelected from './selected/role-fries-selected.png';
import cheeseSelected from './selected/role-cheese-selected.png';
import type { RoleId } from '../../types/demo';

export interface CharacterAsset {
  src: string;
  alt: string;
  width: number;
  height: number;
  position: string;
}

const originalSize = { width: 1536, height: 1024, position: '50% 50%' };

// Original pixels stay intact. Presentation cropping/scale lives in the component
// and scoped CSS, so a later transparent or optimized asset can use this mapping.
export const roleArtwork: Record<RoleId, CharacterAsset> = {
  saver: { ...originalSize, src: saverOriginal, alt: '省钱薯饼拿着小算盘和零钱袋的定稿立绘' },
  hungry: { ...originalSize, src: hungryOriginal, alt: '干饭堡堡举着餐叉的定稿立绘' },
  fries: { ...originalSize, src: friesOriginal, alt: '脆薯队长系着小披风的定稿立绘' },
  cheese: { ...originalSize, src: cheeseOriginal, alt: '芝士骑士举着小盾牌的定稿立绘' },
};

export const mediatorName = '袋袋调解官';

// Approved pose edits derived from each original; originals remain the idle artwork.
export const selectedRoleArtwork: Record<RoleId, CharacterAsset> = {
  saver: { ...originalSize, src: saverSelected, alt: '省钱薯饼举起算盘，眨眼竖起拇指的选中姿态' },
  hungry: { ...originalSize, src: hungrySelected, alt: '干饭堡堡举起餐叉，眨眼跳跃的选中姿态' },
  fries: { ...originalSize, src: friesSelected, alt: '脆薯队长举拳，披风展开的选中姿态' },
  cheese: { ...originalSize, src: cheeseSelected, alt: '芝士骑士高举盾牌，眨眼迈步的选中姿态' },
};

// Shared by homepage, court, inline notes and result states.
export const mediatorArtwork: CharacterAsset = {
  ...originalSize,
  src: bagOriginal,
  alt: '餐袋调解官拿着铅笔，向大家摊手介绍的定稿立绘',
};
