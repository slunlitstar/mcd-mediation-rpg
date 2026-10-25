import { useEffect, useState } from 'react';

// iOS shrinks the visual viewport while retaining the layout viewport. Hide the
// action dock during typing so it cannot sit over the active text field.
export function useMobileKeyboard() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const editing = document.activeElement?.matches('textarea, input[type="number"], input[type="text"]') ?? false;
        setOpen(editing && window.innerHeight - viewport.height > 140);
      });
    };
    viewport.addEventListener('resize', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);
  return open;
}
