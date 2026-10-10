import { useState } from 'react';
import type { WorkshopProject } from '../domain/project';
import { appendObservation, checkStatus, consistIdentity, recordCheck, type CheckKind } from '../domain/trials';
import { matchingCoupon, type ArtifactReceipt } from './receipt';
import './evidence.css';

/** A coupon fit report applies only to the current sample file and the print settings it was sliced with. */
export function couponFitStatus(project: WorkshopProject, receipts: readonly ArtifactReceipt[]): 'pending' | 'failed' | 'passed' {
  const coupons = receipts.filter(receipt => matchingCoupon(project, receipt));
  const applicable = project.observations.filter(item => item.kind === 'fit' && coupons.some(receipt =>
    item.partRevision === receipt.parts[0].digest &&
    item.material === receipt.printer.material && item.printer === receipt.printer.name &&
    item.printProfile === receipt.printer.profile && item.nozzleMm === receipt.printer.nozzleMm));
  if (applicable.some(item => !item.passed)) return 'failed';
  return applicable.some(item => item.passed) ? 'passed' : 'pending';
}

export function recordCouponFit(project: WorkshopProject, receipt: ArtifactReceipt,
  passed: boolean, notes: string, confirmed: boolean): WorkshopProject {
  if (!confirmed) throw new Error('Confirm that you printed and tested this sample yourself.');
  if (!matchingCoupon(project, receipt)) throw new Error('This sample no longer matches your current settings. Generate a new one.');
  return appendObservation(project, {
    id: crypto.randomUUID(), kind: 'fit', passed, partRevision: receipt.parts[0].digest,
    material: receipt.printer.material, printer: receipt.printer.name,
    printProfile: receipt.printer.profile, nozzleMm: receipt.printer.nozzleMm,
    orientation: receipt.printer.orientation, consistId: consistIdentity(project),
    notes: notes.trim(), recordedAt: new Date().toISOString()
  });
}

const CHECKS: Record<CheckKind, string> = {
  grade: 'Train climbs the ramp',
  'under-run': 'Train passes under the bridge',
  'over-run': 'Bridge supports stay still'
};

export function PhysicalChecks({ project, kinds, onChange }: { project: WorkshopProject; kinds: readonly CheckKind[];
  onChange?: (project: WorkshopProject) => void }) {
  const [open, setOpen] = useState<CheckKind | null>(null);
  const [notes, setNotes] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');

  function toggle(kind: CheckKind) {
    setOpen(open === kind ? null : kind);
    setNotes(''); setConfirmed(false); setError('');
  }

  function report(kind: CheckKind, worked: boolean) {
    if (!onChange) return;
    try {
      onChange(recordCheck(project, kind, worked, notes, confirmed));
      setOpen(null); setNotes(''); setConfirmed(false); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save this result.'); }
  }

  return <div className="export-checks"><h3 className="export-section-label">AFTER YOU PRINT</h3>
    {kinds.map(kind => {
      const status = checkStatus(project, kind);
      return <div key={kind} className="physical-check">
        <button type="button" className={`export-check ${status} ${open === kind ? 'selected' : ''}`} aria-expanded={open === kind} onClick={() => toggle(kind)}>
          <span className="export-check-icon" aria-hidden="true">{status === 'worked' ? '✓' : status === 'failed' ? '!' : ''}</span>
          <span><strong>{CHECKS[kind]}</strong><small>{status === 'worked' ? 'Worked' : status === 'failed' ? "Didn't work — adjust and try again" : 'Not tried yet'}</small></span>
        </button>
        {open === kind && <div className="physical-check-form">
          <label className="export-fit-notes">Note (optional)<input value={notes} onChange={event => setNotes(event.target.value)} /></label>
          <label className="export-fit-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I printed and tested this myself</label>
          <div className="physical-check-results">
            <button type="button" disabled={!confirmed || !onChange} onClick={() => report(kind, true)}>Worked</button>
            <button type="button" disabled={!confirmed || !onChange} onClick={() => report(kind, false)}>Didn't work</button>
          </div>
          {error && <p className="export-gate" role="status">{error}</p>}
        </div>}
      </div>;
    })}
  </div>;
}
