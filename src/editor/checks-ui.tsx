import type { KeyboardEvent, ReactNode } from 'react';
import type { Check, CheckSeverity } from './checks';
import { shortcutFor } from './shortcuts';
import './checks.css';

const GROUPS: readonly { severity: CheckSeverity; label: string; icon: string }[] = [
  { severity: 'error', label: 'Errors', icon: '!' }, { severity: 'warning', label: 'Warnings', icon: '!' }, { severity: 'info', label: 'Info', icon: 'i' }];

/** Up and Down move between check rows (the shortcuts table's Checks keys). */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const id = shortcutFor(event, 'checks');
  if (id !== 'check-next' && id !== 'check-back') return;
  const step = id === 'check-next' ? 1 : -1;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.checks-locate'));
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, at + step))].focus();
}

/**
 * Build's Checks, grouped by severity. A row is a button: pressing it selects the check (the canvas frames and outlines
 * what it is about); pressing it again clears it. `extra` adds the editor's own step for a check (close a gap, open Setup).
 */
export function ChecksPanel({ checks, selectedId, onSelect, onFix, extra }: {
  checks: readonly Check[]; selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Applies the check's fix as one undoable change. */
  onFix: (check: Check) => void;
  extra: (check: Check) => ReactNode;
}) {
  const problems = checks.some(check => check.severity !== 'info');
  return <div className="checks" onKeyDown={moveFocus}>
    {!problems && <p className="checks-clear"><span className="checks-icon is-okay" aria-hidden="true">✓</span>No problems found</p>}
    {GROUPS.map(({ severity, label, icon }) => {
      const group = checks.filter(check => check.severity === severity);
      return group.length > 0 && <section key={severity} className="checks-group" aria-label={`${label}: ${group.length}`}>
        <h3>{label} <span>{group.length}</span></h3>
        {group.map(check => {
          const selected = check.id === selectedId, more = extra(check);
          return <div key={check.id} className={`checks-row is-${severity}${selected ? ' is-selected' : ''}`}>
            <button type="button" className="checks-locate" aria-pressed={selected} title={selected ? 'Clear (Esc)' : 'Show on the table'}
              onClick={() => onSelect(selected ? null : check.id)}>
              <span className={`checks-icon is-${severity}`} aria-hidden="true">{icon}</span>
              <span className="checks-text"><strong>{check.title}</strong>{check.detail && <small>{check.detail}</small>}</span>
            </button>
            {(check.fix || more) && <div className="checks-actions">
              {check.fix && <button type="button" className="builder-check-action" onClick={() => onFix(check)}>{check.fix.label}</button>}
              {more}
              {check.fix?.note && <small className="checks-fix-note">{check.fix.note}</small>}
              {more && check.actionNote && <small className="checks-fix-note">Close this gap: {check.actionNote}</small>}
            </div>}
          </div>;
        })}
      </section>;
    })}
  </div>;
}
