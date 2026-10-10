import { useState } from 'react';

/** Set once the notice is dismissed: it stays away on this browser. */
const DISMISSED_KEY = 'train-layout-workshop:small-screen-notice';

/** Phones only (styles.css shows it below 761 px): detailed editing is desktop-class; looking round, test driving and the gallery are not. */
export function SmallScreenNotice() {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISSED_KEY) !== null; } catch { return false; } });
  if (dismissed) return null;
  return <div className="small-screen-notice" role="note">
    <span>Plateway works best on a computer; you can look around, test drive and browse here.</span>
    <button type="button" aria-label="Dismiss" onClick={() => {
      setDismissed(true);
      try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* the notice just shows again next visit */ }
    }}>×</button>
  </div>;
}
