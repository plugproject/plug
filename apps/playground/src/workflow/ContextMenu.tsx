import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
/** A blocked item stays visible and focusable, shows why and does nothing. */
export type MenuItem =
  | { label: string; blocked?: string | null; run: () => void }
  | { label: string; items: MenuItem[] }
  | { group: string; items: MenuItem[] };
interface ContextMenuProps {
  label: string;
  /** Where it opened, relative to the positioned container it renders in. */
  at: { x: number; y: number };
  items: MenuItem[];
  /** `restore` returns focus to where it was before the menu opened. */
  onClose: (restore: boolean) => void;
}
const margin = 8;
export function ContextMenu({ label, at, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [trail, setTrail] = useState<{ label: string; items: MenuItem[] }[]>(
    [],
  );
  const [place, setPlace] = useState(at);
  const open = trail.at(-1);
  useLayoutEffect(() => {
    const menu = ref.current!,
      box = menu.offsetParent as HTMLElement | null;
    if (box)
      setPlace({
        x: Math.max(
          margin,
          Math.min(at.x, box.clientWidth - menu.offsetWidth - margin),
        ),
        y: Math.max(
          margin,
          Math.min(at.y, box.clientHeight - menu.offsetHeight - margin),
        ),
      });
    // Placement lands in the next paint; scrolling now would shift the canvas.
    const all = menu.querySelectorAll<HTMLElement>('[role=menuitem]');
    (all[open && all.length > 1 ? 1 : 0] ?? null)?.focus({
      preventScroll: true,
    });
  }, [at, open]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  const back = () => setTrail((t) => t.slice(0, -1));
  const step = (
    e: React.KeyboardEvent,
    to: (i: number, n: number) => number,
  ) => {
    e.preventDefault();
    const all = [
      ...ref.current!.querySelectorAll<HTMLElement>('[role=menuitem]'),
    ];
    all[
      to(all.indexOf(document.activeElement as HTMLElement), all.length)
    ]?.focus();
  };
  const render = (list: MenuItem[]): React.ReactNode =>
    list.map((item, i) =>
      'group' in item ? (
        <div key={i} role="group" aria-label={item.group}>
          <div className="wf-menu-heading" aria-hidden="true">
            {item.group}
          </div>
          {render(item.items)}
        </div>
      ) : 'items' in item ? (
        <button
          key={i}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          onClick={() => setTrail((t) => [...t, item])}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight') return;
            e.preventDefault();
            setTrail((t) => [...t, item]);
          }}
        >
          <span>{item.label}</span>
          <span aria-hidden="true">›</span>
        </button>
      ) : (
        <button
          key={i}
          type="button"
          role="menuitem"
          aria-disabled={item.blocked ? true : undefined}
          title={item.blocked ?? undefined}
          onClick={() => {
            if (item.blocked) return;
            onClose(true);
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.blocked && <small>{item.blocked}</small>}
        </button>
      ),
    );
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={open ? `${label}: ${open.label}` : label}
      className="wf-menu nodrag nopan nowheel"
      style={{ left: place.x, top: place.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        // Keys stay in the menu; the canvas would otherwise delete the focused element.
        e.stopPropagation();
        if (e.key === 'ArrowDown') step(e, (i, n) => (i + 1) % n);
        else if (e.key === 'ArrowUp') step(e, (i, n) => (i - 1 + n) % n);
        else if (e.key === 'Home') step(e, () => 0);
        else if (e.key === 'End') step(e, (_, n) => n - 1);
        else if (e.key === 'Tab') onClose(false);
        else if (e.key === 'Escape' || (e.key === 'ArrowLeft' && open)) {
          e.preventDefault();
          if (open) back();
          else onClose(true);
        }
      }}
    >
      {open && (
        <button type="button" role="menuitem" onClick={back}>
          <span>‹ {open.label}</span>
        </button>
      )}
      {render(open?.items ?? items)}
    </div>
  );
}
