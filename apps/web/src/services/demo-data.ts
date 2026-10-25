import type { Category, Hunger, Member, Party, Product, Requirement, RoleId, Strategy } from '../types/demo';

export const roles: { id: RoleId; name: string; title: string; quote: string; color: string; likes: Category[] }[] = [
  { id: 'saver', name: '省钱薯饼', title: '精打细算的快乐', quote: '能省一点是一点，快乐一点不能少。', color: '#eed69b', likes: [] },
  { id: 'hungry', name: '干饭堡堡', title: '主食就是底气', quote: '今天的任务只有一个：吃饱！', color: '#e9b17c', likes: ['burger'] },
  { id: 'fries', name: '脆薯队长', title: '快乐要趁热', quote: '这顿可以商量，薯条必须争取。', color: '#edb5a5', likes: ['fries'] },
  { id: 'cheese', name: '芝士骑士', title: '忠于心动的那一堡', quote: '举起小盾牌，守护我的汉堡。', color: '#e4d67e', likes: ['burger'] },
];

export const categories: { id: Category; label: string; emoji: string }[] = [
  { id: 'burger', label: '汉堡', emoji: '🍔' }, { id: 'fries', label: '薯条', emoji: '🍟' },
  { id: 'snack', label: '鸡肉小食', emoji: '🍗' }, { id: 'drink', label: '饮料', emoji: '🥤' },
  { id: 'dessert', label: '甜品', emoji: '🍦' },
];
export const hungers: { id: Hunger; label: string; hint: string; units: number }[] = [
  { id: 'little', label: '有点饿', hint: '吃点就开心', units: 2 },
  { id: 'hungry', label: '很饿了', hint: '认真吃一顿', units: 3 },
  { id: 'faint', label: '饿晕了', hint: '主食快来救我', units: 4 },
];
export const requirements: { id: Requirement; label: string }[] = [
  { id: 'none', label: '暂无不可退让的要求' }, { id: 'burger', label: '必须有汉堡' },
  { id: 'fries', label: '必须有薯条' }, { id: 'drink', label: '必须有饮料' },
  { id: 'no-spicy', label: '不吃辣' }, { id: 'no-beef', label: '不吃牛肉' },
  { id: 'other', label: '其他（自己填写）' },
];
export const strategies: { id: Strategy; name: string; eyebrow: string; description: string }[] = [
  { id: 'peace', name: '和平局', eyebrow: 'THE PEACE ENDING', description: '照顾偏好，也留一点预算余地。' },
  { id: 'saving', name: '省钱局', eyebrow: 'THE SAVER ENDING', description: '满足硬性条件后，把花费降下来。' },
  { id: 'happy', name: '快乐局', eyebrow: 'THE HAPPY ENDING', description: '在预算内，争取更多喜欢的食物。' },
];
export const stores = [
  { id: 'demo-campus', name: '校园食堂旁店', address: '示例校区 · 南门步行街 01 号', distance: '校门口的老地方' },
  { id: 'demo-plaza', name: '城市广场店', address: '示例商圈 · 广场一层 02 号', distance: '逛完街，一起吃' },
  { id: 'demo-station', name: '地铁口店', address: '示例街区 · 地铁 A 出口 03 号', distance: '下一站，开饭' },
];

// Entirely fictional products/prices. This catalog is intentionally separate from the UI.
export const products: (Product & { fullness: number })[] = [
  { id: 'chicken-burger', name: '原味鸡肉堡（示例）', category: 'burger', priceCents: 1200, fullness: 2, emoji: '🍔' },
  { id: 'beef-burger', name: '芝士牛肉堡（示例）', category: 'burger', priceCents: 1600, fullness: 2, beef: true, emoji: '🍔' },
  { id: 'spicy-burger', name: '香辣鸡肉堡（示例）', category: 'burger', priceCents: 1400, fullness: 2, spicy: true, emoji: '🍔' },
  { id: 'fries-small', name: '小份薯条（示例）', category: 'fries', priceCents: 600, fullness: 1, emoji: '🍟' },
  { id: 'fries-large', name: '大份薯条（示例）', category: 'fries', priceCents: 1000, fullness: 2, emoji: '🍟' },
  { id: 'nuggets', name: '原味鸡块（示例）', category: 'snack', priceCents: 1000, fullness: 2, emoji: '🍗' },
  { id: 'spicy-wings', name: '香辣鸡翅（示例）', category: 'snack', priceCents: 1200, fullness: 2, spicy: true, emoji: '🍗' },
  { id: 'tea', name: '无糖茶饮（示例）', category: 'drink', priceCents: 500, fullness: 0, emoji: '🥤' },
  { id: 'soda', name: '气泡饮料（示例）', category: 'drink', priceCents: 600, fullness: 0, emoji: '🥤' },
  { id: 'sundae', name: '香草甜品（示例）', category: 'dessert', priceCents: 700, fullness: 0, emoji: '🍦' },
];

export const newMember = (id: number): Member => ({
  id, roleId: null, budget: null, hunger: 'little', likes: [], dislikes: [], requirement: 'none', customRequirement: '', configured: false,
});
export const exampleParty = (): Party => ({
  storeId: stores[0].id,
  members: [
    { ...newMember(1), roleId: 'saver' as const, budget: 25, likes: ['burger' as const], requirement: 'no-spicy' as const, configured: true },
    { ...newMember(2), roleId: 'hungry' as const, budget: 35, hunger: 'faint' as const, likes: ['burger' as const], configured: true },
    { ...newMember(3), roleId: 'fries' as const, budget: 30, hunger: 'hungry' as const, likes: ['fries' as const, 'drink' as const], requirement: 'fries' as const, configured: true },
  ],
});
export const money = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
export const roleFor = (id: RoleId | null) => roles.find(role => role.id === id);
export const categoryLabel = (id: Category) => categories.find(category => category.id === id)!.label;
export const hungerLabel = (id: Hunger) => hungers.find(hunger => hunger.id === id)!.label;
export const requirementLabel = (id: Requirement) => requirements.find(requirement => requirement.id === id)!.label;
export const memberRequirementLabel = (member: Member) => member.requirement === 'other' ? (member.customRequirement ?? '').trim() : requirementLabel(member.requirement);
export const productFor = (id: string) => products.find(product => product.id === id)!;
