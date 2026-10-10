import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkshopProject } from '../domain/project';
import { pieceDefinition } from '../domain/pieces';
import { anthropicClient } from '../plan/anthropic';
import { track } from '../net/telemetry';
import { AssistError, assistBase, assistPlan, forgetKey, progressText, problemCount, storedKey, storeKey, watchKey, type AssistMode,
  type AssistResult } from '../plan/assist';
import { buildPlan, type BuiltPlan, type PlanReport } from '../plan/build';
import './plan-assist.css';

/**
 * Build's "Describe track": the user's words go from this browser to Anthropic on their own key (never through
 * Plateway's server), the plan is laid and checked here (repairing up to three rounds), and the result shows as a ghost
 * on the table until Accept commits it as one edit. Visitors and members alike.
 */
interface Shown { result: AssistResult; mode: AssistMode; project: WorkshopProject }

/** What a Describe-track session typically costs on the user's key, per the plan (U11). At Sonnet 5.5 prices the eval's
 * draft-and-repairs runs average about $0.11 (2026-10-08), so a session with a refinement or two lands near this. */
export const TYPICAL_COST = 'about $0.19';

export interface PlanAssist {
  open: boolean;
  toggle(): void;
  /** Opens the panel with `text` as the description and generates a fresh layout from it (Build's start screen); without
   * a key it waits for one. */
  describe(text: string): void;
  /** The plan built onto the project as it is now: the canvas ghost and what Accept commits. */
  preview: BuiltPlan | null;
  mode: AssistMode;
  panel: {
    description: string; setDescription(text: string): void;
    instruction: string; setInstruction(text: string): void;
    setMode(mode: AssistMode): void;
    /** The running loop's progress line; empty when idle. */
    progress: string; error: string;
    shown: Shown | null;
    run(text: string, refine: boolean): Promise<void>;
    cancel(): void; discard(): void; close(): void;
    /** The stored key's last four characters, and whether it is remembered on this device; null: no key yet. */
    key: { ending: string; remembered: boolean } | null;
    /** The key form shows: no key yet, or Change key. Nothing goes to Anthropic while it does. */
    asking: boolean;
    saveKey(key: string, remember: boolean): void;
    changeKey(): void; keepKey(): void; forgetKey(): void;
  };
}

export function usePlanAssist(project: WorkshopProject): PlanAssist {
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState(storedKey);
  const [changing, setChanging] = useState(false);
  const [mode, setMode] = useState<AssistMode>(project.routes.length ? 'add' : 'fresh');
  const [description, setDescription] = useState('');
  const [instruction, setInstruction] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const abort = useRef<AbortController | null>(null);
  // Sign-out, Forget key, a rejected key and other tabs all change the stored key.
  useEffect(() => watchKey(() => setStored(storedKey())), []);
  useEffect(() => () => abort.current?.abort(), []);
  // The ghost follows edits made while it shows: rebuilt onto the project as it is now.
  const preview = useMemo(() => !shown ? null : shown.project === project ? shown.result.built :
    buildPlan(shown.result.plan, assistBase(project, shown.mode)), [shown, project]);

  async function run(text: string, refine: boolean, fresh = false) {
    const key = storedKey()?.key;
    if (!key || !text.trim()) return;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setError('');
    track('describe_run');
    try {
      const runMode = fresh ? 'fresh' : refine && shown ? shown.mode : mode;
      const result = await assistPlan({ client: anthropicClient({ key }), project, mode: runMode, description: text.trim(),
        ...(refine && shown ? { previous: { plan: shown.result.plan, history: shown.result.history } } : {}),
        onProgress: item => setProgress(progressText(item)), signal: controller.signal });
      setShown({ result, mode: runMode, project });
      if (refine) setInstruction('');
    } catch (failure) {
      if (controller.signal.aborted) return;
      // A rejected key is forgotten, so the key form opens again.
      if (failure instanceof AssistError && failure.status === 401) forgetKey();
      setError(failure instanceof Error ? failure.message : 'The AI layout request failed.');
    } finally {
      if (abort.current === controller) { abort.current = null; setProgress(''); }
    }
  }
  const cancel = () => { abort.current?.abort(); abort.current = null; setProgress(''); };
  const discard = () => { cancel(); setShown(null); setError(''); };
  return {
    open, preview, mode: shown?.mode ?? mode,
    toggle: () => { if (open) cancel(); setOpen(!open); },
    describe: text => { setShown(null); setDescription(text); setMode('fresh'); setOpen(true); void run(text, false, true); },
    panel: { description, setDescription, instruction, setInstruction, setMode, progress, error, shown, run, cancel, discard,
      close: () => { cancel(); setOpen(false); },
      key: stored && { ending: stored.key.slice(-4), remembered: stored.remembered },
      asking: !stored || changing,
      saveKey: (key, remember) => {
        try {
          storeKey(key.trim(), remember);
          setChanging(false);
          setError('');
        } catch { setError('This browser blocks site storage, so it cannot keep the key.'); }
      },
      changeKey: () => setChanging(true),
      keepKey: () => setChanging(false),
      forgetKey: () => { cancel(); setChanging(false); forgetKey(); } }
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One line each: owned used against stock, prints by style, fallbacks. */
function billLine(report: PlanReport): string {
  const { bill } = report;
  const owned = bill.owned.filter(item => item.used || item.stock).map(item => `${item.used}/${item.stock} ${pieceDefinition(item.family).label}`);
  const printed = bill.detailed + bill.fast;
  return [owned.length ? `Owned: ${owned.join(', ')}` : 'No owned pieces',
    printed ? `to print: ${plural(printed, 'piece')}${bill.fast ? ` (${bill.fast} fast)` : ''}` : 'nothing to print',
    ...(bill.fallbacks.length ? [`${bill.fallbacks.reduce((sum, item) => sum + item.count, 0)} printed because owned ran out`] : [])].join(' · ');
}

function Report({ result, report }: { result: AssistResult; report: PlanReport }) {
  const problems = [...report.errors.map(error => `${error.path}: ${error.message}`),
    ...report.fit.issues.filter(issue => issue.severity === 'error').map(issue => `${issue.steps[0] ?? 'Fit'}: ${issue.message}`)];
  const ends = report.fit.openEnds.length;
  return <div className="plan-assist-report">
    <p className={report.ok ? 'plan-assist-ok' : 'plan-assist-bad'} role="status">
      {report.ok ? '✓ Builds cleanly' : `! ${plural(problemCount(report), 'problem')} left`}
      <small> · {result.repairs ? `after ${plural(result.repairs, 'repair round')}` : 'first draft'}{result.usage.calls ? ` · ${(result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite).toLocaleString('en')} tokens` : ''}</small></p>
    {result.stopped && <p className="plan-assist-bad">Repairing stopped: {result.stopped}</p>}
    {problems.length > 0 && <ul className="plan-assist-problems">{problems.slice(0, 6).map(problem => <li key={problem}>{problem}</li>)}
      {problems.length > 6 && <li>…and {problems.length - 6} more</li>}</ul>}
    <p>{ends ? `${plural(ends, 'open end')}${report.fit.openEnds.some(end => end.label) ? `: ${report.fit.openEnds.map(end => end.label).filter(Boolean).slice(0, 4).join(', ')}` : ''}` : 'No open ends'}</p>
    {report.trains.length > 0 && <ul className="plan-assist-trains">{report.trains.map(train => <li key={train.track} className={train.ok ? '' : 'is-bad'}>
      <strong>{train.track}</strong> {train.ok ? `${train.closed ? 'runs round a loop' : 'runs end to end'} · ${(train.length / 1000).toFixed(2)} m` : `cannot run: ${train.problem}`}
      {train.switches.length > 0 && <small> · {train.switches.map(item => `${item.piece} ${item.state}`).join(', ')}</small>}</li>)}</ul>}
    <p>{billLine(report)}</p>
  </div>;
}

/** Asks for the user's Anthropic key: kept for this browser session unless they tick Remember on this device. */
function KeyForm({ panel }: { panel: PlanAssist['panel'] }) {
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(panel.key?.remembered ?? false);
  return <form className="plan-assist-key-form" aria-label="Your Anthropic key" onSubmit={event => { event.preventDefault(); if (key.trim()) panel.saveKey(key, remember); }}>
    <p>Describe track runs on your own Anthropic API key. This browser sends it straight to Anthropic, never to Plateway. <a
      href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Get a key</a></p>
    <input type="password" aria-label="Anthropic API key" placeholder="sk-ant-…" autoComplete="off" spellCheck={false} value={key}
      onChange={event => setKey(event.target.value)}/>
    <label className="plan-assist-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)}/> Remember on this device</label>
    <div className="plan-assist-actions">
      <button type="submit" className="plan-assist-primary" disabled={!key.trim()}>Use key</button>
      {panel.key && <button type="button" onClick={panel.keepKey}>Cancel</button>}
    </div>
  </form>;
}

export function PlanAssistPanel({ assist, hasTrack, onAccept }: { assist: PlanAssist; hasTrack: boolean; onAccept: (project: WorkshopProject) => void }) {
  if (!assist.open) return null;
  const { panel, preview } = assist;
  const busy = Boolean(panel.progress), enabled = !panel.asking;
  const shown = panel.shown;
  return <section className="plan-assist" aria-label="Describe track">
    <div className="plan-assist-heading"><strong>DESCRIBE TRACK</strong><button type="button" aria-label="Close" onClick={panel.close}>×</button></div>
    {panel.asking ? <KeyForm panel={panel}/> : panel.key && <div className="plan-assist-key">
      <span>Using your key ending …{panel.key.ending}</span>
      <button type="button" disabled={busy} onClick={panel.changeKey}>Change key</button>
      <button type="button" onClick={panel.forgetKey}>Forget key</button>
    </div>}
    {!shown && <>
      <textarea aria-label="Describe the track you want" rows={4} value={panel.description} disabled={busy}
        placeholder="An oval with a passing loop and a siding that ends inside a KALLAX cubby" onChange={event => panel.setDescription(event.target.value)}/>
      <div className="plan-assist-mode" role="radiogroup" aria-label="Where it goes">
        <label><input type="radio" name="plan-assist-mode" checked={assist.mode === 'fresh'} disabled={busy} onChange={() => panel.setMode('fresh')}/> Start fresh</label>
        <label><input type="radio" name="plan-assist-mode" checked={assist.mode === 'add'} disabled={busy || !hasTrack} onChange={() => panel.setMode('add')}/> Add to my layout</label>
      </div>
      <div className="plan-assist-actions">
        {busy ? <button type="button" onClick={panel.cancel}>Cancel</button> :
          <button type="button" className="plan-assist-primary" disabled={!enabled || !panel.description.trim()} onClick={() => void panel.run(panel.description, false)}>Generate</button>}
      </div>
      <p className="plan-assist-cost">A layout typically costs {TYPICAL_COST} of Anthropic usage, billed to your key.</p>
    </>}
    {busy && <p className="plan-assist-progress" role="status"><i aria-hidden="true"/>{panel.progress}</p>}
    {panel.error && <p className="plan-assist-error" role="alert">{panel.error}</p>}
    {shown && preview && <>
      {shown.result.notes && <p className="plan-assist-notes">{shown.result.notes}</p>}
      <Report result={shown.result} report={preview.report}/>
      <div className="plan-assist-actions">
        <button type="button" className="plan-assist-primary" disabled={busy} onClick={() => { onAccept(preview.project); panel.discard(); }}>{preview.report.ok ? 'Accept' : 'Accept anyway'}</button>
        <button type="button" disabled={busy} onClick={panel.discard}>Discard</button>
      </div>
      <div className="plan-assist-refine">
        <input aria-label="Change the plan" value={panel.instruction} disabled={!enabled || busy} placeholder="Make the loop bigger"
          onChange={event => panel.setInstruction(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void panel.run(panel.instruction, true); }}/>
        {busy ? <button type="button" onClick={panel.cancel}>Cancel</button> :
          <button type="button" disabled={!enabled || !panel.instruction.trim()} onClick={() => void panel.run(panel.instruction, true)}>Refine</button>}
      </div>
      <details className="plan-assist-json"><summary>View plan JSON</summary><pre>{JSON.stringify(shown.result.plan, null, 2)}</pre></details>
    </>}
  </section>;
}
