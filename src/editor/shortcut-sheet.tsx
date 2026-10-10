import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Icon } from './icons';
import { shortcutSheet } from './shortcuts';
import './shortcut-sheet.css';

/**
 * Keyboard shortcuts (? or the ? button): every key and gesture in Build, from the shortcuts table. Modal: focus stays inside
 * and returns where it was on close; Esc (handled with the other Build keys), the close button or the backdrop closes it.
 */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => before?.focus?.({ preventScroll: true });
  }, []);
  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    // The close button is the only control: Tab stays on it.
    event.preventDefault();
    event.stopPropagation();
  };
  return <div className="shortcut-sheet-layer">
    <div className="shortcut-sheet-scrim" aria-hidden="true" onClick={onClose}/>
    <div ref={panel} className="shortcut-sheet" role="dialog" aria-modal="true" aria-labelledby="shortcut-sheet-title" onKeyDown={keepFocusInside}>
      <header><h2 id="shortcut-sheet-title">Keyboard shortcuts</h2>
        <button type="button" aria-label="Close keyboard shortcuts" title="Close (Esc)" onClick={onClose}><Icon name="close"/></button></header>
      <div className="shortcut-sheet-groups">
        {shortcutSheet().map((section, index) => <section key={section.group} aria-labelledby={`shortcut-group-${index}`}>
          <h3 id={`shortcut-group-${index}`}>{section.group}</h3>
          <dl>{section.rows.map(row => <div key={row.id} className="shortcut-sheet-row">
            <dt>{row.keys.split(' / ').map((key, index) => <span key={key}>{index > 0 && ' / '}<kbd>{key}</kbd></span>)}</dt>
            <dd>{row.action}</dd></div>)}</dl>
        </section>)}
      </div>
    </div>
  </div>;
}
