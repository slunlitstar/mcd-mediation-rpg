export type Step = 0 | 1 | 2 | 3 | 4;
export type RoleId = 'saver' | 'hungry' | 'fries' | 'cheese';
export type Category = 'burger' | 'fries' | 'snack' | 'drink' | 'dessert';
export type Hunger = 'little' | 'hungry' | 'faint';
export type Requirement = 'none' | 'burger' | 'fries' | 'drink' | 'no-spicy' | 'no-beef' | 'other';
export type Strategy = 'peace' | 'saving' | 'happy';

export interface Member {
  id: number;
  roleId: RoleId | null;
  budget: number | null; // Yuan; converted to integer cents for all calculations.
  hunger: Hunger;
  likes: Category[];
  dislikes: Category[];
  requirement: Requirement;
  customRequirement: string;
  configured: boolean;
}

export interface Party {
  storeId: string;
  members: Member[];
}

export interface Product {
  id: string;
  name: string;
  category: Category;
  priceCents: number;
  fullness: number; // Demo weight, not nutrition information.
  spicy?: boolean;
  beef?: boolean;
  emoji: string;
}

export interface Allocation {
  memberId: number;
  items: { productId: string; quantity: number }[];
  totalCents: number;
  matchedLikes: Category[];
  missingLikes: Category[];
  reason: string;
  requiresManualReview: boolean;
}

export interface Plan {
  strategy: Strategy;
  allocations: Allocation[];
  totalCents: number;
  explanations: string[];
}

export interface Revision {
  memberId: number;
  action: 'cheaper' | 'hungrier' | 'fries' | 'burger' | 'drink';
}

export interface MediationRequest {
  party: Party;
  revision?: Revision;
  excludePlan?: Plan;
}

export interface MediationResult {
  source: 'demo';
  plans: Plan[];
  issues: { memberId: number; message: string; kind?: 'input' | 'constraint' | 'unavailable' }[];
}
