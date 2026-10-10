import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Member } from '../account/account';
import { validFurnitureType } from '../domain/furniture';
import type { MeshEnd } from '../domain/pieces/families/community';
import { ApiError } from '../net/api';
import {
  REASON_MAX, approveSubmission, correction, isRejected, label, listMine, powerLabel, quickLook, quickLookFile, rejectSubmission,
  removeItem, retireItem, reviewQueue, stateLabel, stlProblem, uploadsLeft, type Correction, type MySubmissions, type QuickLook, type ReviewQueue,
  type Submission, type SubmissionKind
} from './contribute';
import { EndsEditor } from './ends-editor';
import { meshFromStl, type MarkedEnds } from './ends';
import { PieceForm, TrainForm, message, useModel } from './forms';
import { FurnitureForm } from './furniture-form';
import { FurniturePreview } from './furniture-preview';
import { ModelViewer } from './viewer';
import './contribute.css';

const day = (at: string) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const KIND_LABELS: Record<SubmissionKind, string> = { piece: 'Piece', train: 'Train', furniture: 'Furniture' };
type Tab = SubmissionKind | 'mine';
const TABS: { id: Tab; title: string }[] = [
  { id: 'piece', title: 'Piece' }, { id: 'train', title: 'Train' }, { id: 'furniture', title: 'Furniture' }, { id: 'mine', title: 'Your uploads' }];

/** The full-page frame both contribute pages share: the app's top bar, then the page. */
function Page({ label: name, title, nav, actions, children }: { label: string; title: string; nav?: ReactNode; actions: ReactNode; children: ReactNode }) {
  return <div className="contribute-page" role="region" aria-label={name}>
    <header className="topbar contribute-page-bar">
      <div className="brand"><div className="brand-mark" aria-hidden="true"><span /><span /></div><span className="contribute-page-name">{title}</span></div>
      {nav ?? <span aria-hidden="true" />}
      <div className="top-actions">{actions}</div>
    </header>
    <div className="contribute-page-body">{children}</div>
  </div>;
}

function StateBadge({ submission }: { submission: Submission }) {
  const tone = isRejected(submission) || submission.state === 'removed' ? ' is-warn' :
    ['approved', 'pr_open', 'merged', 'live'].includes(submission.state) ? ' is-good' : '';
  return <em className={`contribute-badge${tone}`}>{stateLabel(submission.state)}</em>;
}

/** The contributor's uploads, newest first, each with its outcome; a rejected one says why and can be sent again corrected. */
function UploadList({ mine, onCorrect }: { mine: MySubmissions; onCorrect: (submission: Submission) => void }) {
  if (!mine.submissions.length) return <div className="gallery-empty"><h3>No uploads yet</h3>
    <p>Pieces, trains and furniture you send show here with what happened to each.</p></div>;
  return <ul className="contribute-uploads">{mine.submissions.map(item => <li key={item.id} className="contribute-upload">
    <div className="contribute-upload-head"><strong>{item.name}</strong><StateBadge submission={item} /></div>
    <span className="contribute-upload-meta">{KIND_LABELS[item.kind]} · sent {day(item.uploadedAt)} · {label(item.licence)}</span>
    {isRejected(item) && <>
      {item.reason && <p className="contribute-reason"><span>Reason:</span> {item.reason}</p>}
      <button type="button" className="quiet-button" onClick={() => onCorrect(item)}>Submit a corrected version</button>
    </>}
    {item.state === 'awaiting_look' && <p className="save-hint">Alex looks at every upload before it goes anywhere.</p>}
  </li>)}</ul>;
}

/**
 * Contributing to the community library (R17, R18): upload forms for a piece, a train and furniture, and the member's
 * uploads with each outcome. Nothing here touches the browser draft.
 */
export function ContributePage({ member, onNeedAccount, onClose, onNotice }: {
  member: Member | null; onNeedAccount: () => void; onClose: () => void; onNotice: (text: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('piece');
  const [mine, setMine] = useState<MySubmissions | null>(null);
  // Bumped after every upload try and when the binding cap frees up: the service owns the uploads left.
  const [loads, setLoads] = useState(0);
  const [error, setError] = useState('');
  const [fix, setFix] = useState<{ key: number; correction: Correction } | null>(null);
  const memberId = member?.id;
  useEffect(() => {
    if (!memberId) return;
    let active = true;
    listMine().then(list => { if (active) setMine(list); }, failure => { if (active) setError(message(failure, 'Could not load your uploads.')); });
    return () => { active = false; };
  }, [memberId, loads]);
  useEffect(() => {
    if (!mine || mine.left !== 0 || !mine.resetsAt) return;
    const timer = setTimeout(() => setLoads(count => count + 1), Math.max(0, Date.parse(mine.resetsAt) - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [mine]);
  const tried = () => setLoads(count => count + 1);
  const closed = mine?.left === 0 ? uploadsLeft(mine) : '';
  function sent(submission: Submission) {
    setFix(null);
    setMine(current => current && { ...current, submissions: [submission, ...current.submissions] });
    setTab('mine');
    onNotice(`Sent “${submission.name}” for review. You’ll see the outcome under Your uploads.`);
  }
  function correct(submission: Submission) {
    setFix({ key: Date.now(), correction: correction(submission) });
    setTab(submission.kind);
  }
  const prefill = <K extends Correction['kind']>(kind: K) => fix?.correction.kind === kind ? fix.correction as Extract<Correction, { kind: K }> : undefined;
  const piece = prefill('piece'), train = prefill('train'), furniture = prefill('furniture');
  const nav = <nav className="step-nav" role="tablist" aria-label="Contribute">{TABS.map(item => <button key={item.id} type="button" role="tab"
    aria-selected={tab === item.id} className={`step-pill${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}>{item.title}</button>)}</nav>;
  return <Page label="Contribute" title="Contribute to the library" nav={member?.verified ? nav : undefined} actions={<>
    {mine?.canReview && <a className="quiet-button" href="#review">Review uploads</a>}
    <button type="button" className="quiet-button" onClick={onClose}>Back to your layout</button>
  </>}>
    {!member ? <div className="gallery-empty"><h3>Sign in to contribute</h3>
      <p>Members can send printable pieces, train models and furniture presets for the community library.</p>
      <button type="button" className="primary-button" onClick={onNeedAccount}>Sign in or create an account</button></div> :
      !member.verified ? <div className="gallery-empty"><h3>Verify your email first</h3><p>Open the link in the email we sent you, then come back here.</p></div> :
      <div className="contribute-main">
        {tab !== 'mine' && <p className="contribute-intro">Each upload is checked automatically, then Alex looks at it. Approved uploads become a pull
          request on the public library repository, credited to {member.displayName}; merged ones join everyone’s palette.
          {mine && mine.left !== 0 && <> {uploadsLeft(mine)}</>}</p>}
        {error && <p className="account-error" role="alert">{error}</p>}
        {tab === 'piece' && <PieceForm key={`piece-${fix?.key ?? 0}`} initial={piece && { name: piece.name, ends: piece.ends }}
          onSubmitted={sent} closed={closed} onTried={tried} />}
        {tab === 'train' && <TrainForm key={`train-${fix?.key ?? 0}`} initial={train?.draft} onSubmitted={sent} closed={closed} onTried={tried} />}
        {tab === 'furniture' && <FurnitureForm key={`furniture-${fix?.key ?? 0}`} initial={furniture && { name: furniture.name, design: furniture.design }}
          onSubmitted={sent} closed={closed} onTried={tried} />}
        {tab === 'mine' && (mine ? <UploadList mine={mine} onCorrect={correct} /> : !error && <p className="gallery-loading" role="status">Loading your uploads…</p>)}
      </div>}
  </Page>;
}

const NOWHERE = 'There is nothing here.';
const itemId = (look: QuickLook) => String(look.metadata.id);

/** Alex's queue: uploads waiting for the quick look, oldest first, then the latest decisions. Anyone else finds nothing. */
export function ReviewPage({ onClose }: { onClose: () => void }) {
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    reviewQueue().then(result => { if (active) setQueue(result); },
      failure => { if (active) setError(failure instanceof ApiError && failure.status === 404 ? NOWHERE : message(failure, 'Could not load the uploads.')); });
    return () => { active = false; };
  }, []);
  const row = (item: Submission) => <li key={item.id}><a className="contribute-upload contribute-upload-link" href={`#review=${item.id}`}>
    <span className="contribute-upload-head"><strong>{item.name}</strong><StateBadge submission={item} /></span>
    <span className="contribute-upload-meta">{KIND_LABELS[item.kind]} by {item.author} · sent {day(item.uploadedAt)} · {label(item.licence)}</span>
    {item.reason && <span className="contribute-reason">{item.reason}</span>}
  </a></li>;
  return <Page label="Review uploads" title="Review uploads" actions={<>
    <a className="quiet-button" href="#contribute">Contribute</a>
    <button type="button" className="quiet-button" onClick={onClose}>Back to your layout</button></>}>
    <div className="contribute-main">
      {error && <div className="gallery-page-missing"><p>{error}</p></div>}
      {!queue && !error && <p className="gallery-loading" role="status">Loading uploads…</p>}
      {queue && <>
        <h3 className="contribute-heading">Waiting for a look ({queue.waiting.length})</h3>
        {queue.waiting.length ? <ul className="contribute-uploads">{queue.waiting.map(row)}</ul> : <p className="save-hint">Nothing waiting.</p>}
        {queue.reviewed.length > 0 && <><h3 className="contribute-heading">Recently reviewed</h3><ul className="contribute-uploads">{queue.reviewed.map(row)}</ul></>}
      </>}
    </div>
  </Page>;
}

/** The uploaded file as the library would get it: the piece with its marked ends, the train model, the furniture preset. */
function LookView({ look, bytes }: { look: QuickLook; bytes: ArrayBuffer | null }) {
  const model = useModel(look.kind === 'train' ? bytes : null);
  const shown = useMemo(() => {
    if (!bytes) return null;
    if (look.kind === 'piece') {
      if (stlProblem(bytes)) return 'The file is not a binary STL.';
      const ends = Array.isArray(look.metadata.ends) ? look.metadata.ends as MeshEnd[] : [];
      return { kind: 'piece' as const, mesh: meshFromStl(bytes), ends: [ends[0] ?? null, ends[1] ?? null] as MarkedEnds };
    }
    if (look.kind === 'furniture') {
      try {
        const type: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return validFurnitureType(type) ? { kind: 'furniture' as const, type } : 'The file is not a furniture type.';
      } catch { return 'The file is not JSON.'; }
    }
    return null;
  }, [look, bytes]);
  if (!look.file) return <div className="gallery-page-missing"><p>{['live', 'retired', 'removed'].includes(look.state) ?
    'Published uploads live in the library and its repository, not here.' : 'The file is gone: rejected and withdrawn uploads are not kept.'}</p></div>;
  if (!bytes) return <p className="gallery-loading" role="status">Loading the file…</p>;
  if (typeof shown === 'string') return <p className="account-error" role="alert">{shown}</p>;
  if (look.kind === 'train') return <ModelViewer object={model} label="The uploaded train model in 3D" />;
  if (shown?.kind === 'piece') return <EndsEditor mesh={shown.mesh} ends={shown.ends} />;
  if (shown?.kind === 'furniture') return <FurniturePreview type={shown.type} />;
  return null;
}

function Facts({ look }: { look: QuickLook }) {
  const meta = look.metadata, car = typeof meta.car === 'object' && meta.car ? meta.car as Record<string, unknown> : null;
  const source = typeof meta.source === 'object' && meta.source ? meta.source as { url?: string; authors?: string[] } : null;
  return <dl className="contribute-facts-list">
    <dt>Library id</dt><dd>{String(meta.id ?? '')}</dd>
    <dt>By</dt><dd>{look.author}</dd>
    <dt>Licence</dt><dd>{label(look.licence)}</dd>
    {source && <><dt>Adapted from</dt><dd><a href={source.url} target="_blank" rel="noopener noreferrer">{source.url}</a> by {source.authors?.join(', ')}</dd></>}
    {car && <><dt>Car</dt><dd>{String(car.kind)}{car.motorised ? ', motorised' : ''} · {String(car.length)} × {String(car.width)} × {String(car.height)} mm ·
      {' '}{String(car.triangles)} triangles</dd></>}
    {typeof meta.year === 'number' && <><dt>Set</dt><dd>{meta.year} · {powerLabel(meta.power)} · {String(meta.gauge)}</dd></>}
    <dt>Sent</dt><dd>{day(look.uploadedAt)}</dd>
    {look.file && <><dt>File</dt><dd>{look.file.name} · {(look.file.bytes / 1000).toLocaleString('en-GB', { maximumFractionDigits: 0 })} KB</dd></>}
  </dl>;
}

/** Alex's quick look at one upload (R18): the file in 3D and its metadata, then Approve, or Reject with a reason the
 * contributor sees. Approving hands it to the GitHub bot; rejecting keeps it out of GitHub. While its pull request is
 * open, rejecting has the bot close it with the reason; once it is in the library, Alex can retire or remove it (KTD9). */
export function QuickLookPage({ id, onClose, onNotice }: { id: string; onClose: () => void; onNotice: (text: string) => void }) {
  const [look, setLook] = useState<QuickLook | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    let active = true;
    setLook(null); setBytes(null); setError(''); setConfirmRemove(false);
    quickLook(id).then(async result => {
      if (!active) return;
      setLook(result);
      if (result.file) { const data = await quickLookFile(id); if (active) setBytes(data); }
    }).catch(failure => { if (active) setError(failure instanceof ApiError && failure.status === 404 ? NOWHERE : message(failure, 'Could not open the upload.')); });
    return () => { active = false; };
  }, [id]);
  async function decide(work: () => Promise<Pick<Submission, 'state'> & Partial<Submission>>, done: string) {
    setBusy(true); setError('');
    try { const next = await work(); setLook(current => current && { ...current, ...next, file: next.state === 'rejected' ? null : current.file }); onNotice(done); }
    catch (failure) { setError(message(failure, 'Could not save the decision.')); }
    finally { setBusy(false); }
  }
  return <Page label="Quick look" title={look ? `Quick look: ${look.name}` : 'Quick look'} actions={<>
    <a className="quiet-button" href="#review">← Uploads</a>
    <button type="button" className="quiet-button" onClick={onClose}>Back to your layout</button></>}>
    {!look && !error && <p className="gallery-loading" role="status">Opening the upload…</p>}
    {!look && error && <div className="gallery-page-missing"><p>{error}</p></div>}
    {look && <div className="contribute-look">
      <div className="contribute-look-view"><LookView look={look} bytes={bytes} /></div>
      <aside className="contribute-look-info">
        <h2>{look.name}</h2>
        <p><span className="contribute-kind">{KIND_LABELS[look.kind]}</span> <StateBadge submission={look} /></p>
        {look.reason && <p className="contribute-reason"><span>Reason:</span> {look.reason}</p>}
        <Facts look={look} />
        {error && <p className="account-error" role="alert">{error}</p>}
        {look.state === 'awaiting_look' && <form className="contribute-decide" onSubmit={event => {
          event.preventDefault();
          if (reason.trim()) void decide(() => rejectSubmission(look.id, reason.trim()), 'Rejected. The contributor sees your reason.');
        }}>
          <button type="button" className="primary-button" disabled={busy}
            onClick={() => void decide(() => approveSubmission(look.id), 'Approved. The library bot opens its pull request.')}>Approve</button>
          <label className="save-name">Reason to reject<textarea className="gallery-textarea" rows={3} value={reason} maxLength={REASON_MAX}
            placeholder="What the contributor should fix" onChange={event => setReason(event.target.value)} /></label>
          <button type="submit" className="quiet-button gallery-danger" disabled={busy || !reason.trim()}>Reject</button>
          <p className="save-hint">Approving makes it a public pull request with the contributor’s display name, permanently. A rejected upload never
            leaves Plateway, and its file is deleted.</p>
        </form>}
        {look.state === 'pr_open' && <form className="contribute-decide" onSubmit={event => {
          event.preventDefault();
          if (reason.trim()) void decide(() => rejectSubmission(look.id, reason.trim()), 'The library bot closes the pull request with your reason.');
        }}>
          <label className="save-name">Reason to reject<textarea className="gallery-textarea" rows={3} value={reason} maxLength={REASON_MAX}
            placeholder="What the contributor should fix" onChange={event => setReason(event.target.value)} /></label>
          <button type="submit" className="quiet-button gallery-danger" disabled={busy || !reason.trim()}>Close the pull request</button>
          <p className="save-hint">The bot posts your reason on the pull request and closes it; the contributor sees it next to “Rejected”. Merging it on
            GitHub publishes it instead.</p>
        </form>}
        {(look.state === 'live' || look.state === 'retired') && <div className="contribute-decide">
          {look.state === 'live' && <button type="button" className="quiet-button" disabled={busy}
            onClick={() => void decide(async () => ({ state: (await retireItem(itemId(look))).state }), 'Retired. Layouts that use it keep it.')}>Retire</button>}
          {confirmRemove ?
            <button type="button" className="quiet-button gallery-danger" disabled={busy}
              onClick={() => void decide(async () => ({ state: (await removeItem(itemId(look))).state }), 'Removed. The bot deletes it from the repository too.')}>Remove its files everywhere</button> :
            <button type="button" className="quiet-button gallery-danger" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove…</button>}
          <p className="save-hint">Retiring takes it out of the palette, and layouts that use it keep it. Removing is for takedowns: its files leave the library
            and the repository’s current tree, and layouts that use it show a placeholder.</p>
        </div>}
      </aside>
    </div>}
  </Page>;
}

