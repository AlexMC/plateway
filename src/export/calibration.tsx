import { useEffect, useState } from 'react';
import { serviceOnline, type Account } from '../account/account';
import { changeProject, type TrackStyle, type WorkshopProject } from '../domain/project';
import { calibrationStyle, effectivePrint, fastProcess, layerHeight, styleCounts } from '../domain/printer';
import { applyCalibration, calibrationKey, effectiveFitAdjustment, loadCalibrations, saveCalibration, savedCalibrations, setFitAdjustment, type CalibrationProfile } from '../domain/calibration';
import { couponFitStatus, recordCouponFit } from './evidence-view';
import { artifactUrl, filesExpired, type ArtifactReceipt } from './receipt';

type FitOutcome = CalibrationProfile['result'];
const OUTCOMES: Array<{ value: FitOutcome; label: string }> = [
  { value: 'too-tight', label: 'Too tight' }, { value: 'fits', label: 'Fits' }, { value: 'too-loose', label: 'Too loose' }
];
const adjustmentLabel = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)} mm`;

/** `limitNote`: the daily limit is reached and when it frees up (no sample can be generated meanwhile);
 * `onPrepareAgain`: prepares the current sample again once its files have expired. */
export function CalibrationPanel({ project, coupon, receipts, account, busy, limitNote = '', onChange, onPrepare, onPrepareAgain, onNotice }: {
  project: WorkshopProject; coupon?: ArtifactReceipt; receipts: readonly ArtifactReceipt[]; account: Account;
  busy: boolean; limitNote?: string; onChange?: (project: WorkshopProject) => void; onPrepare: () => void; onPrepareAgain: () => void;
  onNotice: (message: string) => void;
}) {
  const [profiles, setProfiles] = useState<CalibrationProfile[]>([]);
  const [libraryError, setLibraryError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  /** The calibration library is the member's; visitors can still generate a sample (which asks them to sign up). */
  const member = account.status === 'member';
  const key = calibrationKey(project);
  const adjustment = effectiveFitAdjustment(project);
  const fitStatus = couponFitStatus(project, receipts);
  const saved = savedCalibrations(project, profiles);
  const staleAdjustment = project.connectorFit.settingsKey !== null && project.connectorFit.settingsKey !== key;
  const locked = !onChange || busy || saving;
  const counts = styleCounts(project), testStyle = calibrationStyle(project);
  const processes: Array<[TrackStyle, string]> = [['detailed', effectivePrint(project).profile], ['fast', fastProcess(project)]];

  useEffect(() => {
    if (!member) { setProfiles([]); setLibraryError(''); return; }
    let active = true;
    void loadCalibrations().then(items => {
      if (active) { setProfiles(items); setLibraryError(''); }
    }).catch(error => {
      if (active) setLibraryError(error instanceof Error ? error.message : 'Could not load your saved results.');
    });
    return () => { active = false; };
  }, [member]);

  useEffect(() => { setConfirmed(false); setNotes(''); }, [coupon?.id, key, adjustment]);

  function adjust(value: number) {
    if (!onChange) return;
    try {
      onChange(setFitAdjustment(project, value));
      onNotice('Fit adjustment changed. Generate a new sample to test it.');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Could not change the fit adjustment.'); }
  }

  async function report(result: FitOutcome) {
    if (!coupon || !onChange || !confirmed || saving || busy) return;
    setSaving(true);
    let recorded = false;
    try {
      onChange(recordCouponFit(project, coupon, result === 'fits', `${result}: ${notes.trim()}`, true));
      recorded = true;
      const profile = await saveCalibration(project, coupon, result, notes);
      setProfiles(previous => [...previous.filter(item => item.id !== profile.id), profile]);
      setLibraryError('');
      onNotice(result === 'fits' ? 'Saved: the sample fits.' :
        `Saved. Choose a ${result === 'too-tight' ? 'looser' : 'tighter'} adjustment and generate a new sample.`);
    } catch (error) {
      onNotice(`${recorded ? 'Result saved in this project, but not in your calibration library. ' : ''}${error instanceof Error ? error.message : 'Could not save the result.'}`);
    } finally { setSaving(false); }
  }

  function apply(profile: CalibrationProfile) {
    if (!onChange) return;
    try {
      onChange(applyCalibration(project, profile));
      onNotice('Saved adjustment applied.');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Could not apply this adjustment.'); }
  }

  return <section className="export-first" aria-label="Connector calibration">
    <div className="export-first-head"><h3 className="export-section-label">CONNECTOR CALIBRATION</h3><span className={`export-first-state ${fitStatus === 'failed' ? 'needs-adjustment' : ''}`}>{fitStatus === 'passed' ? 'Fits' : fitStatus === 'failed' ? 'Adjust and retry' : coupon ? 'Ready to test' : 'Optional'}</span></div>
    <label className="export-calibration-field">Fit adjustment<select aria-label="Fit adjustment" value={adjustment} disabled={locked} onChange={event => adjust(Number(event.target.value))}>
      {[-0.15, -0.10, -0.05, 0, 0.05, 0.10, 0.15].map(value => <option key={value} value={value}>{adjustmentLabel(value)}{value === 0 ? ' · standard' : value > 0 ? ' · looser' : ' · tighter'}</option>)}
    </select></label>
    {counts.detailed > 0 && counts.fast > 0 && <div className="export-calibration-field">Test at
      <div className="export-sample-style" role="group" aria-label="Calibration sample layer height">{processes.map(([style, process]) =>
        <button key={style} type="button" aria-pressed={testStyle === style} disabled={locked} title={`${style === 'fast' ? 'Fast print' : 'Full detail'} · ${process}`}
          onClick={() => { if (onChange && testStyle !== style) onChange(changeProject(project, draft => { draft.printSettings.calibrationStyle = style; })); }}>
          {layerHeight(process) ?? process}</button>)}</div></div>}
    {staleAdjustment && <p className="export-gate">This adjustment was made for different printer settings.</p>}
    {coupon ? <>
      {filesExpired(coupon) ? <>
        <div className="export-coupon-file"><span><strong>Calibration sample</strong><small>{adjustmentLabel(adjustment)} · Files expired</small></span></div>
        <button className="export-coupon-button" disabled={locked || !serviceOnline(account) || !!limitNote} onClick={onPrepareAgain}>Prepare again</button>
        {limitNote && <p className="export-gate">{limitNote}</p>}
      </> : coupon.plates.map(plate => <div className="export-coupon-file" key={plate.plate}><span><strong>Calibration sample</strong><small>{adjustmentLabel(adjustment)}</small></span>{member && <>
        {plate.model && <a href={artifactUrl(coupon, plate.model)} download="calibration-sample.3mf" title="Plain 3MF: opens in any slicer; turn on supports for the connector ends"
          aria-label={`Download calibration sample plate ${plate.plate} as a 3MF for any slicer`}>3MF</a>}
        <a href={artifactUrl(coupon, plate.project)} download="calibration-sample-bambu-project.3mf" title={`Bambu Studio project for the ${coupon.printer.name}: supports painted only where needed`}
          aria-label={`Download calibration sample plate ${plate.plate} as a Bambu Studio project`}>Bambu project</a></>}</div>)}
      <p className="export-first-note">Remove supports, then test both ends.</p>
      <div className="export-first-divider" />
      <h4>How did it fit?</h4>
      <label className="export-fit-notes">Note (optional)<input value={notes} onChange={event => setNotes(event.target.value)} /></label>
      <label className="export-fit-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I printed and tested this myself</label>
      <div className="export-fit-results" role="group" aria-label="Sample fit result">{OUTCOMES.map(outcome => <button key={outcome.value} type="button" disabled={!confirmed || !member || locked} onClick={() => void report(outcome.value)}>{outcome.label}</button>)}</div>
    </> : <><button className="export-coupon-button" disabled={locked || !serviceOnline(account) || !!limitNote} onClick={onPrepare}>Generate calibration sample</button>
      {limitNote && <p className="export-gate">{limitNote}</p>}</>}
    {(saved.length > 0 || libraryError) && <><div className="export-first-divider" />
      <h4>Your saved results</h4>
      {libraryError ? <p className="export-gate">{libraryError}</p> :
        <ul className="export-calibration-library">{saved.map(({ profile, applicable }) => {
          const applied = project.connectorFit.calibrationId === profile.id && adjustment === profile.adjustmentMm;
          return <li key={profile.id}>
            <strong>{OUTCOMES.find(outcome => outcome.value === profile.result)?.label ?? profile.result} · {adjustmentLabel(profile.adjustmentMm)}</strong>
            <small>{new Date(profile.recordedAt).toLocaleDateString()}</small>
            {profile.notes && <p>{profile.notes}</p>}
            {applicable && <button type="button" disabled={locked || applied} onClick={() => apply(profile)}>{applied ? 'Applied' : 'Use this adjustment'}</button>}
          </li>;
        })}</ul>}
    </>}
  </section>;
}
