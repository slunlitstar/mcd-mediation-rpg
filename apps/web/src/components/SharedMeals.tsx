import ProductPicture from './ProductPicture';
import { categories, money } from '../services/demo-data';
import type { Allocation, Plan, Product, SharedMeal } from '../types/demo';

const people = (ids: number[]) => ids.map(id => `成员${id}`).join('、');

export function SharedMealList({ plan, products }: { plan: Plan; products: Product[] }) {
  if (!plan.sharedMeals?.length) return null;
  return <section className="shared-meals" aria-label="共享套餐与分餐清单">
    <div><h2>这一份，一起分享</h2><p>套餐只买一次，以下分餐已计入每位成员的花费。</p></div>
    {plan.sharedMeals.map(meal => {
      const product = products.find(product => product.id === meal.productId)!;
      const grouped = new Map<string, { component: SharedMeal['components'][number]; quantity: number }>();
      for (const component of meal.components) { const key = JSON.stringify([component.id, component.memberIds]); const existing = grouped.get(key); if (existing) existing.quantity += component.quantity; else grouped.set(key, { component, quantity: component.quantity }); }
      return <article className="shared-meal-card panel" key={meal.sharedMealId}>
        <div className="shared-meal-heading"><ProductPicture product={product} /><div><span className="combo-label">{people(meal.memberIds)}共享</span><h3>{product.name} ×{meal.quantity}</h3></div></div>
        <div className="shared-meal-price"><span>整套试算小计</span><strong>{money(meal.subtotalCents)}</strong></div>
        <ul className="shared-meal-parts">{[...grouped.values()].map(({ component, quantity }) => <li key={component.componentId}><span>{component.name} ×{quantity}</span><b>{people(component.memberIds)}{component.memberIds.length > 1 ? '共同食用' : ''}</b></li>)}</ul>
        <p className="shared-allocation-note">{meal.allocationBasis === 'component-menu-price' ? '按分到餐品的当前单点菜单价比例分摊，共同配餐在参与者间均分份额。' : '部分餐品缺少单点价，按分到的餐品份数分摊，共同配餐均分份额。'}整单优惠另行分摊，以成员卡实付为准；不要重复加上本套餐小计。</p>
      </article>;
    })}
  </section>;
}

export function SharedMemberItems({ allocation, plan, products }: { allocation: Allocation; plan: Plan; products: Product[] }) {
  if (!allocation.sharedItems?.length) return null;
  const grouped = new Map<string, { meal: SharedMeal; component: SharedMeal['components'][number]; quantity: number }>();
  for (const ref of allocation.sharedItems) {
    const meal = plan.sharedMeals!.find(meal => meal.sharedMealId === ref.sharedMealId)!;
    const component = meal.components.find(component => component.componentId === ref.componentId)!;
    const key = JSON.stringify([meal.sharedMealId, component.id, component.memberIds]);
    const existing = grouped.get(key); if (existing) existing.quantity += component.quantity; else grouped.set(key, { meal, component, quantity: component.quantity });
  }
  return <ul className="product-list shared-member-items">{[...grouped.values()].map(({ meal, component, quantity }) => {
    const product = products.find(product => product.id === component.id);
    const parent = products.find(product => product.id === meal.productId)!;
    return <li key={`${meal.sharedMealId}/${component.componentId}`}>
      {product ? <ProductPicture product={product} /> : <span className="product-emoji" aria-hidden="true">{categories.find(category => category.id === component.category)?.emoji ?? '🍽️'}</span>}
      <span>{component.name}<small className="shared-item-origin">来自共享的{parent.name}</small><small>{component.memberIds.length > 1 ? `与${people(component.memberIds.filter(id => id !== allocation.memberId))}共同食用这${quantity}份` : `${quantity}份分配给你`}</small></span>
      <span className="shared-item-tag">{component.memberIds.length > 1 ? `共享${quantity}份` : `×${quantity}`}</span>
    </li>;
  })}</ul>;
}
