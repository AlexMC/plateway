import { useEffect, useMemo, useRef, useState } from 'react';
import { serviceOnline, type Account } from '../account/account';
import { missingPrintMeasurements, unavailablePieces, type MeasurementKey, type WorkshopProject } from '../domain/project';
import { findPieceDefinition } from '../domain/pieces';
import { CURVE_CROSSING_FAMILY, DIAMOND_FAMILY } from '../domain/pieces/families/diamond';
import { GAUNTLET_FAMILY } from '../domain/pieces/families/gauntlet';
import { effectivePrint, fastProcess, layerHeight } from '../domain/printer';
import type { CheckKind } from '../domain/trials';
import { CommunityMark } from '../editor/community-mark';
import { MEASUREMENT_LABELS } from '../editor/setup-defaults';
import type { FitResult } from '../fitting/fit';
import { ApiError, apiJson, apiUrl } from '../net/api';
import { track } from '../net/telemetry';
import { couponTrial, gradeTrial } from './actions';
import { CalibrationPanel } from './calibration';
import { DesignPanel, type PrintPresets } from './design';
import { PhysicalChecks } from './evidence-view';
import { freezeManifest } from './manifest';
import { ShoppingList } from './shopping-list';
import { artifactUrl, familyName, filesExpired, matchingCoupon, matchingGrade, partName, type ArtifactReceipt } from './receipt';
import { KIND_LABELS, SYSTEM_FAILURE, TOO_LARGE, cancelJob, fetchJobStatus, isActive, jobHeadline, jobStage, prepareAgain, resetText,
  sizeRefusal, startJob, watchJob, type DailyLimit, type JobKind, type JobStatus, type PrepareJob, type SizeRefusal } from './jobs';
import './panel.css';

/** Fixed junctions: keyed bases only, no selector screws. */
const SCREWLESS = new Set(['printed_crossing90', DIAMOND_FAMILY, CURVE_CROSSING_FAMILY, GAUNTLET_FAMILY]);

type ListedPackage = Pick<ArtifactReceipt, 'id' | 'layoutRevision'> & { calibrationSample: boolean };
/** How this panel's last prepare ended, when it did not end with files: the message and whether to offer it again. */
type Outcome = { kind: JobKind; message: string; retry: boolean };
/** Where the account holds a saved project: the id and revision the service minted. */
export type SavedRevision = { id: string; revision: string };
const LEAVE_NOTE = 'You can leave this page: preparing carries on, and your files appear here when they’re ready.';

/** A layout package is current only for this exact layout and while its CAD sources are unchanged. */
export function currentLayoutPackages(project: WorkshopProject, receipts: readonly ArtifactReceipt[]): ArtifactReceipt[] {
  return receipts.filter(item => !!item.manifest && item.layoutRevision === project.layoutRevision && item.cadSourceCurrent !== false);
}

export function ExportPanel({ project, fit, account, onNeedAccount, saveRevision, onReceipt, onChange, onEditMeasurement, onEditTrack, onTestDrive, driven = false,
  onOpenProject, receipts: suppliedReceipts = [] }: {
  project: WorkshopProject; fit: FitResult; account: Account;
  /** Preparing needs an account: a visitor's click opens sign-up with this reason. */
  onNeedAccount: (reason: string) => void;
  /** Saves the project if needed; where it is saved, or null when it is not (the save said why). */
  saveRevision: () => Promise<SavedRevision | null>; onReceipt: (receipt: ArtifactReceipt) => void;
  onChange?: (next: WorkshopProject) => void; receipts?: readonly ArtifactReceipt[];
  onEditMeasurement: (field: MeasurementKey) => void; onEditTrack?: () => void;
  /** `driven`: this layout ran in Test drive; otherwise the summary recommends `onTestDrive` first. */
  onTestDrive?: () => void; driven?: boolean;
  /** Opens the member's saved project `id` (the one another prepare is running for). */
  onOpenProject?: (id: string) => void;
}) {
  const [loadedReceipts, setLoadedReceipts] = useState<ArtifactReceipt[]>([]);
  const [routeId, setRouteId] = useState('');
  /** The member's active prepare, whichever project or kind (one at a time), polled until it ends. */
  const [job, setJob] = useState<PrepareJob | null>(null);
  /** A prepare request on its way to the queue (saving the project first, for a layout). */
  const [starting, setStarting] = useState<JobKind | null>(null);
  const [limits, setLimits] = useState<JobStatus['limits'] | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** A layout no prepare can hold (AE2), for the layout revision the service refused. */
  const [refusal, setRefusal] = useState<SizeRefusal & { layoutRevision: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presets, setPresets] = useState<PrintPresets>({});
  const online = serviceOnline(account);
  const memberId = account.status === 'member' ? account.member.id : '';
  const receipts = useMemo(() => {
    const byId = new Map(loadedReceipts.map(item => [item.id, item]));
    for (const item of suppliedReceipts) byId.set(item.id, item);
    return [...byId.values()];
  }, [suppliedReceipts, loadedReceipts]);
  const current = currentLayoutPackages(project, receipts).at(-1);
  const expired = !!current && filesExpired(current);
  const currentParts = useMemo(() => new Map(current?.parts.map(part => [part.instanceId, part]) ?? []), [current]);
  const coupon = receipts.filter(item => matchingCoupon(project, item)).at(-1);
  const gradeRig = receipts.some(item => matchingGrade(project, fit, item) !== null);
  const rampRoutes = project.routes.filter(route => fit.sections.some(section => section.routeId === route.id && section.kind === 'transition'));
  const gradeRoute = rampRoutes.some(route => route.id === routeId) ? routeId : rampRoutes[0]?.id ?? '';
  // An unavailable piece (KTD9) has no part yet still needs printing: it keeps Prepare in view, disabled with the reload message.
  const printedCount = fit.partInstances.filter(part => part.source === 'printed').length + unavailablePieces(project).length;
  const earlier = receipts.filter(item => item.manifest && item.id.startsWith(`${project.id}-`));
  const prepareTitle = earlier.some(item => item.layoutRevision === project.layoutRevision) ? 'Track parts were updated — prepare again' :
    earlier.length ? 'Layout changed — prepare again' : `Ready to prepare ${printedCount} printed ${printedCount === 1 ? 'part' : 'parts'}`;
  const needsScrews = fit.partInstances.some(part => part.source === 'printed' && part.interfaceKind === 'track-assembly' && !SCREWLESS.has(part.family));
  const shortfalls = fit.issues.filter(issue => issue.code === 'owned-piece-unavailable');
  const checks: CheckKind[] = current ? [...(rampRoutes.length ? ['grade' as const] : []),
    ...(project.crossings.length ? ['under-run' as const, 'over-run' as const] : [])] : gradeRig ? ['grade'] : [];
  const missing = missingPrintMeasurements(project);
  const print = effectivePrint(project);
  const printerPresets = presets[project.printer];
  // The slicer's own choice when it answers; the same bundled rule otherwise.
  const fastPrint = printerPresets?.byNozzle?.[String(print.nozzleMm)]?.fastProcess ??
    (print.nozzleMm === 0.4 ? printerPresets?.fastProcess : undefined) ?? fastProcess(project);
  const printedParts = fit.partInstances.filter(part => part.source === 'printed');
  const fastUsed = printedParts.some(part => part.parameters.lite === 1);
  const detailedUsed = printedParts.some(part => part.parameters.lite !== 1);
  const fastSelectors = printedParts.some(part => part.parameters.lite === 1 && part.interfaceKind === 'track-assembly' && findPieceDefinition(part.family)?.states !== undefined);
  const frozen = useMemo(() => {
    try { return { manifest: freezeManifest(project, fit), error: '' }; }
    catch (error) { return { manifest: null, error: error instanceof Error ? error.message : 'This layout cannot be prepared yet.' }; }
  }, [project, fit]);
  /** A layout prepare for another project holds the queue for this member: this one waits until it is opened or cancelled. */
  const elsewhere = job && isActive(job) && job.kind === 'layout' && job.projectId !== project.id ? job : null;
  const running = job && isActive(job) && !elsewhere ? job : null;
  const busy = !!starting || !!job && isActive(job);
  const refused = refusal?.layoutRevision === project.layoutRevision ? refusal : null;

  async function reload() {
    const listed = await apiJson<ListedPackage[]>('packages', { fallback: 'Could not load your files.' });
    const loaded = await Promise.all(listed.filter(item => item.calibrationSample || item.id.startsWith(`${project.id}-`) ||
      item.layoutRevision === project.layoutRevision).map(item =>
      apiJson<ArtifactReceipt>(`packages/${encodeURIComponent(item.id)}`, { fallback: 'Could not load your files.' })));
    setLoadedReceipts(loaded);
    for (const item of loaded) onReceipt(item);
  }

  /** The active prepare (resumed on load, R9) and the daily limits left. */
  async function checkJobs(resume: boolean) {
    const status = await fetchJobStatus();
    setLimits(status.limits);
    if (resume) setJob(status.active);
  }

  // Discovery once per signed-in member; preparing or Reload refreshes afterwards.
  useEffect(() => {
    if (!memberId) return;
    void reload().catch(error => setNotice(error instanceof Error ? error.message : 'Could not load your files.'));
    void checkJobs(true).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  useEffect(() => {
    let active = true;
    void apiJson<PrintPresets>('print-presets').then(value => { if (active) setPresets(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  /** A prepare ended: its files join the panel (this project's, or a member-wide sample or rig), or it says why not. */
  async function ended(done: PrepareJob) {
    setJob(null);
    void checkJobs(false).catch(() => undefined);
    if (done.kind === 'layout' && done.projectId !== project.id) return;
    if (done.state === 'cancelled') return;
    if (done.state === 'failed_system') { setOutcome({ kind: done.kind, message: SYSTEM_FAILURE, retry: true }); return; }
    if (done.state === 'failed_too_large') { setOutcome({ kind: done.kind, message: done.error ?? TOO_LARGE, retry: false }); return; }
    if (!done.packageId) { setOutcome({ kind: done.kind, message: done.error ?? 'Preparing failed.', retry: false }); return; }
    try {
      const receipt = await apiJson<ArtifactReceipt>(`packages/${encodeURIComponent(done.packageId)}`, { fallback: 'Could not load the prepared files.' });
      setLoadedReceipts(previous => [...previous.filter(item => item.id !== receipt.id), receipt]);
      onReceipt(receipt);
      if (done.kind === 'grade') setNotice('Grade rig ready. Download it under Advanced → All files.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not load the prepared files.'); }
  }
  const endedRef = useRef(ended);
  endedRef.current = ended;

  const watchedId = job && isActive(job) ? job.id : null;
  useEffect(() => {
    if (!job || !watchedId) return;
    return watchJob(job, next => { if (isActive(next)) setJob(next); else void endedRef.current(next); },
      message => { setJob(null); setNotice(message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedId]);

  /** Queues a prepare (`request`), or follows the member's active one the service answers with instead. */
  async function queue(kind: JobKind, request: () => Promise<PrepareJob>) {
    if (busy) return;
    if (account.status !== 'member') {
      onNeedAccount(`Create an account to ${kind === 'layout' ? 'prepare print plates' : kind === 'coupon' ? 'generate a calibration sample' : 'prepare a grade rig'}. Your work stays in this browser meanwhile.`);
      return;
    }
    setStarting(kind); setNotice(''); setOutcome(null);
    try {
      const queued = await request();
      if (isActive(queued)) setJob(queued); else await ended(queued);
      void checkJobs(false).catch(() => undefined);
    } catch (error) {
      const tooLarge = sizeRefusal(error);
      if (tooLarge) setRefusal({ ...tooLarge, layoutRevision: project.layoutRevision });
      else setNotice(error instanceof Error ? error.message : 'Preparing failed.');
      if (error instanceof ApiError && error.status === 429) void checkJobs(false).catch(() => undefined);
    } finally { setStarting(null); }
  }

  function prepare(kind: JobKind) {
    if (kind === 'layout') track('prepare_request');
    return queue(kind, async () => {
      if (kind !== 'layout') return startJob({ kind, ...(kind === 'coupon' ? couponTrial(project) : gradeTrial(project, fit, gradeRoute)) });
      if (!frozen.manifest) throw new Error(frozen.error);
      const saved = await saveRevision();
      if (!saved) throw new Error('Save the project before preparing plates.');
      // The service links a prepare to a project only by a revision it saved, so the manifest names that save (a first
      // save also gives the project its account id).
      return startJob({ kind, manifest: { ...frozen.manifest, project: { ...frozen.manifest.project, id: saved.id, revision: saved.revision } } });
    });
  }

  /** Prepares an expired package again from the request that made it (R12). */
  function again(receipt: ArtifactReceipt) {
    if (receipt.manifest) track('prepare_request');
    return queue(receipt.manifest ? 'layout' : isCoupon(receipt) ? 'coupon' : 'grade', () => prepareAgain(receipt.id));
  }

  async function cancel() {
    if (!job) return;
    try {
      const next = await cancelJob(job.id);
      if (isActive(next)) setJob(next); else await ended(next);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not cancel the prepare.'); }
  }

  /** A daily limit reached (R13): what to show instead of a Prepare button's way forward. */
  const limitReached = (limit: DailyLimit | undefined, noun: string) => limit && limit.remaining === 0 ?
    `Daily limit reached: ${limit.limit} ${noun} in 24 hours. You can prepare again ${resetText(limit.resetsAt)}.` : '';
  const layoutLimit = limitReached(limits?.layout, 'layout prepares');
  const sampleLimit = limitReached(limits?.sample, 'calibration samples and grade rigs');
  /** The prepares left under a daily limit, beside its Prepare button. */
  const limitLeft = (limit: DailyLimit | undefined, noun: string) => limit &&
    <small className="export-limit">{limit.remaining} of {limit.limit} {noun} left today</small>;
  /** A layout prepare for this project is on its way: its progress stands where the Prepare button was. */
  const layoutRunning = running?.kind === 'layout' || starting === 'layout';

  const plateCount = current?.plates.length ?? 0;
  // Prepared before plain 3MFs and part codes existed.
  const outdated = !!current && (!current.plates.every(plate => plate.model) || !current.parts.every(part => part.code));
  const partCount = current?.parts.length ?? 0;
  const ownedCount = fit.partInstances.filter(part => part.source === 'owned').length;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  /** A part's Community mark where parts are listed (parts list, plates, files); nothing for a built-in part. */
  const communityMark = (family: string) => {
    const community = findPieceDefinition(family)?.community;
    return community && <> <CommunityMark community={community}/></>;
  };
  const link = (receipt: ArtifactReceipt, path: string, label: string, name?: string, title?: string) =>
    <a key={path} href={artifactUrl(receipt, path)} download={name ?? true} title={title}>{label}</a>;
  /** The printable guide: the package's own PDF, or one the service draws for packages prepared before it existed. */
  const guidePdf = (receipt: ArtifactReceipt) => <a key="guide-pdf" href={apiUrl(`packages/${encodeURIComponent(receipt.id)}/assembly-guide.pdf`)}
    download="assembly-guide.pdf" title="Printable guide: layout overview, shopping list, plates and illustrated assembly steps">Assembly guide (PDF)</a>;
  /** Per-plate files: the plain 3MF for any slicer, then the Bambu project and its G-code. */
  const plateLinks = (receipt: ArtifactReceipt, plate: ArtifactReceipt['plates'][number]) => {
    const stem = `plate-${String(plate.plate).padStart(2, '0')}`;
    return [plate.model && link(receipt, plate.model, '3MF', `${stem}.3mf`, 'Plain 3MF: opens in any slicer'),
      link(receipt, plate.project, 'Bambu project', `${stem}-bambu-project.3mf`, `Bambu Studio project for the ${receipt.printer.name}: supports painted only where needed`),
      link(receipt, plate.gcode, 'G-code', `${stem}.gcode`, `G-code for the ${receipt.printer.name}`)].filter(Boolean);
  };
  const isCoupon = (item: ArtifactReceipt) => item.parts.some(part => part.family === 'brick_end_coupon' || part.family === 'connector_coupon');
  const isOlder = (item: ArtifactReceipt) => item.manifest ? item !== current : isCoupon(item) ? item !== coupon : item.cadSourceCurrent === false;
  const fileCard = (item: ArtifactReceipt) => <article key={item.id} className="export-receipt">
    <strong>{item.manifest ? 'Layout plates' : isCoupon(item) ? 'Calibration sample' : 'Grade rig'}</strong>
    <small>{item.parts.length} {item.parts.length === 1 ? 'part' : 'parts'} · {item.plates.length} {item.plates.length === 1 ? 'plate' : 'plates'}{filesExpired(item) && ' · Files expired'}</small>
    {!filesExpired(item) && <div className="export-links">
      {item.plates.map(plate => <span key={plate.plate}>Plate {plate.plate}: {plateLinks(item, plate).flatMap((anchor, index) => index ? [' · ', anchor] : [anchor])}</span>)}
      {guidePdf(item)}
      {link(item, item.assemblyGuide, 'Assembly guide (Markdown)')}
      {item.manifest && link(item, item.manifest, 'Layout data (JSON)')}
      {item.parts.map(part => <span key={part.instanceId}>{part.code && <b>{part.code} </b>}{partName(part, item.parts)}{communityMark(part.family)}: {link(item, part.mesh, 'STL')}
        {part.printMesh && <> · {link(item, part.printMesh, 'Plate STL')}</>}
        {part.step && <> · {link(item, part.step, 'STEP')}</>}
        {' · '}{link(item, part.source, part.library ? 'Library entry' : 'CAD source')}</span>)}
    </div>}
  </article>;
  const currentFiles = receipts.filter(item => !isOlder(item)), olderFiles = receipts.filter(isOlder);
  return <section className={`export-panel ${online ? '' : 'offline'}`} aria-label="Print preparation">
    <div className="export-main">
      <section className="export-ready" aria-labelledby="export-ready-title">
        <div className="export-ready-head"><h2 id="export-ready-title">Ready to print?</h2>
          <p>Nothing is sent to the printer — you open the plates in your slicer and print them yourself.</p></div>
        <dl className="export-ready-facts">
          <div><dt>Printer</dt><dd>{print.name} · {print.nozzleMm} mm nozzle · {print.material}</dd></div>
          <div><dt>Style</dt><dd>{fastUsed ? detailedUsed ? 'Detailed and fast print' : 'Fast print' : 'Detailed'}</dd></div>
          <div><dt>To print</dt><dd>{plural(printedCount, 'printed piece')}{ownedCount > 0 && ` · ${plural(ownedCount, 'piece')} you own`}</dd></div>
          <div><dt>Plates</dt><dd>{current ? expired ? 'Files expired' : `${plateCount} prepared · ${plural(partCount, 'part')}` : printedCount ? 'Not prepared yet' : 'None needed'}</dd></div>
        </dl>
        {(onEditTrack || (onTestDrive && !driven)) && <div className="export-ready-actions">
          {onTestDrive && !driven && <><span>Not test-driven yet — recommended before you print.</span>
            <button type="button" onClick={onTestDrive}>Test drive first</button></>}
          {onEditTrack && <button type="button" onClick={onEditTrack}>Edit track</button>}
        </div>}
      </section>
      {current && !expired && <div className="export-heading"><div><h2>{plural(partCount, 'part')} on {plural(plateCount, 'plate')}</h2>
        {current.layoutParts && current.layoutParts.length > 1 && <p>Prepared in {current.layoutParts.length} parts and combined into one set: plate numbers run on across the parts.</p>}</div>
        <div className="export-formats" aria-label="Downloads">
          <a href={apiUrl(`packages/${encodeURIComponent(current.id)}/plates.zip`)} download>Download all (ZIP)</a>
          <a href={apiUrl(`packages/${encodeURIComponent(current.id)}/stls.zip`)} download>STL files (ZIP)</a>
          {guidePdf(current)}
          {link(current, current.assemblyGuide, 'Assembly guide (Markdown)')}
        </div></div>}
      {outdated && !expired && <p className="export-outdated" role="status">Prepared with an older version: prepare again for plain 3MF plates and part codes.
        <button type="button" disabled={busy || !online || !frozen.manifest || !!layoutLimit} onClick={() => void prepare('layout')}>Prepare again</button></p>}
      {current && !expired && <dl className="export-kinds">
        <div><dt>Plates (3MF)</dt><dd>{current.plates.every(plate => plate.model) ? <>Open in any slicer: OrcaSlicer, PrusaSlicer, Cura or Bambu Studio.
          Other slicers: turn on supports for the connector ends (see guide).</> : 'Not in this package: prepare again (above) for plain 3MFs.'}</dd></div>
        <div><dt>STL files (ZIP)</dt><dd>Each printed part on its own, print-oriented.</dd></div>
        <div><dt>Bambu Studio project + G-code · {current.printer.name}</dt><dd>For Bambu printers: supports painted only where needed.
          In Download all, they’re in their own folder.</dd></div>
      </dl>}
      {(running || starting) && <div className="export-progress" role="status" aria-live="polite"><span className="export-spinner" aria-hidden="true" />
        <div className="export-progress-text"><strong>{running ? jobHeadline(running) : `${KIND_LABELS[starting!]}…`}</strong>
          <small>{running ? `${jobStage(running)}${running.state === 'running' ? ` · ${Math.round((running.progress ?? 0) * 100)}%` : ''}` : 'Sending it to the queue.'}</small>
          {running?.state === 'running' && <progress value={running.progress ?? 0} max={1} aria-label="Progress" />}
          <small>{LEAVE_NOTE}</small></div>
        {running && <button type="button" disabled={running.cancelling} onClick={() => void cancel()}>Cancel</button>}</div>}
      {elsewhere && <p className="export-outdated export-lock" role="status">Preparing {elsewhere.projectName ?? 'another layout'} — open it or cancel it first.
        {onOpenProject && elsewhere.projectId && <button type="button" onClick={() => onOpenProject(elsewhere.projectId!)}>Open {elsewhere.projectName ?? 'it'}</button>}
        <button type="button" disabled={elsewhere.cancelling} onClick={() => void cancel()}>{elsewhere.cancelling ? 'Cancelling…' : 'Cancel it'}</button></p>}
      {outcome && !busy && <p className="export-outdated export-outcome" role="status">{outcome.message}
        {outcome.retry && <button type="button" disabled={!online} onClick={() => void prepare(outcome.kind)}>Prepare again</button>}</p>}
      {!running && notice && <p className="export-notice" role="status">{notice}</p>}
      {current && expired ? !layoutRunning && <div id="plate-files" className="export-layout-action">
        <div><h3>Files expired</h3><p>Prepared files are kept for 7 days. Prepare them again to download these plates.</p></div>
        <div className="export-layout-go"><button disabled={busy || !online || !!layoutLimit} onClick={() => void again(current)}>Prepare again</button>
          {layoutLimit ? <p className="export-gate">{layoutLimit}</p> : limitLeft(limits?.layout, 'layout prepares')}</div>
      </div> : current ? <>
        <div id="plate-files" className="export-plates">{current.plates.map(plate => {
          const counts = new Map<string, number>();
          for (const object of plate.objects) {
            const part = currentParts.get(object.instanceId);
            const name = part ? partName(part, current.parts) : object.label;
            counts.set(name, (counts.get(name) ?? 0) + 1);
          }
          // Each part by its code, as the guide and the slicer's object list name it (older packages have no codes).
          const coded = plate.objects.map(object => currentParts.get(object.instanceId))
            .filter((part): part is ArtifactReceipt['parts'][number] & { code: string } => !!part?.code);
          return <article className="export-plate" key={plate.plate}>
            <div className="export-plate-title"><h3>Plate {plate.plate} · {plate.objects.length} {plate.objects.length === 1 ? 'part' : 'parts'}
              {plate.process && <small> · {layerHeight(plate.process) ? `${layerHeight(plate.process)} layers` : plate.process}</small>}
              {plate.filamentColour && <small> · {plate.filamentColour} filament{plate.filament ? ` (${plate.filament})` : ''}</small>}
              {plate.filaments && <small> · AMS {plate.filaments.map((name, slot) => `${slot + 1}: ${name.split(' @BBL ')[0]}`).join(', ')}</small>}</h3>
              <div className="export-plate-links">{plateLinks(current, plate)}</div></div>
            {plate.thumbnail && <img className="export-plate-thumb" src={artifactUrl(current, plate.thumbnail)} loading="lazy"
              alt={`Plate ${plate.plate}: ${[...counts.keys()].join(', ')}`} />}
            {coded.length === plate.objects.length ?
              <ul className="export-plate-parts" aria-label={`Parts on plate ${plate.plate}`}>{coded.map(part =>
                <li key={part.instanceId}><b>{part.code}</b> {partName(part, current.parts)}{communityMark(part.family)}</li>)}</ul> :
              !plate.thumbnail && <ul className="export-plate-parts">{[...counts].map(([name, count]) => <li key={name}>{name}{count > 1 && <span> × {count}</span>}</li>)}</ul>}
          </article>;
        })}</div>
        {needsScrews && <p className="export-note">Turnouts, flex track and crossovers need M3 screws — see the assembly guide.</p>}
        {current.notes?.map(note => <p className="export-note" key={note}>{note}</p>)}
      </> : printedCount === 0 ? <div id="plate-files" className="export-empty"><strong>No printed pieces in this layout</strong>
        {onEditTrack && <button type="button" onClick={onEditTrack}>Edit track</button>}</div> : <>
        {!layoutRunning && <div id="plate-files" className={`export-layout-action${refused ? ' export-layout-refused' : ''}`}>
          <h3>{refused ? 'Too large to prepare' : prepareTitle}</h3>
          {refused ? <div className="export-refusal" role="status"><p>{refused.message}</p>
            <dl><div><dt>One prepare can use</dt><dd>{(refused.limitMb / 1000).toFixed(1)} GB</dd></div>
              <div><dt>This piece needs</dt><dd>about {(refused.group.memoryMb / 1000).toFixed(1)} GB · {plural(refused.group.printedParts, 'printed part')} · {plural(refused.group.cadBuilds, 'different shape')}</dd></div></dl>
          </div> : <div className="export-layout-go">
            <button id="prepare-plates" disabled={busy || !online || !frozen.manifest || !!layoutLimit} onClick={() => void prepare('layout')}>Prepare plates</button>
            {layoutLimit ? <p className="export-gate">{layoutLimit}</p> : limitLeft(limits?.layout, 'layout prepares')}</div>}</div>}
        {!frozen.manifest && (missing.length > 0 ?
          <section className="export-gate export-measurement-gate" aria-label="Missing rail measurements">
            <h3>Measure your rail in Setup</h3>
            <ul>{missing.map(field => <li key={field}>
              <button type="button" onClick={() => onEditMeasurement(field)}>{MEASUREMENT_LABELS[field]} →</button>
            </li>)}</ul>
          </section> :
          <p className="export-gate" role="status">{frozen.error}</p>)}
      </>}
      {shortfalls.length > 0 && <p className="export-gate" role="status">{shortfalls.map(issue => issue.message).join(' ')} You can still print the other parts.</p>}
      {!online ? <p className="export-gate" role="status">The service is offline: preparing and downloading plates need it.</p> :
        account.status === 'visitor' && <p className="export-gate" role="status">Preparing plates needs an account. Your design stays in this browser.</p>}
      {project.routes.some(route => route.pieces.length > 0) && <ShoppingList project={project} fit={fit} account={account} />}
    </div>
    <aside className="export-side" aria-label="Printer, calibration and checks">
      <div className="export-printer">
        <span className="export-section-label">YOUR PRINTER</span>
        <h3>{print.name} · {print.material}</h3>
        {fastUsed ? <><p>{print.nozzleMm} mm nozzle</p>
          {detailedUsed && <p>Detailed: {print.profile}</p>}
          <p>Fast: {fastPrint}</p></> : <p>{print.nozzleMm} mm nozzle · {print.profile}</p>}
        {fastSelectors && <p>Turnout moving parts: {print.profile}</p>}
        <p>Track: {project.trackSystem === 'brick-v1' ? 'Standard brick track' : 'Custom joiner (legacy)'}</p>
        <a className="export-settings-link" href="#export-settings" onClick={() => setSettingsOpen(true)}>Edit printer &amp; process</a>
      </div>
      <CalibrationPanel project={project} coupon={coupon} receipts={receipts} account={account} busy={busy} limitNote={sampleLimit}
        onChange={onChange} onPrepare={() => void prepare('coupon')} onPrepareAgain={() => coupon && void again(coupon)} onNotice={setNotice} />
      {checks.length > 0 && <PhysicalChecks project={project} kinds={checks} onChange={onChange} />}
      <details id="export-settings" className="export-advanced" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}><summary>Advanced · printer, parts list &amp; files</summary><div className="export-advanced-body">
        {onChange && <DesignPanel project={project} presets={presets} hasSupports={fit.supports.length > 0} onChange={onChange} />}
        {rampRoutes.length > 0 && <div className="export-grade"><h3>Grade rig</h3><p>Print just the ramp to test your train's climb first.</p>
          {rampRoutes.length > 1 && <label>Route<select value={gradeRoute} onChange={event => setRouteId(event.target.value)}>{rampRoutes.map(route => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label>}
          <button disabled={busy || !online || !gradeRoute || !!sampleLimit} onClick={() => void prepare('grade')}>Prepare grade rig</button>
          {sampleLimit && <p className="export-gate">{sampleLimit}</p>}</div>}
        {frozen.manifest && <div className="export-inventory"><h3>Parts list</h3>
          <ul>{frozen.manifest.billOfMaterials.map(item => {
            // A community piece is listed by its library name, with its mark.
            const definition = findPieceDefinition(item.family);
            return <li key={`${item.source}:${item.family}`}>{item.count} × {definition?.community ? definition.label : familyName(item.family)}
              {' '}<span>{item.source === 'printed' ? 'printed' : 'owned'}</span>{communityMark(item.family)}</li>;
          })}</ul>
          {frozen.manifest.mountingSiteChecks.length > 0 && <p>Check before installing: {frozen.manifest.mountingSiteChecks.join(', ')}.</p>}</div>}
        <div className="export-receipts"><div className="export-receipts-title"><h3>All files</h3><button disabled={!!busy || !memberId} onClick={() => void reload().catch(error => setNotice(error instanceof Error ? error.message : 'Could not load your files.'))}>Reload</button></div>
          {currentFiles.map(fileCard)}{!currentFiles.length && <p>No files yet.</p>}
          {olderFiles.length > 0 && <details className="export-older"><summary>{olderFiles.length} older {olderFiles.length === 1 ? 'file set' : 'file sets'}</summary>{olderFiles.map(fileCard)}</details>}
        </div>
      </div></details>
    </aside>
  </section>;
}
