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
  fullness: number | null; // Demo weight only; real products have no fullness data.
  spicy?: boolean;
  beef?: boolean;
  emoji: string;
  image?: string | null;
  dietary?: { spicy: { inferred: boolean; source: string; confidence: string }; beef: { inferred: boolean; source: string; confidence: string }; note: string };
}

export interface Allocation {
  memberId: number;
  items: { productId: string; quantity: number; unitPriceCents?: number; subtotalCents?: number }[];
  totalCents: number;
  matchedLikes: Category[];
  missingLikes: Category[];
  reason: string;
  requiresManualReview: boolean;
}

export interface Plan {
  planId?: string;
  strategy: Strategy;
  allocations: Allocation[];
  totalCents: number;
  explanations: string[];
  productSubtotalCents?: number;
  discountCents?: number;
  payableCents?: number;
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
  source: 'demo' | 'live';
  plans: Plan[];
  issues: { memberId?: number; message: string; kind?: 'input' | 'constraint' | 'unavailable'; code?: string; blocking?: boolean }[];
  products?: Product[];
  store?: Store;
  hints?: { memberId?: number; level: 'info' | 'warn'; message: string }[];
  meta?: { planner: string; pricingVerified: boolean; reasoning: string; llm?: string; degraded: boolean; strategiesDeduplicated?: Strategy[] };
}

export interface Store {
  id: string;
  name: string;
  address?: string;
  businessStatus?: boolean;
  businessHours?: string;
  distance?: number | string;
}
