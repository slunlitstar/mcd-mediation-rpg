import { useEffect, useRef, useState } from 'react';

export function useElementVisibility<T extends Element = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const updatePage = () => setPageVisible(document.visibilityState !== 'hidden');
    updatePage();
    document.addEventListener('visibilitychange', updatePage);
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return () => document.removeEventListener('visibilitychange', updatePage);
    }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.1 });
    observer.observe(element);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', updatePage); };
  }, []);
  return { ref, active: inView && pageVisible };
}
