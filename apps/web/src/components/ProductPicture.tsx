import { useState } from 'react';
import { categories } from '../services/demo-data';
import type { Product } from '../types/demo';

export default function ProductPicture({ product }: { product: Product }) {
  const [failed, setFailed] = useState(false);
  return product.image && !failed ? <img className="product-photo" src={product.image} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    : <span className="product-emoji" aria-hidden="true">{product.emoji || categories.find(category => category.id === product.category)?.emoji || '🍽️'}</span>;
}
